import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { SEMANTIC_POLICY } from "@ustal/matching";
import { handleMatchingRun } from "./matching-run.js";
// Variant B: these tests count/inspect individual AI review calls for fixtures whose texts repeat across cases
// (and across test runs on the same DB); memoization is covered by tests/ai-review-cache.integration.test.ts.
vi.mock("../ai-review-cache.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../ai-review-cache.js")>()),
  readCachedReview: async () => null, storeCachedReview: async (_key: string, _identity: unknown, result: unknown) => result }));
assertLocalTestDatabase();

/**
 * 2026-10-06 stress scenario: «Иногда занимаюсь монтажом мероприятий» (profile node events) vs
 * «Нужен помощник на монтаж мероприятия» (order node assembly). No node overlap, and 20 stronger
 * competitors whose whole-profile embeddings are closer to the order fill the semantic stream
 * (shortlist=5), so neither canonical retrieval nor the city fallback can bring the owner in.
 */
const db = getDb(), users: string[] = [], cities: string[] = [], orders: string[] = [];
afterAll(async () => {
  if (orders.length) await db.delete(schema.orders).where(inArray(schema.orders.id, orders));
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});
const vec = (i: number, noise = 0, j = 0) => Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : k === j && noise ? noise : 0));
const SHORTLIST = 5, COMPETITORS = 20;
const nodeId = async (key: string) => (await db.query.ontologyNodes.findFirst({ where: eq(schema.ontologyNodes.canonicalKey, key) }))!.id;

async function scenario() {
  const [city] = await db.insert(schema.cities).values({ name: "TEST_skill_retrieval_" + randomUUID(), regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cities.push(city!.id);
  const people = await db.insert(schema.users).values(Array.from({ length: COMPETITORS + 2 }, () => ({ phone: randomUUID().slice(0, 20), passwordHash: "test-only", status: "active" as const }))).returning();
  users.push(...people.map((u) => u.id));
  await db.insert(schema.userProfiles).values(people.map((u) => ({ userId: u.id, cityId: city!.id, name: "TEST", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() })));
  const [author, owner, ...competitors] = people;
  const text = "Нужен помощник на монтаж мероприятия";
  const [order] = await db.insert(schema.orders).values({ authorId: author!.id, cityId: city!.id, sourceText: text, status: "published", riskLevel: 0 }).returning();
  orders.push(order!.id);
  const [orderDoc] = await db.insert(schema.matchingDocuments).values({ orderId: order!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: vec(0) }).returning();
  await db.insert(schema.matchingFacts).values({ documentId: orderDoc!.id, kind: "capability", phrase: "помощник на монтаж мероприятия", evidence: text, nodeIds: [await nodeId("assembly")], confidence: "1", mandatory: false, embedding: vec(20) });
  const profileOf = async (userId: string, docVector: number[], phrase: string, nodes: string[], factVector: number[]) => {
    const [p] = await db.insert(schema.capabilityProfiles).values({ userId, summary: "TEST", profileVersion: 1, extractionVersion: "test", status: "applied" }).returning();
    await db.insert(schema.profileEmbeddings).values({ capabilityProfileId: p!.id, embeddingModel: "test", embedding: docVector });
    const [doc] = await db.insert(schema.matchingDocuments).values({ profileId: p!.id, sourceText: phrase, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: docVector }).returning();
    await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: "capability", phrase, evidence: phrase, nodeIds: nodes, confidence: "1", mandatory: false, embedding: factVector });
    for (const n of nodes) await db.insert(schema.userCapabilities).values({ capabilityProfileId: p!.id, ontologyNodeId: n, label: phrase, evidenceType: "explicit", confidence: "1" });
  };
  // Owner: the relevant skill on a different node; whole profile diluted (teacher, repair, …) and far from the order.
  await profileOf(owner!.id, vec(1), "Иногда занимаюсь монтажом мероприятий", [await nodeId("events")], vec(20, 0.2, 21));
  // Stronger competitors by whole-profile embedding, with unrelated skills.
  for (const [i, u] of competitors.entries())
    await profileOf(u.id, vec(0, 0.1 + i * 0.01, 3), "уборка", [await nodeId("cleaning")], vec(3));
  return { order: order!, owner: owner! };
}

it.each([true, false])("skill-fact retrieval brings the owner into the candidate pool; review compatible=%s decides the match", async (compatible) => {
  const { order, owner } = await scenario();
  const keep = SEMANTIC_POLICY.shortlist;
  SEMANTIC_POLICY.shortlist = SHORTLIST;
  const review = vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue({ data: { compatible, confidence: 0.95, reason: "test" }, provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 });
  try {
    const result = await handleMatchingRun({ id: randomUUID(), data: { orderId: order.id } } as never);
    if (!("matchingRunId" in result)) throw new Error("missing run");
    const traces = await db.select().from(schema.matchingTraces).where(eq(schema.matchingTraces.matchingRunId, result.matchingRunId));
    // Bounded pool: semantic (5) ∪ capability_semantic (5), never the whole city (21).
    expect(traces.length).toBeLessThanOrEqual(2 * SHORTLIST);
    expect(traces.some((t) => t.userId === owner.id), "owner must be retrieved").toBe(true);
    const candidates = await db.select().from(schema.matchingCandidates).where(eq(schema.matchingCandidates.matchingRunId, result.matchingRunId));
    // Retrieval is discovery only: the existing evaluation + source review decide.
    expect(candidates.some((c) => c.userId === owner.id)).toBe(compatible);
  } finally {
    review.mockRestore();
    SEMANTIC_POLICY.shortlist = keep;
  }
}, 60000);
