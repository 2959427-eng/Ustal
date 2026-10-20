import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
vi.mock("dotenv", () => ({ config: vi.fn() }));
const actor = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const context = { subjectUserIds: [actor], purpose: "ai-processing", operation: "test", traceId: "fixture" };
const publication = { approved: true as const, policyId: "33333333-3333-4333-8333-333333333333", policyHash: "a".repeat(64),
  purpose: "ai-processing", provider: "openai", endpoint: "https://fixture.invalid/v1", recipientBinding: "b".repeat(64) };
const meta = { operationType: "test", traceId: "fixture", promptVersion: "test", schemaVersion: "test" };
// Actual SDK requests base64 by default, then decodes Float32 values itself.
const embeddingResponse = () => new Response(JSON.stringify({ data: [{ embedding: Buffer.from(new Float32Array([1, 2]).buffer).toString("base64") }], usage: { prompt_tokens: 1, total_tokens: 1 } }), { headers: { "content-type": "application/json" } });
let transport: ReturnType<typeof vi.fn>;
const actualFetch = globalThis.fetch.bind(globalThis);
let guard: typeof import("./consent-dispatch.js");
let providers: typeof import("./providers/openai.js");
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@localhost:5432/fixture_test");
  vi.stubEnv("JWT_ACCESS_SECRET", "test-access-secret-not-real-0123456789");
  vi.stubEnv("JWT_REFRESH_SECRET", "test-refresh-secret-not-real-0123456789");
  vi.stubEnv("OPENAI_API_KEY", "fixture-not-a-real-key");
  vi.stubEnv("OPENAI_BASE_URL", publication.endpoint);
  vi.stubEnv("AI_PROVIDER", "openai"); vi.stubEnv("AI_MAX_RETRIES", "1");
  transport = vi.fn().mockImplementation(embeddingResponse); vi.stubGlobal("fetch", transport);
  guard = await import("./consent-dispatch.js"); providers = await import("./providers/openai.js");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const embed = () => providers.openAiEmbedding.embed(["PRIVATE SOURCE"], meta);

