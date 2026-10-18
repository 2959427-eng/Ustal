import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders, reviewPipelineFingerprint, SEMANTIC_REVIEW_PROMPT_VERSION } from "@ustal/ai";
import { SEMANTIC_POLICY } from "@ustal/matching";
import { handleMatchingRun } from "../src/handlers/matching-run.js";
import { readCachedReview, reviewCacheKey, storeCachedReview, type ReviewCacheIdentity } from "../src/ai-review-cache.js";
assertLocalTestDatabase();

/**
 * Variant B (2026-10-15): memoized AI review verdicts between runs/waves of one order. Fixture AI; every test uses
 * unique texts (the cache is content-addressed and persists in the test DB between runs).
 */
const db = getDb(), users: string[] = [], cities: string[] = [];
afterAll(async () => {
  if (users.length) { await db.delete(schema.orders).where(inArray(schema.orders.authorId, users)); await db.delete(schema.users).where(inArray(schema.users.id, users)); }
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});
const vec = (i: number) => Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : 0));
const INCOMPATIBLE = { compatible: false, confidence: 0.95, reason: "нет подтверждённого опыта", hardConflict: { kind: "domain", profileEvidence: "x", orderEvidence: "y" } };
const COMPATIBLE = { compatible: true, confidence: 0.9, reason: "подходит", hardConflict: null };
let reviewVerdict: (profile: string) => object | "fail" | "degraded" = () => INCOMPATIBLE;
let refusalVerdict: (refusal: string) => boolean | "fail" = () => false;
const reviewCalls: string[] = [], refusalCalls: string[] = [];
beforeEach(() => {
  reviewCalls.length = 0; refusalCalls.length = 0;
  reviewVerdict = () => INCOMPATIBLE; refusalVerdict = () => false;
  vi.spyOn(mockProviders.extraction, "reviewSemantic").mockImplementation(async (input) => {
    const p = input.profile.join(" "); reviewCalls.push(p);
    const v = reviewVerdict(p);
    if (v === "fail") throw new Error("provider timeout");
    const base = { provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 };
    return (v === "degraded" ? { data: INCOMPATIBLE, ...base, degraded: true } : { data: v, ...base }) as never;
  });
  vi.spyOn(mockProviders.extraction, "checkRefusal").mockImplementation(async (input) => {
    refusalCalls.push(input.refusal);
    const v = refusalVerdict(input.refusal);
    if (v === "fail") throw new Error("provider timeout");
    return { data: { involves: v, reason: "test" }, provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 };
  });
});

async function city() {
  const [c] = await db.insert(schema.cities).values({ name: "TEST_cache_" + randomUUID(), regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cities.push(c!.id); return c!.id;
}
async function person(cityId: string) {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "test-only", status: "active" }).returning();
  users.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, cityId, name: "TEST", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
  return u!.id;
}
type F = { kind: string; phrase: string; constraintType?: string };
/** Returns the profile matching document id. */
async function profile(userId: string, text: string, facts: F[]) {
  const v = vec(7);
  const [p] = await db.insert(schema.capabilityProfiles).values({ userId, summary: text, profileVersion: 1, extractionVersion: "test", status: "applied" }).returning();
  await db.insert(schema.profileEmbeddings).values({ capabilityProfileId: p!.id, embeddingModel: "test", embedding: v });
  const [doc] = await db.insert(schema.matchingDocuments).values({ profileId: p!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: v }).returning();
  for (const f of facts)
    await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: f.kind, phrase: f.phrase, evidence: text, nodeIds: [], confidence: "1", mandatory: false,
      constraintType: f.constraintType ?? "none", constraintScope: "whole_task", embedding: v });
  return doc!.id;
}
const GENERAL = { accessLevel: "general", explicitRequirements: [], reason: "простая задача", version: "order-access-v1" };
/** Returns { orderId, docId }. access=null: no general-access path (only the ordinary review is exercised). */
async function order(cityId: string, author: string, text: string, access: object | null) {
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId, sourceText: text, status: "published", riskLevel: 0, publishedAt: new Date() }).returning();
  await db.insert(schema.orderAiExtractions).values({ orderId: o!.id, extractionVersion: "v1", rawResult: { regulated: false, requiresQualification: false, actions: [], access } });
  const [doc] = await db.insert(schema.matchingDocuments).values({ orderId: o!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: vec(0) }).returning();
  await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: "capability", phrase: text, evidence: text, nodeIds: [], confidence: "1", mandatory: false, embedding: vec(0) });
  return { orderId: o!.id, docId: doc!.id };
}
async function run(orderId: string, wave?: number) {
  if (wave) await db.update(schema.orders).set({ deliveryWave: wave }).where(eq(schema.orders.id, orderId));
  const r = await handleMatchingRun({ id: randomUUID(), data: { orderId } } as never);
  if (!("matchingRunId" in r)) throw new Error("no run");
  const traces = await db.select().from(schema.matchingTraces).where(eq(schema.matchingTraces.matchingRunId, r.matchingRunId));
  const candidates = await db.select().from(schema.matchingCandidates).where(eq(schema.matchingCandidates.matchingRunId, r.matchingRunId));
  return { traces, candidates, runId: r.matchingRunId };
}
const strip = (d: unknown) => { const { review_cache: _c, ...rest } = d as Record<string, unknown>; void _c; return rest; };

