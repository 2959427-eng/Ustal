import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { SEMANTIC_POLICY } from "@ustal/matching";
import { handleMatchingRun } from "./matching-run.js";
assertLocalTestDatabase();

/**
 * 2026-10-05: a profile that only owns a resource unknown to the ontology («есть кофемашина»,
 * no skills, no node) must reach the candidate set through first-pass retrieval, not through
 * the city fallback. The city is filled with more embedded profiles than the shortlist, all of
 * them closer to the order's document vector, so `semantic` is full and `city_fallback` is empty.
 */
const db = getDb(), users: string[] = [], cities: string[] = [], orders: string[] = [];
afterAll(async () => {
  if (orders.length) await db.delete(schema.orders).where(inArray(schema.orders.id, orders));
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});
const axis = (i: number, noise = 0, j = 0) => Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : k === j && noise ? noise : 0));
const SHORTLIST = 5, FILLERS = 8;

async function scenario(owned: string, needed: string, axisIndex: number) {
  const [city] = await db.insert(schema.cities).values({ name: "TEST_resource_retrieval_" + randomUUID(), regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cities.push(city!.id);
  const people = await db.insert(schema.users).values(Array.from({ length: FILLERS + 2 }, () => ({ phone: randomUUID().slice(0, 20), passwordHash: "test-only", status: "active" as const }))).returning();
  users.push(...people.map((u) => u.id));
  await db.insert(schema.userProfiles).values(people.map((u) => ({ userId: u.id, cityId: city!.id, name: "TEST", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() })));
  const [author, owner, ...fillers] = people;
  const [order] = await db.insert(schema.orders).values({ authorId: author!.id, cityId: city!.id, sourceText: needed, status: "published", riskLevel: 0 }).returning();
  orders.push(order!.id);
  const orderVector = axis(0);
  const [orderDoc] = await db.insert(schema.matchingDocuments).values({ orderId: order!.id, sourceText: needed, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: orderVector }).returning();
  // The order needs a resource with no ontology node; its phrase vector is the resource axis.
  await db.insert(schema.matchingFacts).values({ documentId: orderDoc!.id, kind: "resource", phrase: needed, evidence: needed, nodeIds: [], confidence: "1", mandatory: true, resourceRole: "required", embedding: axis(axisIndex) });

  const profileOf = async (userId: string, docVector: number[], fact: { kind: string; phrase: string; role: string; vector: number[] }) => {
    const [profile] = await db.insert(schema.capabilityProfiles).values({ userId, summary: "TEST", profileVersion: 1, extractionVersion: "test", status: "applied" }).returning();
    await db.insert(schema.profileEmbeddings).values({ capabilityProfileId: profile!.id, embeddingModel: "test", embedding: docVector });
    const [doc] = await db.insert(schema.matchingDocuments).values({ profileId: profile!.id, sourceText: fact.phrase, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: docVector }).returning();
    await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: fact.kind, phrase: fact.phrase, evidence: fact.phrase, nodeIds: [], confidence: "1", mandatory: false, resourceRole: fact.role, embedding: fact.vector });
  };
  // Resource-only owner: no skills, so its document vector is the "no capabilities" text — far from the order.
  await profileOf(owner!.id, axis(1), { kind: "resource", phrase: owned, role: "available", vector: axis(axisIndex, 0.05, 7) });
  // Fillers: ordinary skill profiles whose document vectors are all closer to the order than the owner's.
  for (const [i, u] of fillers.entries())
    await profileOf(u.id, axis(0, 0.1 + i * 0.01, 3), { kind: "capability", phrase: "уборка", role: "none", vector: axis(3) });
  return { order: order!, owner: owner!, fillers };
}

it.each([
  ["есть кофемашина", "нужна кофемашина на мероприятие", 10],
  ["есть генератор", "нужен генератор на дачу", 11],
  ["есть самолёт", "нужен самолёт для аэросъёмки", 12],
])("profile with only «%s» (no skills, no node) is retrieved for «%s» without the city fallback", async (owned, needed, axisIndex) => {
  const { order, owner } = await scenario(owned, needed, axisIndex);
  const shortlist = SEMANTIC_POLICY.shortlist;
  SEMANTIC_POLICY.shortlist = SHORTLIST;
  const review = vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue({ data: { compatible: true, confidence: 0.95, reason: "has the needed item" }, provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 });
  try {
    const result = await handleMatchingRun({ id: randomUUID(), data: { orderId: order.id } } as never);
    if (!("matchingRunId" in result)) throw new Error("missing run");
    const traces = await db.select().from(schema.matchingTraces).where(eq(schema.matchingTraces.matchingRunId, result.matchingRunId));
    // Bounded retrieval: the semantic stream is full (no city fallback), plus the resource stream.
    expect(traces.length).toBeLessThanOrEqual(SHORTLIST + SHORTLIST);
    expect(traces.length).toBeLessThan(FILLERS + 1);
    const ownerTrace = traces.find((t) => t.userId === owner.id);
    expect(ownerTrace, "resource-only owner must be in the candidate set").toBeDefined();
    expect(ownerTrace!.detail).toMatchObject({ unknown_resource_semantic_hits: 1 });
    const candidates = await db.select().from(schema.matchingCandidates).where(eq(schema.matchingCandidates.matchingRunId, result.matchingRunId));
    expect(candidates.map((c) => c.userId)).toContain(owner.id);
  } finally {
    review.mockRestore();
    SEMANTIC_POLICY.shortlist = shortlist;
  }
}, 30000);
