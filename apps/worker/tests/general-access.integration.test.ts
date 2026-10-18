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
 * «Простые задачи» (2026-10-15): заказ general без явных требований показывается и тем, кто его не получил обычным
 * подбором (в том числе без профиля навыков), кроме людей с относящимся к заказу отказом/ограничением. Это путь
 * показа, не вердикт: обычный подбор, его уровни и прочие заказы не меняются. Fixture AI.
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
beforeEach(() => {
  refusalCalls.length = 0;
  refusalCheck = () => false;
  vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue({ data: { compatible: false, confidence: 0.95, reason: "нет подтверждённого опыта",
    hardConflict: { kind: "domain", profileEvidence: "x", orderEvidence: "y" } }, provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 } as never);
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
async function order(cityId: string, author: string, text: string, access: Access | null, nodes: string[] = [], desiredAt: Date | null = null) {
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId, sourceText: text, status: "published", riskLevel: 0, publishedAt: new Date(), desiredAt }).returning();
  await db.insert(schema.orderAiExtractions).values({ orderId: o!.id, extractionVersion: "v1", rawResult: { regulated: false, requiresQualification: false, actions: [], access: access && { ...access, version: "order-access-v1" } } });
  const [doc] = await db.insert(schema.matchingDocuments).values({ orderId: o!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: vec(0) }).returning();
  await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: "capability", phrase: text, evidence: text, nodeIds: nodes, confidence: "1", mandatory: false, embedding: vec(0) });
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

it("general order: people without a skills profile and with an empty profile get it as a simple task; specialized and requirement orders do not", async () => {
  const c = await city();
  const author = await person(c), noProfile = await person(c), empty = await person(c);
  await profile(empty, "Я студентка", []);
  const boxes = await order(c, author, "Помочь перенести несколько коробок, работа примерно на час", GENERAL);
  const r = await run(boxes);
  for (const u of [noProfile, empty]) {
    expect(r.byUser.get(u)).toMatchObject({ matchType: "opportunity", explanation: "Простая задача — опыт не нужен" });
    expect(r.byUser.get(u)!.breakdown).toMatchObject({ path: "general_access", accessLevel: "general", accessVersion: "order-access-v1" });
    expect((await feed(u)).find((i) => i.orderId === boxes)).toMatchObject({ matchType: "opportunity" });
  }
  // Аудит: у оценённого обычным подбором — пометка в его trace; у не оценённого — отдельная trace.
  expect(r.traces.find((t) => t.userId === empty)!.detail).toMatchObject({ general_access: { path: "general_access" } });
  expect(r.traces.find((t) => t.userId === noProfile)).toMatchObject({ decision: "general_access" });

  const panel = await order(c, author, "Подключить трёхфазный электрощит", { accessLevel: "specialized", explicitRequirements: [], reason: "электрика" });
  expect((await run(panel)).byUser.size).toBe(0);
  const req = await order(c, author, "Посидеть с ребёнком, нужен опыт работы няней от 3 лет", { ...GENERAL, explicitRequirements: [{ kind: "experience", evidence: "опыт работы няней от 3 лет" }] });
  expect((await run(req)).byUser.size).toBe(0);
  const unclassified = await order(c, author, "Помочь перенести коробки", null);
  expect((await run(unclassified)).byUser.size).toBe(0);
}, 60000);

it("a refusal that concerns the order, a failed refusal check, a time limit and an «only …» scope stop the simple task for that person only", async () => {
  const c = await city();
  const author = await person(c), noKids = await person(c), noLifting = await person(c), failing = await person(c),
    evening = await person(c), onlyIt = await person(c), free = await person(c);
  await profile(noKids, "Не работаю с детьми", [{ kind: "exclude", phrase: "работа с детьми", constraintType: "exclusion" }]);
  await profile(noLifting, "Без физической работы", [{ kind: "exclude", phrase: "физическая работа", constraintType: "exclusion" }]);
  await profile(failing, "Не мою окна", [{ kind: "exclude", phrase: "мытьё окон", constraintType: "exclusion" }]);
  await profile(evening, "Работаю до 18:00", [{ kind: "availability", phrase: "работа", constraintType: "availability", endHour: 18 }]);
  await profile(onlyIt, "Беру только IT-задачи", [{ kind: "capability", phrase: "IT-задачи", constraintType: "scope" }]);
  await profile(free, "Ищу подработку", []);
  refusalCheck = (refusal) => refusal === "Не мою окна" ? "fail" : refusal === "Не работаю с детьми";
  // 20:00 по Владивостоку
  const at = new Date("2026-11-02T10:00:00Z");
  const kid = await order(c, author, "Посидеть с ребёнком 9 лет два часа", GENERAL, [], at);
  const r = await run(kid);
  expect([...r.byUser.keys()].sort()).toEqual([free, noLifting].sort());
  expect(r.byUser.get(noLifting)!.breakdown).toMatchObject({ refusalsChecked: [{ refusal: "физическая работа", involves: false }] });
  const refused = (u: string) => (r.traces.find((t) => t.userId === u)!.detail as { general_access?: { refusedBy?: string } }).general_access?.refusedBy;
  expect(refused(noKids)).toBe("refusal:работа с детьми");
  expect(refused(failing)).toBe("refusal_check_failed");
  expect(refused(evening)).toMatch(/outside_availability/);
  expect(refused(onlyIt)).toMatch(/only_scope|scope_mismatch/);
  // Проверка отказа — только у людей с отказами; у остальных AI не вызывается.
  expect(refusalCalls.sort()).toEqual(["Без физической работы", "Не мою окна", "Не работаю с детьми"].sort());

  refusalCheck = (refusal) => refusal === "Без физической работы";
  const boxes = await order(c, author, "Помочь загрузить несколько коробок в машину", GENERAL);
  const b = await run(boxes);
  expect(b.byUser.has(noLifting)).toBe(false);
  expect(b.byUser.has(noKids)).toBe(true);
}, 60000);