describe("central consent dispatcher, actual SDK with fake network only", () => {
  it("inherited enforced configuration cannot bypass missing CLI bootstrap", async () => {
    vi.stubEnv("USTAL_AI_CONSENT_MODE", "enforced");
    await expect(embed()).rejects.toBeInstanceOf(guard.AiConsentDenied);
    expect(transport).not.toHaveBeenCalled();
  });
  it("resolves current publication for every dispatch instead of trusting an old bootstrap version", async () => {
    let current=publication;
    guard.configureConsentDispatch({mode:"enforced",resolvePublication:async()=>current,authorize:async input=>input.publication.policyHash===publication.policyHash});
    await guard.withAiConsentContext(context,embed);
    current={...publication,policyHash:"c".repeat(64)};
    await expect(guard.withAiConsentContext(context,embed)).rejects.toBeInstanceOf(guard.AiConsentDenied);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("typed epoch denial stays consent_required rather than technical outage", async () => {
    const denied=new guard.AiConsentDenied("consent_required","not_granted");
    guard.configureConsentDispatch({mode:"enforced",publication,authorize:async()=>{throw denied;}});
    await expect(guard.withAiConsentContext(context,embed)).rejects.toBe(denied);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([{ status: 307, mode: "enforced" }, { status: 308, mode: "enforced" }, { status: 307, mode: "off" }] as const)("$mode mode HTTP $status redirect behavior", async ({ status, mode }) => {
    let unapprovedRequests = 0;
    const server = createServer((request, response) => {
      request.resume();
      if (request.url === "/v1/embeddings") { response.writeHead(status, { location: "/outside/embeddings" }); response.end(); }
      else { unapprovedRequests++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ embedding: Buffer.from(new Float32Array([1, 2]).buffer).toString("base64") }], usage: {} })); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      vi.stubEnv("OPENAI_BASE_URL", url); transport.mockImplementation(actualFetch);
      guard.configureConsentDispatch({ mode, publication: { ...publication, endpoint: url }, authorize: async () => true });
      const result = await guard.withAiConsentContext(context, embed).catch(() => null);
      expect(unapprovedRequests).toBe(mode === "enforced" ? 0 : 1);
      if (mode === "enforced") expect(result).toBeNull(); else expect(result?.data.vectors).toEqual([[1, 2]]);
    } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
  it("all-or-none batch authorization avoids per-subject read skew", async () => {
    let granted = new Set([actor]);
    const authorize = vi.fn(async (input: any) => {
      if (input.subjectUserId) { // Reproduces the OLD per-subject contract's inconsistent reads.
        const allowed = granted.has(input.subjectUserId);
        if (input.subjectUserId === actor) granted = new Set([other]);
        else if (input.subjectUserId === other) granted = new Set([actor]);
        return allowed;
      }
      const snapshot = new Set(granted); // Future DB authorizer must obtain ONE fresh committed snapshot.
      granted = new Set([other]);
      return input.subjectUserIds.every((id: string) => snapshot.has(id));
    });
    guard.configureConsentDispatch({ mode: "enforced", publication, authorize });
    const result = await guard.withAiConsentContext({ ...context, subjectUserIds: [actor, other] }, embed).catch(() => null);
    expect(transport.mock.calls.length).toBe(0); expect(result).toBeNull();
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0]![0].subjectUserIds).toEqual([actor, other]);
    expect(Object.isFrozen(authorize.mock.calls[0]![0].subjectUserIds)).toBe(true);
  });
  it("mode off is default and preserves provider output without context or authorizer", async () => {
    const result = await embed(); expect(result.data.vectors).toEqual([[1, 2]]); expect(result.provider).toBe("openai");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["context", "authorizer", "publication"])("enforced mode denies missing %s with zero transport", async missing => {
    guard.configureConsentDispatch({ mode: "enforced", ...(missing !== "publication" ? { publication } : {}),
      ...(missing !== "authorizer" ? { authorize: async () => true } : {}) });
    const call = missing === "context" ? embed() : guard.withAiConsentContext(context, embed);
    await expect(call).rejects.toBeInstanceOf(guard.AiConsentDenied);
    expect(transport).not.toHaveBeenCalled();
  });
  it("checks both identities and refuses wrong publication/recipient binding", async () => {
    const authorize = vi.fn(async ({ subjectUserIds }: { subjectUserIds: readonly string[] }) => subjectUserIds.every(id => id !== other));
    guard.configureConsentDispatch({ mode: "enforced", publication, authorize });
    await expect(guard.withAiConsentContext({ ...context, subjectUserIds: [other, actor, actor] }, embed)).rejects.toMatchObject({ code: "consent_required" });
    expect(authorize.mock.calls.map(([c]) => c.subjectUserIds)).toEqual([[actor, other]]); expect(transport).not.toHaveBeenCalled();
  });
  it("a publication for another endpoint is not permission for this provider", async () => {
    guard.configureConsentDispatch({ mode: "enforced", publication: { ...publication, endpoint: "https://other.invalid/v1" }, authorize: async () => true });
    await expect(guard.withAiConsentContext(context, embed)).rejects.toMatchObject({ code: "consent_required", reason: "publication_mismatch" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("check unavailability is sanitized policy_unavailable, never a normal provider error", async () => {
    guard.configureConsentDispatch({ mode: "enforced", publication, authorize: async () => { throw Error("PRIVATE SOURCE credential=SECRET"); } });
    const error = await guard.withAiConsentContext(context, embed).catch(e => e);
    expect(error).toBeInstanceOf(guard.AiConsentDenied); expect(error.code).toBe("policy_unavailable");
    expect(JSON.stringify(error) + error.stack).not.toMatch(/SECRET|PRIVATE SOURCE/); expect(transport).not.toHaveBeenCalled();
  });
  it("uses actual SDK retry, revocation blocks the next attempt and escapes SDK wrapping as typed denial", async () => {
    let allowed = true;
    guard.configureConsentDispatch({ mode: "enforced", publication, authorize: async () => allowed });
    transport.mockImplementationOnce(async () => { allowed = false; return new Response(JSON.stringify({ error: { message: "retry fixture" } }), { status: 500, headers: { "retry-after-ms": "1", "content-type": "application/json" } }); });
    await expect(guard.withAiConsentContext(context, embed)).rejects.toMatchObject({ code: "consent_required", reason: "not_granted" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("nested verifier swallowing SDK denial cannot yield degraded/cacheable review", async () => {
    let allowed = true;
    guard.configureConsentDispatch({ mode: "enforced", publication, authorize: async () => allowed });
    transport.mockImplementationOnce(async () => {
      allowed = false;
      const data = { compatible: false, confidence: 0.9, reason: "Scope", numericLimits: [],
        hardConflict: { kind: "scope", profileEvidence: "только на React", orderEvidence: "Python" },
        exclusiveScope: { profileEvidence: "Работаю только на React", orderEvidence: "Нужен сайт на Python",
          allowed: ["React"], requested: "Python", requestedWithinAllowed: false } };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), { headers: { "content-type": "application/json" } });
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(guard.withAiConsentContext(context, () => providers.openAiExtraction.reviewSemantic({ profile: ["Работаю только на React"], order: ["Нужен сайт на Python"] }, meta)))
      .rejects.toBeInstanceOf(guard.AiConsentDenied);
    expect(console.error).toHaveBeenCalled(); // A real nested verifier catch ran; outer boundary still rejects.
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("checks before remote audio preparation, not just before SDK upload", async () => {
    guard.configureConsentDispatch({ mode: "enforced", publication, authorize: async () => false });
    await expect(guard.withAiConsentContext(context, () => providers.openAiStt.transcribe({ filePath: "https://storage.invalid/private-audio", mimeType: "audio/webm" }, meta)))
      .rejects.toBeInstanceOf(guard.AiConsentDenied);
    expect(transport).not.toHaveBeenCalled();
  });
  it("preserves successful explicitly authorized fake-provider output", async () => {
    guard.configureConsentDispatch({ mode: "enforced", publication, authorize: async () => true });
    const result = await guard.withAiConsentContext(context, embed);
    expect(result.data.vectors).toEqual([[1, 2]]); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("keeps parallel execution contexts isolated, without leaking a sticky denial", async () => {
    guard.configureConsentDispatch({ mode: "enforced", publication, authorize: async ({ subjectUserIds }) => subjectUserIds.every(id => id === actor) });
    const results = await Promise.allSettled([guard.withAiConsentContext(context, embed),
      guard.withAiConsentContext({ ...context, subjectUserIds: [other] }, embed)]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]); expect(transport).toHaveBeenCalledTimes(1);
  });
});
