import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { deriveOpenAiRecipientConfiguration } from "./recipient-binding.js";
import { sdkClientIdentity } from "./review-fingerprint.js";
vi.mock("dotenv", () => ({ config: vi.fn() }));
const models = { review: "fixture-model" };
const derive = (env: Record<string, string | undefined> = {}, endpoint = "https://example.invalid/v1", selected = models) => deriveOpenAiRecipientConfiguration({ env, endpoint, models: selected });
describe("recipient identity, not legal approval or cache identity", () => {
  it("normalizes URL host/default port/trailing separator but preserves URL path/case/escapes", () => {
    expect(derive({}, "https://EXAMPLE.invalid:443/v1/")).toEqual(derive());
    for (const value of ["https://example.invalid/V1", "https://example.invalid/v1//", "https://example.invalid/v1%2Fextra"])
      expect(derive({}, value).recipientBinding).not.toBe(derive().recipientBinding);
    for (const value of ["C:\\site\\v1", "/site/v1", "https://u:secret@example.invalid/v1", "https://example.invalid/v1?key=secret", "https://example.invalid/v1#fragment"])
      expect(() => derive({}, value)).toThrow("Invalid public recipient endpoint");
  });
  it("excludes ordinary credential rotation but routing/model/org/project changes fail closed", () => {
    const a = { OPENAI_API_KEY: "fixture-secret-A", OPENAI_CUSTOM_HEADERS: "Authorization: Bearer fixture-A\nX-API-Key: fixture-A\nX-Route: eu" };
    const b = { OPENAI_API_KEY: "fixture-secret-B", OPENAI_CUSTOM_HEADERS: "Authorization: Bearer fixture-B\nX-API-Key: fixture-B\nX-Route: eu" };
    expect(derive(a)).toEqual(derive(b)); expect(sdkClientIdentity(a)).not.toEqual(sdkClientIdentity(b));
    for (const env of [{ OPENAI_ORG_ID: "org-other" }, { OPENAI_PROJECT_ID: "project-other" }, { OPENAI_CUSTOM_HEADERS: "X-Unknown: route" }])
      expect(derive(env).recipientBinding).not.toBe(derive().recipientBinding);
    expect(derive({}, undefined, { review: "other" }).recipientBinding).not.toBe(derive().recipientBinding);
    expect(JSON.stringify(derive(a))).not.toMatch(/fixture-secret|fixture-A|Bearer|"eu"/);
  });
  it("uses SDK precedence including organization overrides and case duplicates", async () => {
    const samples = ["X-Route:a\nx-route:b\nX-Route:c", "x-route:b\nX-Route:c", "OpenAI-Organization: effective-org\nX-Route: eu"];
    const saved = process.env.OPENAI_CUSTOM_HEADERS;
    try {
      for (const raw of samples) {
        process.env.OPENAI_CUSTOM_HEADERS = raw;
        let sent = new Headers();
        const client = new OpenAI({ apiKey: "fixture", organization: "shadow-org", project: "project", baseURL: "https://example.invalid/v1", maxRetries: 0,
          fetch: async (_input, init) => { sent = new Headers(init?.headers); return new Response('{"data":[]}', { headers: { "content-type": "application/json" } }); } });
        await client.models.list();
        const names = new Set(raw.split("\n").map(line => line.slice(0, line.indexOf(":")).toLowerCase()));
        const effectiveRaw = [...sent].filter(([name]) => names.has(name)).map(([name, value]) => `${name}:${value}`).join("\n");
        expect(derive({ OPENAI_ORG_ID: "shadow-org", OPENAI_PROJECT_ID: "project", OPENAI_CUSTOM_HEADERS: raw }))
          .toEqual(derive({ OPENAI_ORG_ID: sent.get("openai-organization") ?? undefined, OPENAI_PROJECT_ID: sent.get("openai-project") ?? undefined, OPENAI_CUSTOM_HEADERS: effectiveRaw }));
      }
    } finally { if (saved === undefined) delete process.env.OPENAI_CUSTOM_HEADERS; else process.env.OPENAI_CUSTOM_HEADERS = saved; }
    expect(derive({ OPENAI_CUSTOM_HEADERS: "X-Route: c " })).toEqual(derive({ OPENAI_CUSTOM_HEADERS: "x-route:c" }));
  });
});
