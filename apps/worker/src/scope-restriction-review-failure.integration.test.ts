import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import type { SemanticFact } from "@ustal/validation";
import { handleProfileExtraction } from "./handlers/profile-extraction.js";
import { handleOrderExtraction } from "./handlers/order-extraction.js";
import { handleMatchingRun } from "./handlers/matching-run.js";

/**
 * Codex audit 2026-10-18 (FAIL → fix): an active scope restriction («беру только …») must hold when the AI source
 * review fails technically. Real PostgreSQL, real matching run, fixture AI. Before the fix the out-of-scope order
 * was delivered as exact with review_unverified.
 */
assertLocalTestDatabase();
const db = getDb();
const RUN = randomUUID().slice(0, 6);
const users: string[] = [], orders: string[] = [];
let city: string;
const fixtures = new Map<string, SemanticFact[]>();
const vectors = new Map<string, number[]>();
const vector = (axis: number) => Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0));
const wrap = <T>(data: T) => ({ data, provider: "mock", model: "fixture-scope", latencyMs: 0, tokensInput: 0, tokensOutput: 0 });
function fact(phrase: string, keys: string[], axis: number, extra: Partial<SemanticFact> = {}): SemanticFact {
  vectors.set(phrase, vector(axis));
  return { phrase, canonicalKeys: keys, kind: "capability", mandatory: false, confidence: 0.95, evidence: "", constraintType: "none",
    constraintScope: "fact", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
    startHour: null, endHour: null, daysOfWeek: null, ...extra };
}
let review: "fail" | "compatible" = "fail";

async function user() {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test", status: "active" }).returning();
  users.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, name: "TEST scope", cityId: city, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
  return u!.id;
}
async function profile(text: string, facts: SemanticFact[]) {
  const u = await user();
  fixtures.set(text, facts);
  const [s] = await db.insert(schema.profileSourceInputs).values({ userId: u, inputType: "text", rawText: text, status: "confirmed" }).returning();
  const p = await handleProfileExtraction({ id: randomUUID(), data: { userId: u, sourceInputId: s!.id } } as never);
  await db.update(schema.capabilityProfiles).set({ status: "applied" }).where(eq(schema.capabilityProfiles.id, p.profileId));
  return u;
}
async function order(text: string, facts: SemanticFact[]) {
  const author = await user();
  fixtures.set(text, facts);
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId: city, sourceText: text, status: "processing" }).returning();
  orders.push(o!.id);
  await handleOrderExtraction({ id: randomUUID(), data: { orderId: o!.id } } as never);
  await db.update(schema.orders).set({ status: "published" }).where(eq(schema.orders.id, o!.id));
  return o!.id;
}
async function decision(orderId: string, userId: string) {
  const run = await handleMatchingRun({ id: randomUUID(), data: { orderId } } as never);
  if (!("matchingRunId" in run)) throw Error("matching skipped");
  const cand = await db.query.matchingCandidates.findFirst({ where: and(eq(schema.matchingCandidates.matchingRunId, run.matchingRunId), eq(schema.matchingCandidates.userId, userId)) });
  const trace = await db.query.matchingTraces.findFirst({ where: and(eq(schema.matchingTraces.matchingRunId, run.matchingRunId), eq(schema.matchingTraces.userId, userId)) });
  return { delivered: !!cand, matchType: cand?.matchType ?? null, decision: trace?.decision, detail: (trace?.detail ?? {}) as Record<string, unknown> };
}

