import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { SEMANTIC_POLICY } from "@ustal/matching";
import { handleMatchingRun } from "./handlers/matching-run.js";
import { dispatchDeliveryWaves } from "./order-delivery-waves.js";
assertLocalTestDatabase();

/**
 * Показ волнами (2026-10-15): волна 1 — обычный ограниченный подбор; если за окно откликов мало, следующая волна
 * подбирает следующих по релевантности людей города, уже получившие заказ его не теряют; когда подходящие люди
 * закончились — волн больше нет. Закрытый заказчиком приём и окно ожидания волны не поднимают.
 */
const db = getDb(), users: string[] = [], cities: string[] = [], orders: string[] = [];
afterAll(async () => {
  if (orders.length) await db.delete(schema.orders).where(inArray(schema.orders.id, orders));
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});
const vec = (i: number, noise = 0, j = 0) => Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : k === j && noise ? noise : 0));
const SHORTLIST = 3, EXECUTORS = 10;
const HOUR = 3600_000;

async function scenario(publishedAt: Date, desiredAt: Date | null = null) {
  const node = (await db.query.ontologyNodes.findFirst({ where: eq(schema.ontologyNodes.canonicalKey, "cleaning") }))!.id;
  const [city] = await db.insert(schema.cities).values({ name: "TEST_waves_" + randomUUID(), regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cities.push(city!.id);
  const people = await db.insert(schema.users).values(Array.from({ length: EXECUTORS + 1 }, () => ({ phone: randomUUID().slice(0, 20), passwordHash: "test-only", status: "active" as const }))).returning();
  users.push(...people.map((u) => u.id));
  await db.insert(schema.userProfiles).values(people.map((u) => ({ userId: u.id, cityId: city!.id, name: "TEST", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() })));
  const [author, ...executors] = people;
  const text = "Нужна уборка квартиры";
  const [order] = await db.insert(schema.orders).values({ authorId: author!.id, cityId: city!.id, sourceText: text, status: "published", riskLevel: 0, publishedAt, desiredAt }).returning();
  orders.push(order!.id);
  const [orderDoc] = await db.insert(schema.matchingDocuments).values({ orderId: order!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: vec(0) }).returning();
  await db.insert(schema.matchingFacts).values({ documentId: orderDoc!.id, kind: "capability", phrase: "уборка квартиры", evidence: text, nodeIds: [node], confidence: "1", mandatory: false, embedding: vec(0) });
  for (const [i, u] of executors.entries()) {
    const [p] = await db.insert(schema.capabilityProfiles).values({ userId: u.id, summary: "TEST", profileVersion: 1, extractionVersion: "test", status: "applied" }).returning();
    const v = vec(0, 0.05 + i * 0.05, 5);
    await db.insert(schema.profileEmbeddings).values({ capabilityProfileId: p!.id, embeddingModel: "test", embedding: v });
    const [doc] = await db.insert(schema.matchingDocuments).values({ profileId: p!.id, sourceText: "Делаю уборку", processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: v }).returning();
    await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: "capability", phrase: "уборка", evidence: "Делаю уборку", nodeIds: [node], confidence: "1", mandatory: false, embedding: v });
    await db.insert(schema.userCapabilities).values({ capabilityProfileId: p!.id, ontologyNodeId: node, label: "уборка", evidenceType: "explicit", confidence: "1" });
  }
  return { orderId: order!.id, executors: executors.map((u) => u.id) };
}
const run = async (orderId: string) => {
  const r = await handleMatchingRun({ id: randomUUID(), data: { orderId } } as never);
  if (!("matchingRunId" in r)) throw new Error("no run");
  return new Set((await db.select().from(schema.matchingCandidates).where(eq(schema.matchingCandidates.matchingRunId, r.matchingRunId))).map((c) => c.userId));
};
const orderRow = async (id: string) => (await db.query.orders.findFirst({ where: eq(schema.orders.id, id) }))!;
/** Тик только по заказам этого теста (другие тесты в той же БД не должны мешать). */
const tick = async (now: Date, own: string[]) => {
  const queued: string[] = [];
  await dispatchDeliveryWaves(async (id) => { queued.push(id); }, now);
  return queued.filter((id) => own.includes(id));
};