it("A + C: unchanged inputs across waves 1/4/10 reuse the verdict without an AI call; a changed order misses", async () => {
  const tag = randomUUID().slice(0, 8);
  const c = await city(), author = await person(c), u = await person(c);
  await profile(u, `Я ремонтирую велосипеды ${tag}`, [{ kind: "capability", phrase: "ремонт велосипедов" }]);
  reviewVerdict = () => COMPATIBLE;
  const { orderId, docId } = await order(c, author, `Починить велосипед ${tag}`, null);
  const w1 = await run(orderId, 1);
  expect(reviewCalls).toHaveLength(1);
  const t1 = w1.traces.find((t) => t.userId === u)!;
  expect((t1.detail as Record<string, unknown>).review_cache).toBeUndefined();
  for (const wave of [4, 10]) {
    reviewVerdict = () => INCOMPATIBLE; // a second AI call would now change the verdict; the cache must not call it
    const w = await run(orderId, wave);
    expect(reviewCalls).toHaveLength(1);
    const t = w.traces.find((x) => x.userId === u)!;
    expect((t.detail as Record<string, unknown>).review_cache).toBe("hit");
    // Same business decision: classification, score, match type, trace (except the cache marker).
    expect(t.decision).toBe(t1.decision);
    expect(strip(t.detail)).toEqual(strip(t1.detail));
    expect(w.candidates.map((x) => [x.userId, x.score, x.matchType])).toEqual(w1.candidates.map((x) => [x.userId, x.score, x.matchType]));
  }
  // C: the order text changes -> new key -> AI is called again.
  // (an order edit changes both the order and its matching document)
  await db.update(schema.orders).set({ sourceText: `Починить велосипед и самокат ${tag}` }).where(eq(schema.orders.id, orderId));
  await db.update(schema.matchingDocuments).set({ sourceText: `Починить велосипед и самокат ${tag}` }).where(eq(schema.matchingDocuments.id, docId));
  await run(orderId, 10);
  expect(reviewCalls).toHaveLength(2);
});

it("B: a changed profile misses the cache", async () => {
  const tag = randomUUID().slice(0, 8);
  const c = await city(), author = await person(c), u = await person(c);
  const doc = await profile(u, `Я ремонтирую велосипеды ${tag}`, [{ kind: "capability", phrase: "ремонт велосипедов" }]);
  const { orderId } = await order(c, author, `Починить велосипед ${tag}`, null);
  await run(orderId, 1);
  expect(reviewCalls).toHaveLength(1);
  await db.update(schema.matchingDocuments).set({ sourceText: `Я ремонтирую велосипеды и мопеды ${tag}` }).where(eq(schema.matchingDocuments.id, doc));
  await run(orderId, 1);
  expect(reviewCalls).toHaveLength(2);
  expect(reviewCalls[1]).toContain("мопеды");
});

