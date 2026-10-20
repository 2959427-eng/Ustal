import OpenAI from "openai";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("dotenv", () => ({ config: vi.fn() }));
const meta = { operationType: "fixture", traceId: "fixture", promptVersion: "fixture", schemaVersion: "fixture" };
let calls: { url: string; headers: Headers; body: unknown }[];
let api: typeof import("./index.js");
const endpointA = "https://a.invalid/v1", endpointB = "https://b.invalid/v1";
beforeEach(async () => {
  vi.resetModules(); calls = [];
  for (const [key, value] of Object.entries({ DATABASE_URL: "postgres://fixture:fixture@localhost/fixture_test",
    JWT_ACCESS_SECRET: "fixture-access-01234567890123456789", JWT_REFRESH_SECRET: "fixture-refresh-01234567890123456789",
    AI_PROVIDER: "openai", OPENAI_API_KEY: "fixture-key-A", OPENAI_BASE_URL: endpointA,
    OPENAI_ORG_ID: "org-A", OPENAI_PROJECT_ID: "project-A", OPENAI_CUSTOM_HEADERS: "X-Route:a\nOpenAI-Organization:custom-org-A" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    const body = url.includes("/embeddings") ? { data: [{ index: 0, embedding: Buffer.from(new Float32Array([1, 2]).buffer).toString("base64") }], usage: {} }
      : url.includes("/models") ? { data: [] } : { choices: [{ message: { content: JSON.stringify({ involves: false, reason: "fixture" }) } }] };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }));
  api = await import("./index.js");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const embed = () => api.openAiProviders.embedding.embed(["synthetic fixture"], meta);

it("cached provider client A stays the descriptor source after env B; first creation B describes wire B", async () => {
  await embed(); const before = await api.currentOpenAiRecipientConfiguration();
  vi.stubEnv("OPENAI_BASE_URL", endpointB); vi.stubEnv("OPENAI_ORG_ID", "org-B"); vi.stubEnv("OPENAI_PROJECT_ID", "project-B");
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", "X-Route:b"); vi.stubEnv("OPENAI_API_KEY", "fixture-key-B");
  await embed(); const after = await api.currentOpenAiRecipientConfiguration();
  expect(calls[1]!.url).toContain(endpointA); expect(calls[1]!.headers.get("x-route")).toBe("a");
  expect(calls[1]!.headers.get("openai-organization")).toBe("custom-org-A"); expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toMatch(/fixture-key|custom-org|project-A|X-Route/);
  vi.resetModules(); api = await import("./index.js");
  await embed(); const fresh = await api.currentOpenAiRecipientConfiguration();
  expect(calls[2]!.url).toContain(endpointB); expect(calls[2]!.headers.get("x-route")).toBe("b");
  expect(fresh.endpoint).toBe(endpointB); expect(fresh.recipientBinding).not.toBe(before.recipientBinding);
});
it("unsetting env headers does not remove cached SDK routing; credentials never escape descriptor", async () => {
  await embed(); const before = await api.currentOpenAiRecipientConfiguration();
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", ""); vi.stubEnv("OPENAI_ORG_ID", ""); vi.stubEnv("OPENAI_PROJECT_ID", "");
  await embed(); expect(calls[1]!.headers.get("x-route")).toBe("a");
  expect(await api.currentOpenAiRecipientConfiguration()).toEqual(before);
});
it("model identity follows actual per-operation selection, while fixed STT/embedding literals stay fixed", async () => {
  await embed(); const before = await api.currentOpenAiRecipientConfiguration();
  vi.stubEnv("AI_MODEL_EMBEDDING", "unused-fixture-model"); vi.stubEnv("AI_MODEL_STT", "unused-fixture-stt");
  expect(await api.currentOpenAiRecipientConfiguration()).toEqual(before);
  vi.stubEnv("AI_MODEL_SEMANTIC_REVIEW", "fixture-review-B");
  await api.openAiProviders.extraction.checkRefusal({ refusal: "не вожу такси", order: ["fixture"] }, meta);
  expect((calls.at(-1)!.body as any).model).toBe("fixture-review-B");
  expect((await api.currentOpenAiRecipientConfiguration()).recipientBinding).not.toBe(before.recipientBinding);
});
it("SDK-effective null/unset/case headers, not a fresh env approximation, define client binding", async () => {
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", "");
  const binding = await import("./recipient-binding.js");
  const models = { review: "fixture" };
  const make = (headers: Record<string, string | null>, organization: string | null = "shadow-org", key = "fixture-key") => new OpenAI({
    apiKey: key, organization, project: null, baseURL: endpointA, defaultHeaders: headers, fetch: globalThis.fetch,
  });
  const a = make({ "OpenAI-Organization": null, "X-Route": "a", "x-route": "b" });
  const b = make({ "x-route": "b" }, null);
  await a.models.list(); await b.models.list();
  expect(calls[0]!.headers.get("openai-organization")).toBeNull();
  expect(calls[0]!.headers.get("x-route")).toBe(calls[1]!.headers.get("x-route"));
  expect(await binding.deriveOpenAiRecipientConfigurationFromClient(a, models)).toEqual(await binding.deriveOpenAiRecipientConfigurationFromClient(b, models));
  const credentialA = make({ "x-route": "b", Authorization: "Bearer fixture-A", "X-API-Key": "fixture-A" }, null, "fixture-key-A");
  const credentialB = make({ "x-route": "b", Authorization: "Bearer fixture-B", "X-API-Key": "fixture-B" }, null, "fixture-key-B");
  expect(await binding.deriveOpenAiRecipientConfigurationFromClient(credentialA, models))
    .toEqual(await binding.deriveOpenAiRecipientConfigurationFromClient(credentialB, models));
});