it("waves widen delivery until the city has nobody new; earlier recipients keep the order", async () => {
  const keep = SEMANTIC_POLICY.shortlist;
  SEMANTIC_POLICY.shortlist = SHORTLIST;
  const review = vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue({ data: { compatible: true, confidence: 0.95, reason: "test" }, provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 });
  try {
    const t0 = new Date(Date.now() - 10 * HOUR);
    const { orderId, executors } = await scenario(t0);
    const wave1 = await run(orderId);
    expect(wave1.size).toBeGreaterThan(0);
    expect(wave1.size).toBeLessThan(EXECUTORS);
    expect((await orderRow(orderId)).deliveryExhaustedAt).toBeNull();

    // Окно ожидания (6 ч без срока) ещё не прошло — волна не поднимается.
    expect(await tick(new Date(t0.getTime() + 5 * HOUR), [orderId])).toEqual([]);
    const now2 = new Date(t0.getTime() + 6 * HOUR + 1000);
    expect(await tick(now2, [orderId])).toEqual([orderId]);
    // Пока прогон новой волны не завершён, следующая не поднимается.
    expect(await tick(new Date(now2.getTime() + 7 * HOUR), [orderId])).toEqual([]);
    expect((await orderRow(orderId)).deliveryWave).toBe(2);
    const wave2 = await run(orderId);
    expect([...wave1].every((u) => wave2.has(u))).toBe(true);
    expect(wave2.size).toBeGreaterThan(wave1.size);

    // Дальше — до исчерпания города: больше волн не будет, и все исполнители города получили заказ.
    let now = now2, last = wave2;
    for (let i = 0; i < 10 && !(await orderRow(orderId)).deliveryExhaustedAt; i++) {
      now = new Date(now.getTime() + 6 * HOUR + 1000);
      expect(await tick(now, [orderId])).toEqual([orderId]);
      const next = await run(orderId);
      expect([...last].every((u) => next.has(u))).toBe(true);
      last = next;
    }
    expect((await orderRow(orderId)).deliveryExhaustedAt).not.toBeNull();
    expect(executors.every((u) => last.has(u))).toBe(true);
    expect(await tick(new Date(now.getTime() + 24 * HOUR), [orderId])).toEqual([]);
  } finally {
    review.mockRestore();
    SEMANTIC_POLICY.shortlist = keep;
  }
}, 120000);

it("closed responses, a non-published order and an urgent window", async () => {
  const keep = SEMANTIC_POLICY.shortlist;
  SEMANTIC_POLICY.shortlist = SHORTLIST;
  const review = vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue({ data: { compatible: true, confidence: 0.95, reason: "test" }, provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 });
  try {
    const t0 = new Date(Date.now() - 2 * HOUR);
    // Срочный заказ (через 10 ч): окно — 1 час.
    const urgent = await scenario(t0, new Date(t0.getTime() + 10 * HOUR));
    await run(urgent.orderId);
    expect(await tick(new Date(t0.getTime() + 50 * 60_000), [urgent.orderId])).toEqual([]);
    expect(await tick(new Date(t0.getTime() + HOUR + 1000), [urgent.orderId])).toEqual([urgent.orderId]);

    const closed = await scenario(t0);
    await run(closed.orderId);
    await db.update(schema.orders).set({ responsesClosedAt: new Date() }).where(eq(schema.orders.id, closed.orderId));
    expect(await tick(new Date(t0.getTime() + 7 * HOUR), [closed.orderId])).toEqual([]);

    const negotiating = await scenario(t0);
    await run(negotiating.orderId);
    await db.update(schema.orders).set({ status: "negotiating" }).where(eq(schema.orders.id, negotiating.orderId));
    expect(await tick(new Date(t0.getTime() + 7 * HOUR), [negotiating.orderId])).toEqual([]);
  } finally {
    review.mockRestore();
    SEMANTIC_POLICY.shortlist = keep;
  }
}, 120000);