it("D: a restriction verdict is reused across waves; a changed restriction is checked again", async () => {
  const tag = randomUUID().slice(0, 8);
  const c = await city(), author = await person(c), u = await person(c);
  const doc = await profile(u, `Не мою окна ${tag}`, [{ kind: "exclude", phrase: "мытьё окон", constraintType: "exclusion" }]);
  const { orderId } = await order(c, author, `Помочь перенести коробки ${tag}`, GENERAL);
  const w1 = await run(orderId, 1);
  expect(refusalCalls).toHaveLength(1);
  expect(w1.candidates.find((x) => x.userId === u)?.matchType).toBe("opportunity");
  refusalVerdict = () => true; // would refuse if AI were called again
  const w4 = await run(orderId, 4);
  expect(refusalCalls).toHaveLength(1);
  expect(w4.candidates.find((x) => x.userId === u)?.matchType).toBe("opportunity");
  const ga = (w4.traces.find((t) => t.userId === u)!.detail as { general_access: { refusalsChecked: { cached?: boolean }[] } }).general_access;
  expect(ga.refusalsChecked[0]!.cached).toBe(true);
  await db.update(schema.matchingFacts).set({ evidence: `Не мою окна и не таскаю тяжести ${tag}` }).where(eq(schema.matchingFacts.documentId, doc));
  const w10 = await run(orderId, 10);
  expect(refusalCalls).toHaveLength(2);
  expect(w10.candidates.find((x) => x.userId === u)).toBeUndefined();
});

it("E: the real pipeline fingerprint (prompts, schemas, model, endpoint, params) and versions are part of the key", async () => {
  const id: ReviewCacheIdentity = { reviewType: "semantic_pair_review", promptVersion: SEMANTIC_REVIEW_PROMPT_VERSION, schemaVersion: "v1", input: { profile: ["p"], order: ["o"] } };
  const k = reviewCacheKey(id, "pipeline-a");
  expect(reviewCacheKey({ ...id, input: { order: ["o"], profile: ["p"] } }, "pipeline-a")).toBe(k); // canonical JSON
  expect(reviewCacheKey(id, "pipeline-b")).not.toBe(k);
  expect(reviewCacheKey({ ...id, promptVersion: id.promptVersion + "-next" }, "pipeline-a")).not.toBe(k);
  expect(reviewCacheKey({ ...id, schemaVersion: "v2" }, "pipeline-a")).not.toBe(k);
  expect(reviewCacheKey({ ...id, reviewType: "general_access_refusal_check" }, "pipeline-a")).not.toBe(k);
  expect(reviewCacheKey({ ...id, input: { profile: ["p"], order: ["o"], profileHasUpdates: true } }, "pipeline-a")).not.toBe(k);
  const tag = randomUUID();
  const stored = { ...id, input: { tag } };
  await storeCachedReview(reviewCacheKey(stored, "pipeline-a"), stored, COMPATIBLE, "pipeline-a");
  expect(await readCachedReview(reviewCacheKey(stored, "pipeline-a"))).toEqual(COMPATIBLE);
  expect(await readCachedReview(reviewCacheKey(stored, "pipeline-b"))).toBeNull();
  expect(await readCachedReview(reviewCacheKey({ ...stored, promptVersion: "other" }, "pipeline-a"))).toBeNull();
  // The default pipeline is @ustal/ai reviewPipelineFingerprint (see packages/ai review-fingerprint.test.ts for which
  // pipeline changes alter it); without a provable fingerprint there is no key and the cache is not used at all.
  expect(reviewCacheKey(stored)).toBe(reviewCacheKey(stored, reviewPipelineFingerprint(stored.reviewType)));
  expect(reviewCacheKey(stored, null)).toBeNull();
  expect(await readCachedReview(null)).toBeNull();
  expect(await storeCachedReview(null, stored, INCOMPATIBLE)).toEqual(INCOMPATIBLE);
});

