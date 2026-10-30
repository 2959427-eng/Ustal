import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { SEMANTIC_POLICY } from "@ustal/matching";
import { handleMatchingRun } from "../src/handlers/matching-run.js";
import feedRoutes from "../../api/src/routes/feed.js";
// Variant B: this file asserts which refusal checks reach the AI, with fixed texts reused across test runs on the
// same DB; memoization of these checks is covered by tests/ai-review-cache.integration.test.ts.
vi.mock("../src/ai-review-cache.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai-review-cache.js")>()),
  readCachedReview: async () => null, storeCachedReview: async (_key: string, _identity: unknown, result: unknown) => result }));
assertLocalTestDatabase();

/**
 * False positive 2026-10-30 (production): «Я студент, хочу иногда подрабатывать, больше ничего нет» получил специализированный
 * «Нужно сделать сайт» обычным подбором (probable, review compatible). Проверяем проводку исправления на реальной БД:
 *  - профиль только со статусом/намерением («Студент», «хочу подрабатывать») не проходит «по смыслу» даже при
 *    ошибочно положительном review (детерминированно, без изменений review/промптов);
 *  - профиль без навыков и ресурсов не проходит «по смыслу» только из-за требования-ресурса заказа;
 *  - простые задачи (упаковка, листовки) по-прежнему приходят путём general access, даже если обычный подбор отклонил;
 *  - смежная профессия на специализированный заказ по-прежнему проходит, если review подтверждает.
 * Fixture AI: review подставляется тестом (в т.ч. ошибочно положительный, как в production).
 */
const db = getDb(), users: string[] = [], cities: string[] = [];
const app = Fastify();
let appReady = false;
afterAll(async () => {
  if (users.length) { await db.delete(schema.orders).where(inArray(schema.orders.authorId, users)); await db.delete(schema.users).where(inArray(schema.users.id, users)); }
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await app.close();
  await getSql().end();
});
const vec = (i: number, noise = 0, j = 0) => Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : k === j && noise ? noise : 0));
const nodeId = async (key: string) => (await db.query.ontologyNodes.findFirst({ where: eq(schema.ontologyNodes.canonicalKey, key) }))!.id;
let refusalCheck: (refusal: string) => boolean | "fail" = () => false;
const refusalCalls: string[] = [];
type ReviewIn = { profile: string[]; order: string[] };
const reviewInputs: ReviewIn[] = [];
const domain = { compatible: false, confidence: 0.95, reason: "другая область", hardConflict: { kind: "domain" as const, profileEvidence: "x", orderEvidence: "y" } };
const positive = { compatible: true, confidence: 0.8, reason: "может подойти", hardConflict: null };
let reviewVerdict: (input: ReviewIn) => object = () => domain;
beforeEach(() => {
  refusalCalls.length = 0;
  refusalCheck = () => false;
  reviewInputs.length = 0;
  vi.spyOn(mockProviders.extraction, "reviewSemantic").mockImplementation(async (input) => {
    reviewInputs.push(input);
    return { data: reviewVerdict(input), provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 } as never;
  });
  vi.spyOn(mockProviders.extraction, "checkRefusal").mockImplementation(async (input) => {
    refusalCalls.push(input.refusal);
    const v = refusalCheck(input.refusal);
    if (v === "fail") throw new Error("provider timeout");
    return { data: { involves: v, reason: "test" }, provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 };
  });
});

async function city() {
  const [c] = await db.insert(schema.cities).values({ name: "TEST_general_" + randomUUID(), regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cities.push(c!.id);
  return c!.id;
}
async function person(cityId: string) {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "test-only", status: "active" }).returning();
  users.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, cityId, name: "TEST", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
  return u!.id;
}
type F = { kind: string; phrase: string; nodes?: string[]; constraintType?: string; constraintScope?: string; endHour?: number };
/** Применённый профиль с фактами (без фактов — «ничего о себе не рассказал», но профиль есть). */
async function profile(userId: string, text: string, facts: F[], v = vec(9)) {
  const [p] = await db.insert(schema.capabilityProfiles).values({ userId, summary: text, profileVersion: 1, extractionVersion: "test", status: "applied" }).returning();
  await db.insert(schema.profileEmbeddings).values({ capabilityProfileId: p!.id, embeddingModel: "test", embedding: v });
  const [doc] = await db.insert(schema.matchingDocuments).values({ profileId: p!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: v }).returning();
  for (const f of facts) {
    await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: f.kind, phrase: f.phrase, evidence: text, nodeIds: f.nodes ?? [], confidence: "1", mandatory: false,
      constraintType: f.constraintType ?? "none", constraintScope: f.constraintScope ?? "whole_task", endHour: f.endHour ?? null, embedding: v });
    for (const n of f.kind === "capability" ? f.nodes ?? [] : []) await db.insert(schema.userCapabilities).values({ capabilityProfileId: p!.id, ontologyNodeId: n, label: f.phrase, evidenceType: "explicit", confidence: "1" });
  }
}
type Access = { accessLevel: "general" | "trained" | "specialized" | "regulated"; explicitRequirements: { kind: string; evidence: string }[]; reason: string };
async function order(cityId: string, author: string, text: string, access: Access | null, nodes: string[] = [], desiredAt: Date | null = null, opts: { qualification?: boolean; resource?: string } = {}) {
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId, sourceText: text, status: "published", riskLevel: 0, publishedAt: new Date(), desiredAt }).returning();
  await db.insert(schema.orderAiExtractions).values({ orderId: o!.id, extractionVersion: "v1", rawResult: { regulated: false, requiresQualification: opts.qualification ?? false, actions: [], access: access && { ...access, version: "order-access-v1" } } });
  const [doc] = await db.insert(schema.matchingDocuments).values({ orderId: o!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: vec(0) }).returning();
  await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: "capability", phrase: text, evidence: text, nodeIds: nodes, confidence: "1", mandatory: false, embedding: vec(0) });
  if (opts.resource) await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: "resource", phrase: opts.resource, evidence: text, nodeIds: [],
    confidence: "1", mandatory: true, resourceRole: "required", embedding: vec(3) });
  return o!.id;
}
const GENERAL: Access = { accessLevel: "general", explicitRequirements: [], reason: "простая задача" };
async function run(orderId: string) {
  const r = await handleMatchingRun({ id: randomUUID(), data: { orderId } } as never);
  if (!("matchingRunId" in r)) throw new Error("no run");
  const candidates = await db.select().from(schema.matchingCandidates).where(eq(schema.matchingCandidates.matchingRunId, r.matchingRunId));
  const traces = await db.select().from(schema.matchingTraces).where(eq(schema.matchingTraces.matchingRunId, r.matchingRunId));
  return { byUser: new Map(candidates.map((c) => [c.userId, c])), traces, runId: r.matchingRunId };
}
async function feed(userId: string) {
  if (!appReady) {
    app.decorate("authenticate", async (r: import("fastify").FastifyRequest) => { r.userId = r.headers["x-test-user"] as string; });
    await app.register(feedRoutes); await app.ready(); appReady = true;
  }
  return ((await app.inject({ method: "GET", url: "/feed", headers: { "x-test-user": userId } })).json().items as { orderId: string; matchType: string; explanation: string }[]);
}