it("explicit fit keeps its level and ranks above simple tasks; demographic wording changes nothing", async () => {
  const c = await city();
  const node = await nodeId("cleaning");
  const author = await person(c), cleaner = await person(c);
  await profile(cleaner, "Делаю уборку", [{ kind: "capability", phrase: "уборка", nodes: [node] }], vec(0, 0.1, 5));
  const people: string[] = [];
  for (const text of ["Я студентка", "Я студент", "Я пенсионерка", "Я менеджер", "Я мама в декрете"]) {
    const u = await person(c);
    await profile(u, text, [{ kind: "capability", phrase: text.replace("Я ", ""), constraintType: "none" }], vec(7));
    people.push(u);
  }
  vi.spyOn(mockProviders.extraction, "reviewSemantic").mockImplementation(async (input) => ({ data: input.profile.join(" ").includes("уборк") && input.order.join(" ").includes("уборк")
    ? { compatible: true, confidence: 0.95, reason: "уборка" }
    : { compatible: false, confidence: 0.95, reason: "нет опыта", hardConflict: { kind: "domain", profileEvidence: "x", orderEvidence: "y" } },
    provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 }) as never);
  const tidy = await order(c, author, "Простая уборка комнаты", GENERAL, [node]);
  const r = await run(tidy);
  expect(r.byUser.get(cleaner)!.matchType).toBe("exact");
  expect(people.map((u) => r.byUser.get(u)?.matchType)).toEqual(Array(5).fill("opportunity"));
  const items = await feed(cleaner);
  expect(items.find((i) => i.orderId === tidy)!.matchType).toBe("exact");
  // В ленте человека: заказ по навыкам выше простой задачи.
  const other = await order(c, author, "Помочь донести пакеты до подъезда", GENERAL);
  await run(other);
  const mine = (await feed(cleaner)).filter((i) => [tidy, other].includes(i.orderId)).map((i) => i.matchType);
  expect(mine).toEqual(["exact", "opportunity"]);
  const specialized = await order(c, author, "Ремонт квартиры под ключ", { accessLevel: "specialized", explicitRequirements: [], reason: "проект" });
  const s = await run(specialized);
  expect(people.map((u) => s.byUser.has(u))).toEqual(Array(5).fill(false));
}, 60000);

it("rotation: when places are scarce, the next simple order goes first to people who got fewer simple tasks; earlier recipients keep an order", async () => {
  const keep = SEMANTIC_POLICY.shortlist;
  SEMANTIC_POLICY.shortlist = 2;
  try {
    const c = await city();
    const author = await person(c);
    const pool = [await person(c), await person(c), await person(c), await person(c)];
    const first = await order(c, author, "Раздать листовки у метро", GENERAL);
    const a = await run(first);
    expect(a.byUser.size).toBe(2);
    const second = await order(c, author, "Постоять в очереди за документами", GENERAL);
    const b = await run(second);
    expect([...b.byUser.keys()].sort()).toEqual(pool.filter((u) => !a.byUser.has(u)).sort());
    // Повторный прогон первого заказа (например, изменился чей-то профиль) — те же получатели.
    // Кэш прогона сброшен — подбор считается заново, а не возвращается прежний снимок.
    await db.update(schema.matchingRuns).set({ inputHash: null }).where(eq(schema.matchingRuns.id, a.runId));
    const again = await handleMatchingRun({ id: randomUUID(), data: { orderId: first } } as never);
    expect("matchingRunId" in again && again.matchingRunId).not.toBe(a.runId);
    const latest = await db.query.matchingRuns.findFirst({ where: eq(schema.matchingRuns.orderId, first), orderBy: (t, { desc }) => desc(t.startedAt) });
    const kept = (await db.select().from(schema.matchingCandidates).where(eq(schema.matchingCandidates.matchingRunId, latest!.id))).map((x) => x.userId).sort();
    expect(kept).toEqual([...a.byUser.keys()].sort());
  } finally {
    SEMANTIC_POLICY.shortlist = keep;
  }
}, 60000);