it("F: technical failures and degraded verdicts are never cached; the next run calls AI again", async () => {
  const tag = randomUUID().slice(0, 8);
  const c = await city(), author = await person(c), u = await person(c), r = await person(c);
  await profile(u, `Я ремонтирую велосипеды ${tag}`, [{ kind: "capability", phrase: "ремонт велосипедов" }]);
  await profile(r, `Не мою окна ${tag}`, [{ kind: "exclude", phrase: "мытьё окон", constraintType: "exclusion" }]);
  const { orderId } = await order(c, author, `Помочь перенести коробки ${tag}`, GENERAL);
  // Both profiles get the ordinary review (2 calls per uncached run); the restricted one also gets a refusal check.
  reviewVerdict = () => "fail"; refusalVerdict = () => "fail";
  await run(orderId, 1);
  expect([reviewCalls.length, refusalCalls.length]).toEqual([2, 1]);
  reviewVerdict = () => "degraded"; refusalVerdict = () => false;
  await run(orderId, 1); // a failed review is never a reusable run (inputHash = null) -> recomputed, failures not cached
  expect([reviewCalls.length, refusalCalls.length]).toEqual([4, 2]);
  reviewVerdict = () => INCOMPATIBLE;
  await run(orderId, 2); // degraded verdicts were not stored -> called again; the successful refusal check was stored
  expect([reviewCalls.length, refusalCalls.length]).toEqual([6, 2]);
  await run(orderId, 3); // now everything is memoized
  expect([reviewCalls.length, refusalCalls.length]).toEqual([6, 2]);
});

it("G: parallel identical requests leave one row and one consistent verdict", async () => {
  const id: ReviewCacheIdentity = { reviewType: "general_access_refusal_check", promptVersion: "refusal-target-v1", schemaVersion: "v1", input: { refusal: randomUUID(), order: ["o"] } };
  const key = reviewCacheKey(id);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => storeCachedReview(key, id, { involves: i % 2 === 0, reason: `r${i}` })));
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM ai_review_cache WHERE cache_key=${key}`);
  expect(rows[0]!.n).toBe(1);
  const stored = await readCachedReview(key);
  for (const v of results) expect(v).toEqual(stored);
  // Two concurrent matching runs of two orders with identical text and the same profile: both miss, both call AI,
  // one row is kept and both runs decide by the same stored verdict.
  const tag = randomUUID().slice(0, 8);
  const c = await city(), author = await person(c), u = await person(c);
  await profile(u, `Я ремонтирую велосипеды ${tag}`, [{ kind: "capability", phrase: "ремонт велосипедов" }]);
  let n = 0;
  reviewVerdict = () => (n++ === 0 ? COMPATIBLE : INCOMPATIBLE);
  const o1 = await order(c, author, `Починить велосипед ${tag}`, null), o2 = await order(c, author, `Починить велосипед ${tag}`, null);
  const [a, b] = await Promise.all([run(o1.orderId), run(o2.orderId)]);
  const da = a.traces.find((t) => t.userId === u)!, dbt = b.traces.find((t) => t.userId === u)!;
  expect(da.decision).toBe(dbt.decision);
  expect(a.candidates.length).toBe(b.candidates.length);
});

it("budget: cached verdicts do not consume the wave budget, so restricted general-access people get checked on later waves", async () => {
  const keep = SEMANTIC_POLICY.reviewLimit;
  SEMANTIC_POLICY.reviewLimit = 1;
  try {
    const tag = randomUUID().slice(0, 8);
    const c = await city(), author = await person(c);
    const reviewed = await person(c);
    await profile(reviewed, `Я ремонтирую велосипеды ${tag}`, [{ kind: "capability", phrase: "ремонт велосипедов" }]);
    const restricted = await person(c); // also gets the ordinary review (domain mismatch -> general-access eligible)
    await profile(restricted, `Не мою окна ${tag}`, [{ kind: "exclude", phrase: "мытьё окон", constraintType: "exclusion" }]);
    const { orderId } = await order(c, author, `Помочь перенести коробки ${tag}`, GENERAL);
    const w1 = await run(orderId, 1); // budget 1: one review, the other person deferred, nothing left for the restriction
    expect(reviewCalls).toHaveLength(1);
    expect(refusalCalls).toHaveLength(0);
    expect(w1.candidates.find((x) => x.userId === restricted)).toBeUndefined();
    // budget 2: one cached + one new review -> one real call left for the restriction check.
    // Before variant B both reviews were repeated (2 calls) and the restricted person was skipped again.
    const w2 = await run(orderId, 2);
    expect(reviewCalls).toHaveLength(2);
    expect(refusalCalls).toHaveLength(1);
    expect(w2.traces.filter((t) => (t.detail as Record<string, unknown>).review_cache === "hit")).toHaveLength(1);
    expect(w2.candidates.find((x) => x.userId === restricted)?.matchType).toBe("opportunity");
  } finally { SEMANTIC_POLICY.reviewLimit = keep; }
});