const SPECIALIZED: Access = { accessLevel: "specialized", explicitRequirements: [{ kind: "experience", evidence: "сделать сайт" }, { kind: "portfolio", evidence: "примеры работ" }], reason: "разработка сайта" };
const STUDENT = "Я студент, хочу иногда подрабатывать, больше ничего нет";

it("студент → сайт: REJECT даже при AI compatible; упаковка и листовки приходят простой задачей", async () => {
  const c = await city();
  const author = await person(c), ilya = await person(c);
  // Старый (уже применённый) профиль: факты не переобрабатываются, защита срабатывает при подборе.
  await profile(ilya, STUDENT, [{ kind: "capability", phrase: "Студент" }, { kind: "capability", phrase: "Хочу иногда подрабатывать" }]);
  // Как в production: review ошибочно compatible для сайта; для простых задач — другая область.
  reviewVerdict = (input) => input.order[0]!.includes("сайт") ? positive : domain;
  const site = await order(c, author, "Нужно сделать сайт для магазина, пришлите примеры работ", SPECIALIZED, [], null, { qualification: true });
  const s = await run(site);
  expect(s.byUser.get(ilya)).toBeUndefined();
  expect(s.traces.find((t) => t.userId === ilya)!.detail).toMatchObject({ reason: "insufficient_capability_evidence" });

  for (const text of ["Нужна упаковка товаров на складе, 3 часа", "Раздать листовки у торгового центра"]) {
    reviewInputs.length = 0;
    const id = await order(c, author, text, GENERAL);
    const r = await run(id);
    // Обычный подбор отклонил (review: другая область), простая задача всё равно доставлена.
    expect(r.byUser.get(ilya)).toMatchObject({ matchType: "opportunity", explanation: "Простая задача — опыт не нужен" });
    expect((await feed(ilya)).find((i) => i.orderId === id)).toMatchObject({ matchType: "opportunity" });
  }
}, 60000);

it("профиль без навыков и ресурсов не получает специализированный заказ только из-за требования-ресурса заказа", async () => {
  const c = await city();
  const author = await person(c), empty = await person(c);
  await profile(empty, STUDENT, []);
  reviewVerdict = () => positive; // даже если review ошибочно положителен
  const site = await order(c, author, "Нужно сделать сайт, нужен свой компьютер", SPECIALIZED, [], null, { qualification: true, resource: "компьютер" });
  const r = await run(site);
  expect(r.byUser.get(empty)).toBeUndefined();
}, 60000);

it("recall: смежная профессия, «Студент, делаю сайты», интернет-реклама и ресурс-только профиль сохраняются", async () => {
  const c = await city();
  const author = await person(c), dev = await person(c), driver = await person(c), webStudent = await person(c), sergey = await person(c);
  await profile(dev, "Программист, пишу на Python", [{ kind: "capability", phrase: "Программист" }]);
  await profile(driver, "Есть газель", [{ kind: "resource", phrase: "газель" }]);
  await profile(webStudent, "Студент, делаю сайты", [{ kind: "capability", phrase: "Студент, делаю сайты" }]);
  await profile(sergey, "Настраиваю интернет-рекламу", [{ kind: "capability", phrase: "Настраиваю интернет-рекламу" }]);
  reviewVerdict = () => positive;
  const site = await order(c, author, "Нужно сделать сайт для магазина", SPECIALIZED, [], null, { qualification: true });
  const siteRun = await run(site);
  expect(siteRun.byUser.get(dev)).toMatchObject({ matchType: "probable" });
  expect(siteRun.byUser.get(webStudent)).toMatchObject({ matchType: "probable" });
  const bloggers = await order(c, author, "Найти блогеров для рекламы магазина", { ...SPECIALIZED, reason: "реклама" }, [], null, { qualification: true });
  expect((await run(bloggers)).byUser.get(sergey)).toMatchObject({ matchType: "probable" });
  const move = await order(c, author, "Перевезти мебель, нужна своя машина", { ...SPECIALIZED, reason: "перевозка" }, [], null, { qualification: true, resource: "грузовой автомобиль" });
  expect((await run(move)).byUser.get(driver)).toMatchObject({ matchType: "probable" });
}, 60000);