beforeAll(async () => {
  const [c] = await db.insert(schema.cities).values({ name: `TEST scope ${RUN}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  city = c!.id;
  vi.spyOn(mockProviders.extraction, "extractCapabilityProfile").mockImplementation(async (input) => wrap({ summary: input.text, capabilities: [], resources: [] }));
  vi.spyOn(mockProviders.extraction, "extractOrder").mockImplementation(async (input) => wrap({
    normalizedTitle: input.text, normalizedDescription: input.text, actions: [], requiredCapabilities: [], desiredCapabilities: [],
    requiredResources: [], desiredResources: [], physicalRequirements: [], complexity: "low", requiresQualification: false,
    regulated: false, estimatedDurationMinutes: null, contextualChips: [],
  }));
  vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (input) => {
    const facts = [...fixtures].filter(([t]) => input.text.includes(t)).flatMap(([t, fs]) => fs.map((f) => ({ ...f, evidence: t })));
    if (!facts.length) throw Error("Missing explicit provider fixture");
    return wrap({ facts });
  });
  vi.spyOn(mockProviders.embedding, "embed").mockImplementation(async (texts) =>
    wrap({ vectors: texts.map((t) => vectors.get(t) ?? vectors.get(t.split("\n")[0]!) ?? vector(100)) }));
  vi.spyOn(mockProviders.extraction, "reviewSemantic").mockImplementation(async () => {
    if (review === "fail") throw Object.assign(new Error("Evidence is not grounded in a source span"), { name: "EvidenceValidationError", code: "EVIDENCE_VALIDATION_ERROR" });
    return wrap({ compatible: true, confidence: 0.9, reason: "fixture: compatible", hardConflict: null, numericLimits: [], exclusiveScope: null }) as never;
  });
}, 30000);
afterAll(async () => {
  vi.restoreAllMocks();
  if (orders.length) await db.delete(schema.moderationCases).where(inArray(schema.moderationCases.orderId, orders));
  if (orders.length) await db.delete(schema.orders).where(inArray(schema.orders.id, orders));
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.cities).where(eq(schema.cities.id, city));
  await getSql().end();
});

it("technical review failure: an order outside the active scope restriction is not delivered; inside it is (high recall)", async () => {
  // «Копаю и собираю мебель. Беру только заказы на сборку мебели.» — scope = assembly, generic (not IT).
  const u = await profile(`${RUN} Копаю и собираю мебель. Беру только заказы на сборку мебели.`, [
    fact(`${RUN} копаю`, ["digging"], 431),
    fact(`${RUN} собираю мебель`, ["assembly"], 420),
    fact(`${RUN} только сборка мебели`, ["assembly"], 420, { constraintType: "scope" }),
  ]);
  const outside = await order(`${RUN} заказ: выкопать траншею`, [fact(`${RUN} выкопать траншею`, ["digging"], 431, { constraintScope: "whole_task" })]);
  const inside = await order(`${RUN} заказ: собрать шкаф`, [fact(`${RUN} сборка шкафа`, ["assembly"], 420, { constraintScope: "whole_task" })]);
  review = "fail";
  const out = await decision(outside, u);
  expect(out.delivered).toBe(false);
  expect(out.detail.reason).toBe("scope_unverified");
  expect(out.detail.review_status).toBe("failed");
  const ins = await decision(inside, u);
  expect(ins.delivered).toBe(true);
  expect(ins.matchType).toBe("exact");
  // A user without any scope restriction keeps the fail-open path (review_unverified) for the same order.
  const free = await profile(`${RUN} Копаю.`, [fact(`${RUN} копаю свободно`, ["digging"], 431)]);
  const f = await decision(outside, free);
  expect(f.delivered).toBe(true);
  expect(f.detail.review_unverified).toBe(true);
});

it("normal successful review: the completed review decides as before", async () => {
  review = "compatible";
  const u = await profile(`${RUN}B Копаю и собираю мебель. Беру только заказы на сборку мебели.`, [
    fact(`${RUN}B копаю`, ["digging"], 431),
    fact(`${RUN}B только сборка мебели`, ["assembly"], 420, { constraintType: "scope" }),
  ]);
  const o = await order(`${RUN}B заказ: выкопать яму`, [fact(`${RUN}B выкопать яму`, ["digging"], 431, { constraintScope: "whole_task" })]);
  const d = await decision(o, u);
  expect(d.detail.review_status).toBeUndefined();
  expect(d.delivered).toBe(true); // fixture review says compatible — the completed verdict stands (unchanged path)
});
