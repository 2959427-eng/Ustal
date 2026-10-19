import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { collectReviewSources, fingerprintReviewPipeline, normalizeSourcePath, sdkClientIdentity, sdkEffectiveCustomHeaders, sourceRelativePath, type ReviewPipelineDescriptorInput } from "./review-fingerprint.js";

// Fix of cache-key completeness (2026-10-15): the review cache key carries this fingerprint of the real pipeline.
const root = fileURLToPath(new URL("./providers/openai.ts", import.meta.url));
const closure = collectReviewSources(root);
const sources = closure.files.map((f) => ({ path: f, content: readFileSync(f, "utf8") }));
const base: ReviewPipelineDescriptorInput = {
  reviewType: "semantic_pair_review", provider: "openai", endpoint: "https://relay.example/v1",
  models: { semanticReview: "gpt-4.1-mini", extraction: "gpt-4o-mini" }, params: { requestTimeoutMs: 45000, maxRetries: 1 },
  sources, packages: closure.packages,
};
const fp = (patch: Partial<ReviewPipelineDescriptorInput> = {}) => fingerprintReviewPipeline({ ...base, ...patch });
/** The same pipeline with one literal fragment of one real source file edited. */
function edited(fileSuffix: string, fragment: string, replacement = `${fragment} (edited)`) {
  const target = sources.find((s) => normalizeSourcePath(s.path).endsWith(fileSuffix));
  if (!target) throw new Error(`no ${fileSuffix} in closure`);
  expect(target.content).toContain(fragment); // guards the test itself: the fragment really is in the pipeline
  return fp({ sources: sources.map((s) => (s === target ? { ...s, content: s.content.replace(fragment, replacement) } : s)) });
}

describe("review pipeline fingerprint", () => {
  it("the closure contains the provider, schemas, validation and post-processing modules", () => {
    const names = closure.files.map(normalizeSourcePath);
    for (const suffix of ["packages/ai/src/providers/openai.ts", "packages/ai/src/review-constraints.ts", "packages/ai/src/evidence-validation.ts",
      "packages/ai/src/source-evidence.ts", "packages/ai/src/consent-dispatch.ts", "packages/validation/src/semantic.ts", "packages/config/src/env.ts"])
      expect(names.some((n) => n.endsWith(suffix))).toBe(true);
    expect(Object.keys(closure.packages)).toEqual(expect.arrayContaining(["openai", "zod", "zod-to-json-schema"]));
  });
  it("6: identical pipeline -> identical fingerprint (CRLF/LF and source order do not matter)", () => {
    expect(fp()).toBe(fp());
    expect(fp({ sources: [...sources].reverse().map((s) => ({ ...s, content: s.content.replace(/\r?\n/g, "\r\n") })) })).toBe(fp());
  });
  it("1: main review prompt changed -> miss", () => {
    expect(edited("providers/openai.ts", "Assess service-opportunity relevance under USTAL's recall-first policy.")).not.toBe(fp());
  });
  it("central dispatch guard and public-boundary changes automatically change fingerprint", () => {
    expect(edited("consent-dispatch.ts", "if (state?.denial) throw state.denial;")).not.toBe(fp());
    expect(edited("providers/openai.ts", "fetch: consentGuardedOpenAiFetch,")).not.toBe(fp());
  });
  it("2: nested verifier prompts changed (main-result, scope, refusal, action) -> miss", () => {
    expect(edited("providers/openai.ts", "Classify evidence specificity, NOT a claim of inability or exclusivity.")).not.toBe(fp());
    expect(edited("providers/openai.ts", "Check the quoted exclusive boundary against the ORDER.")).not.toBe(fp());
    expect(edited("providers/openai.ts", "You check ONE thing.")).not.toBe(fp());
    expect(edited("providers/openai.ts", "Does it state a CONCRETE positive operative action")).not.toBe(fp());
  });
  it("3: response schema, evidence validation or post-processing changed -> miss", () => {
    expect(edited("providers/openai.ts", 'schemaName: "semantic_review_v1"', 'schemaName: "semantic_review_v2"')).not.toBe(fp());
    expect(edited("validation/src/semantic.ts", "export const semanticReviewSchema")).not.toBe(fp());
    expect(edited("ai/src/evidence-validation.ts", "export function assertGroundedEvidence")).not.toBe(fp());
    expect(edited("ai/src/review-constraints.ts", "export function applyReviewConstraints")).not.toBe(fp());
    expect(fp({ packages: { ...closure.packages, zod: "0.0.0" } })).not.toBe(fp());
  });
  it("4: model parameters changed -> miss", () => {
    expect(edited("providers/openai.ts", "temperature: 0,", "temperature: 0.2,")).not.toBe(fp());
    expect(fp({ models: { ...base.models, semanticReview: "gpt-4.1" } })).not.toBe(fp());
    expect(fp({ params: { ...base.params, maxRetries: 2 } })).not.toBe(fp());
  });
  it("5: endpoint/provider identity changed -> miss", () => {
    expect(fp({ endpoint: "https://other-relay.example/v1" })).not.toBe(fp());
    expect(fp({ provider: "mock" })).not.toBe(fp());
  });
  it("restriction review has its own fingerprint and follows the same rules", () => {
    const refusal = (patch: Partial<ReviewPipelineDescriptorInput> = {}) => fp({ reviewType: "general_access_refusal_check", ...patch });
    expect(refusal()).not.toBe(fp());
    expect(refusal()).toBe(refusal());
    expect(refusal({ endpoint: "https://other-relay.example/v1" })).not.toBe(refusal());
    expect(refusal({ models: { ...base.models, semanticReview: "gpt-4.1" } })).not.toBe(refusal());
  });
  it("A-E: OpenAI SDK client identity (project, org, custom headers, key) is part of the fingerprint, as digests only", () => {
    const env = { OPENAI_PROJECT_ID: "proj_A", OPENAI_ORG_ID: "org_A", OPENAI_CUSTOM_HEADERS: "X-Team: alpha\nX-Route: eu", OPENAI_API_KEY: "relay-token-123" };
    const withEnv = (patch: Record<string, string | undefined>) => fp({ client: sdkClientIdentity({ ...env, ...patch }) });
    const same = withEnv({});
    expect(withEnv({ OPENAI_PROJECT_ID: "proj_B" })).not.toBe(same); // A
    expect(withEnv({ OPENAI_ORG_ID: "org_B" })).not.toBe(same); // B
    expect(withEnv({ OPENAI_CUSTOM_HEADERS: "X-Team: beta\nX-Route: eu" })).not.toBe(same); // C: different value
    expect(withEnv({ OPENAI_CUSTOM_HEADERS: "X-Team: alpha" })).not.toBe(same); // C: header removed
    expect(withEnv({ OPENAI_CUSTOM_HEADERS: "X-Route: eu\nx-team: alpha" })).toBe(same); // D: other order / name case
    expect(withEnv({ OPENAI_CUSTOM_HEADERS: " X-Team:alpha \n X-Route : eu " })).toBe(same); // D: SDK trims like this
    expect(withEnv({})).toBe(same); // E: stable
    expect(withEnv({ OPENAI_PROJECT_ID: undefined })).not.toBe(same);
    expect(withEnv({ OPENAI_PROJECT_ID: "  " })).toBe(withEnv({ OPENAI_PROJECT_ID: undefined })); // SDK: empty = absent
    expect(withEnv({ OPENAI_API_KEY: "relay-token-456" })).not.toBe(same);
    // No plaintext leaves the identity (it is held in memory and hashed into the fingerprint).
    const identity = JSON.stringify(sdkClientIdentity(env));
    for (const secret of ["proj_A", "org_A", "alpha", "eu", "relay-token-123"]) expect(identity).not.toContain(secret);
  });
  it("paths are platform independent: Windows separators/drive letters and POSIX give the same fingerprint", () => {
    expect(sourceRelativePath("C:\\Users\\dev\\ustal", "C:\\Users\\dev\\ustal\\packages\\ai\\src\\providers\\openai.ts")).toBe("packages/ai/src/providers/openai.ts");
    expect(sourceRelativePath("/home/dev/ustal", "/home/dev/ustal/packages/ai/src/providers/openai.ts")).toBe("packages/ai/src/providers/openai.ts");
    expect(normalizeSourcePath("C:\\repo\\packages\\ai\\x.ts")).toBe("/repo/packages/ai/x.ts");
    expect(normalizeSourcePath("/repo/packages/ai/x.ts")).toBe("/repo/packages/ai/x.ts");
    const posixSources = sources.map((s, i) => ({ path: `packages/f${i}.ts`, content: s.content }));
    const windowsSources = sources.map((s, i) => ({ path: `packages\\f${i}.ts`, content: s.content.replace(/\r?\n/g, "\r\n") }));
    expect(fp({ sources: windowsSources })).toBe(fp({ sources: posixSources }));
    expect(fp({ sources: posixSources.map((s, i) => (i === 0 ? { ...s, content: s.content + " " } : s)) })).not.toBe(fp({ sources: posixSources }));
  });
  // ---- OPENAI_CUSTOM_HEADERS: effective SDK headers, not our own merge semantics (Codex FAIL 2026-10-16) ----
  const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
  const headersFp = (raw: string | undefined) => fp({ client: sdkClientIdentity({ OPENAI_CUSTOM_HEADERS: raw }) });
  /** What the installed SDK really puts on the wire: a real request with an offline fetch. */
  async function sentCustomHeaders(raw: string | undefined): Promise<[string, string][]> {
    const saved = process.env.OPENAI_CUSTOM_HEADERS;
    if (raw === undefined) delete process.env.OPENAI_CUSTOM_HEADERS; else process.env.OPENAI_CUSTOM_HEADERS = raw;
    let sent = new Headers();
    try {
      const client = new OpenAI({ apiKey: "test", baseURL: "http://127.0.0.1/v1", maxRetries: 0, organization: null, project: null,
        fetch: (async (_url: unknown, init?: { headers?: ConstructorParameters<typeof Headers>[0] }) => { sent = new Headers(init?.headers);
          return new Response('{"object":"list","data":[]}', { status: 200, headers: { "content-type": "application/json" } }); }) as never });
      await client.models.list();
    } finally { if (saved === undefined) delete process.env.OPENAI_CUSTOM_HEADERS; else process.env.OPENAI_CUSTOM_HEADERS = saved; }
    return [...sent.entries()].filter(([name]) => name.startsWith("x-") && !name.startsWith("x-stainless"));
  }

  it("A (Codex case): `X-Route:a / x-route:b / X-Route:c` vs `x-route:c` -> SDK sends b vs c -> different fingerprints", async () => {
    const a = "X-Route:a\nx-route:b\nX-Route:c", b = "x-route:c";
    expect(await sentCustomHeaders(a)).toEqual([["x-route", "b"]]);
    expect(await sentCustomHeaders(b)).toEqual([["x-route", "c"]]);
    expect(headersFp(a)).not.toBe(headersFp(b));
  });
  it("B: the same effective headers from different spelling/case/whitespace -> the same fingerprint", () => {
    expect(headersFp("X-Route: c ")).toBe(headersFp("x-route:c"));
    expect(headersFp("  X-ROUTE :c")).toBe(headersFp("x-route:c"));
    expect(headersFp("x-route:a\nx-route:c")).toBe(headersFp("x-route:c")); // exact-case duplicate: overwritten
  });
  it("C: duplicate names follow the SDK precedence (exact-case overwrite in place, then key order by lower-cased name)", () => {
    expect(sdkEffectiveCustomHeaders("x-route:a\nx-route:b")).toEqual([["x-route", "b"]]);
    expect(sdkEffectiveCustomHeaders("X-Route:a\nx-route:b\nX-Route:c")).toEqual([["x-route", "b"]]);
    expect(sdkEffectiveCustomHeaders("x-route:b\nX-Route:c")).toEqual([["x-route", "c"]]);
  });
  it("D: line orders the SDK treats as equivalent -> the same fingerprint", () => {
    expect(headersFp("X-A:1\nX-B:2")).toBe(headersFp("X-B:2\nX-A:1"));
    expect(headersFp("X-A:1\nnot a header line\nX-B:2")).toBe(headersFp("X-B:2\nX-A:1")); // lines without ':' are ignored
  });
  it("E: order/duplicates that change the SDK request -> different fingerprints", () => {
    expect(headersFp("x-route:b\nX-Route:c")).not.toBe(headersFp("X-Route:c\nx-route:b"));
    expect(headersFp("X-A:1")).not.toBe(headersFp("X-A:"));
    expect(headersFp("X-A:1\nX-B:2")).not.toBe(headersFp("X-A:1"));
  });
  it("F: empty or absent custom headers -> one stable identity", () => {
    const none = headersFp(undefined);
    for (const raw of ["", "   ", "\n", "no colon here"]) expect(headersFp(raw)).toBe(none);
    expect(headersFp(undefined)).toBe(none);
    expect(sdkEffectiveCustomHeaders(undefined)).toBeNull();
  });
  it("G: several header names -> canonical stable identity, digests only", () => {
    const identity = sdkClientIdentity({ OPENAI_CUSTOM_HEADERS: "X-Team: alpha\nX-Route: eu\nX-Trace: 7" });
    expect(identity.customHeaders).toEqual([["x-route", sha256("eu")], ["x-team", sha256("alpha")], ["x-trace", sha256("7")]]);
    expect(JSON.stringify(identity)).not.toMatch(/alpha|"eu"|"7"/);
    expect(headersFp("X-Trace: 7\nX-Route: eu\nX-Team: alpha")).toBe(headersFp("X-Team: alpha\nX-Route: eu\nX-Trace: 7"));
  });
  it("differential: our canonical headers equal what the installed SDK actually sends", async () => {
    const samples = [undefined, "", "x-route:c", "X-Route:a\nx-route:b\nX-Route:c", "x-route:b\nX-Route:c", "X-Route: c ", "X-A:1\nX-B:2",
      "X-B:2\nX-A:1", "X-A:", "no colon", "X-A:1\nx-a:2\nX-B:3\nX-A:4", "X-Value: a:b:c", "\tX-Tab:\tv\t", "X-A:1\r\nX-B:2"];
    for (const raw of samples) {
      const sent = await sentCustomHeaders(raw);
      const ours = sdkEffectiveCustomHeaders(raw) ?? [];
      expect(ours, JSON.stringify(raw)).toEqual(sent);
      expect(sdkClientIdentity({ OPENAI_CUSTOM_HEADERS: raw }).customHeaders ?? []).toEqual(sent.map(([n, v]) => [n, sha256(v)]));
    }
    // An invalid header name breaks every real client: fingerprinted as a whole, distinct from "no headers".
    await expect(sentCustomHeaders("Bad Name:1")).rejects.toThrow(/Header name/);
    expect(headersFp("Bad Name:1")).not.toBe(headersFp(undefined));
  });
});
