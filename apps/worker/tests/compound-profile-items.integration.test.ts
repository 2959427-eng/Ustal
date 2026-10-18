/**
 * Составные сообщения профиля (2026-10-15): одно сообщение → несколько атомарных пунктов с короткой подписью (label)
 * и характеристиками ресурса ({key, value, unit}); изменение/отзыв/восстановление этих пунктов.
 * Настоящий путь: handler (incremental) → persistence → POST /profile/draft/:id/apply → GET /profile + факты документа.
 * AI — fixture (честный и злонамеренный ответ): здесь проверяется поведение сервера, качество извлечения — live-прогоны
 * (docs/evaluations/compound-profile-items-20261015).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { mockProviders } from "@ustal/ai";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
vi.mock("@ustal/queue", async (orig) => ({ ...(await orig<typeof import("@ustal/queue")>()), getBoss: vi.fn(async () => ({ send: vi.fn(async () => "job") })) }));
const { handleProfileExtraction } = await import("../src/handlers/profile-extraction.js");
const { priorFactsFromRows } = await import("../src/semantic.js");
const { isRevokedCapability } = await import("../src/profile-negatives.js");
const profileRoutes = (await import("../../api/src/routes/profile.js")).default;

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const users: string[] = [], cities: string[] = [];
type Item = { id: string; type: string; phrase: string; label?: string };
/** Ответ модели на шаг: факты и removes; ссылки на пункты — по подписи (label) из CURRENT_PROFILE. */
type Reply = { facts: Record<string, unknown>[]; removes?: { type: string; label: string }[] };
let reply: Reply = { facts: [] };
let seenItems: Item[] | undefined;
const wrap = (data: unknown) => ({ data, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 }) as never;
const base = { evidence: "", confidence: 0.95, mandatory: false, constraintType: "none", constraintScope: "whole_task",
  resourceCapacity: { value: null, unit: null, kind: null }, startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null, canonicalKeys: [] as string[] };
const res = (phrase: string, label: string, attributes: unknown[] = [], over: Record<string, unknown> = {}) =>
  ({ ...base, kind: "resource", subjectType: "physical_resource", resourceRole: "available", phrase, label, attributes, ...over });
const skill = (phrase: string, label: string, over: Record<string, unknown> = {}) =>
  ({ ...base, kind: "capability", subjectType: "unspecified", resourceRole: "none", phrase, label, attributes: [], ...over });
const revoke = (phrase: string, over: Record<string, unknown> = {}) =>
  ({ ...base, kind: "exclude", subjectType: "unspecified", resourceRole: "none", constraintType: "exclusion", refusalIntent: "revoke", phrase, label: null, attributes: [], ...over });
const seats = (n: number, unit = "мест") => ({ key: "seats", value: String(n), unit });
/** itemRef по подписи пункта CURRENT_PROFILE (как его видит модель). */
const ref = (label: string) => ({ itemRef: `@${label}` });

beforeAll(async () => {
  app.decorate("authenticate", async (r: import("fastify").FastifyRequest) => { r.userId = r.headers["x-test-user"] as string; });
  await app.register(profileRoutes); await app.ready();
  vi.spyOn(mockProviders.extraction, "extractCapabilityProfile").mockImplementation(async (i) => wrap({ summary: i.text, capabilities: [], resources: [] }));
  vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (input) => {
    const items = (input as { profileItems?: Item[] }).profileItems;
    seenItems = items;
    const idOf = (label: string, type?: string) => items?.find((i) => (i.label ?? i.phrase) === label && (!type || i.type === type))?.id ?? null;
    const facts = reply.facts.map((f) => {
      const r = typeof f.itemRef === "string" && f.itemRef.startsWith("@") ? idOf(f.itemRef.slice(1)) : (f.itemRef ?? null);
      return { ...f, evidence: input.text, ...(items ? { itemRef: r } : {}) };
    });
    const removes = items ? (reply.removes ?? []).map((r) => idOf(r.label, r.type)).filter((x): x is string => !!x) : undefined;
    return wrap({ facts, ...(removes ? { removes } : {}) });
  });
});
afterAll(async () => {
  await app.close();
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});

async function newUser() {
  const [city] = await db.insert(schema.cities).values({ name: "QA_CMP_" + randomUUID(), regionName: "QA", federalDistrict: "QA", timezone: "Asia/Vladivostok", isActive: false }).returning();
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "qa", status: "active" }).returning();
  users.push(u!.id); cities.push(city!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, cityId: city!.id, name: "QA", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
  return u!.id;
}
type Attr = { key: string; value: string | number; unit: string | null };
interface State {
  resources: { label: string; attributes: Attr[] }[];
  skills: string[];
  revoked: string[];
  missing: string[];
  shownResources: string[];
  shownSkills: string[];
}
const fmt = (r: { label: string; attributes: Attr[] }) => [r.label, ...r.attributes.map((a) => `${a.key}=${a.value}${a.unit ?? ""}`)].join(" ");
async function send(userId: string, msg: string, r: Reply): Promise<State> {
  reply = r;
  const [src] = await db.insert(schema.profileSourceInputs).values({ userId, inputType: "text", rawText: msg, status: "confirmed" }).returning();
  const { profileId } = await handleProfileExtraction({ id: randomUUID(), data: { userId, sourceInputId: src!.id } } as never);
  const applied = await app.inject({ method: "POST", url: `/profile/draft/${profileId}/apply`, headers: { "x-test-user": userId, "idempotency-key": randomUUID() } });
  expect(applied.statusCode).toBe(200);
  const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profileId), orderBy: desc(schema.matchingDocuments.processedAt) });
  const facts = priorFactsFromRows(await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc!.id))).filter((x) => (x.kind as string) !== "superseded");
  const isRef = (x: (typeof facts)[number]) => x.kind === "exclude" || x.constraintType === "exclusion";
  const shown = (await app.inject({ method: "GET", url: "/profile", headers: { "x-test-user": userId } })).json() as {
    capabilities: { label: string }[]; resources: { label: string; itemAttributes: Attr[] }[]; unmapped: { kind: string; phrase: string; itemAttributes?: Attr[] }[] };
  return {
    resources: facts.filter((x) => x.kind === "resource" && x.resourceRole === "available").map((x) => ({ label: x.label ?? x.phrase, attributes: (x.attributes ?? []) as Attr[] }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    skills: facts.filter((x) => x.kind === "capability" && !isRef(x)).map((x) => x.label ?? x.phrase).sort(),
    revoked: facts.filter((x) => isRef(x) && isRevokedCapability(x)).map((x) => x.label ?? x.phrase).sort(),
    missing: facts.filter((x) => x.kind === "resource" && x.resourceRole === "missing").map((x) => x.label ?? x.phrase).sort(),
    shownResources: [...shown.resources.map((x) => fmt({ label: x.label, attributes: x.itemAttributes })),
      ...shown.unmapped.filter((x) => x.kind === "resource").map((x) => fmt({ label: x.phrase, attributes: x.itemAttributes ?? [] }))].sort(),
    shownSkills: [...shown.capabilities.map((x) => x.label), ...shown.unmapped.filter((x) => x.kind === "capability").map((x) => x.phrase)].sort(),
  };
}
const BUS = "Есть шестиместный автобус, могу перевозить людей и какие-то вещи";
const busReply: Reply = { facts: [res("шестиместный автобус", "автобус", [seats(6)]), skill("перевозить людей", "Перевозка людей"), skill("перевозить какие-то вещи", "Перевозка вещей.")] };

it("base case: one message → 1 resource with passenger_capacity=6 + 2 skills with short labels; source kept as evidence", async () => {
  const u = await newUser();
  const s = await send(u, BUS, busReply);
  expect(s.resources).toEqual([{ label: "Автобус", attributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }] }]);
  expect(s.skills).toEqual(["Перевозка вещей", "Перевозка людей"]);
  expect(s.shownResources).toEqual(["Автобус passenger_capacity=6pcs"]);
  expect(s.shownSkills).toEqual(["Перевозка вещей", "Перевозка людей"]);
  for (const label of [...s.shownSkills, ...s.shownResources]) expect(label).not.toMatch(/(^|\s)(я|могу|есть|у меня)(\s|$)/i);
  const doc = await db.select({ evidence: schema.matchingFacts.evidence }).from(schema.matchingFacts)
    .innerJoin(schema.matchingDocuments, eq(schema.matchingDocuments.id, schema.matchingFacts.documentId))
    .innerJoin(schema.capabilityProfiles, eq(schema.capabilityProfiles.id, schema.matchingDocuments.profileId))
    .where(eq(schema.capabilityProfiles.userId, u));
  expect(doc.every((d) => d.evidence === BUS)).toBe(true);
});

it("mapped resource: attributes reach GET /profile resources[].itemAttributes (units normalized: тонны → t, «1,5» → 1.5)", async () => {
  const u = await newUser();
  const s = await send(u, "Есть Газель грузоподъёмностью 1,5 тонны, перевожу мебель", { facts: [
    res("Газель грузоподъёмностью 1,5 тонны", "Газель", [{ key: "load_capacity", value: "1,5", unit: "тонны" }], { canonicalKeys: ["van"] }),
    skill("перевожу мебель", "Перевозка мебели")] });
  expect(s.shownResources).toEqual(["Газель payload=1.5t"]);
  expect(s.shownSkills).toEqual(["Перевозка мебели"]);
});

for (const mode of ["honest", "hostile"] as const)
  it(`lifecycle (${mode} AI): update 6→8, sell, restore, skill stays after the sale, unrelated messages change nothing`, async () => {
    const h = mode === "hostile";
    const u = await newUser();
    let s = await send(u, "Есть автобус на 6 мест, могу перевозить людей", { facts: [res("автобус на 6 мест", "Автобус", [seats(6)]), skill("перевозить людей", "Перевозка людей")] });
    expect(s.resources).toEqual([{ label: "Автобус", attributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }] }]);
    // Ничего не значащее сообщение: злонамеренная модель меняет места, отзывает навык, «продаёт» автобус.
    s = await send(u, "Спасибо", h ? { facts: [res("автобус", "Автобус", [seats(12)], ref("Автобус"))], removes: [{ type: "skill", label: "Перевозка людей" }, { type: "resource", label: "Автобус" }] } : { facts: [] });
    expect(s.resources).toEqual([{ label: "Автобус", attributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }] }]);
    expect(s.skills).toEqual(["Перевозка людей"]);
    // Сообщение о другом: модель повторяет автобус с другими местами (echo) — не применяется.
    s = await send(u, "Работаю до 21:00", { facts: [{ ...base, kind: "availability", subjectType: "unspecified", resourceRole: "none", constraintType: "availability", phrase: "работа", label: null, attributes: [], endHour: 21 },
      ...(h ? [res("автобус", "Автобус", [seats(12)], ref("Автобус"))] : [])] });
    expect(s.resources).toEqual([{ label: "Автобус", attributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }] }]);
    // Изменение характеристики того же объекта.
    s = await send(u, "Этот автобус теперь на 8 мест", { facts: [res("автобус", "Автобус", [seats(8)], ref("Автобус"))],
      removes: h ? [{ type: "resource", label: "Автобус" }, { type: "skill", label: "Перевозка людей" }] : [] });
    expect(s.resources).toEqual([{ label: "Автобус", attributes: [{ key: "passenger_capacity", value: 8, unit: "pcs" }] }]);
    expect(s.skills).toEqual(["Перевозка людей"]);
    expect(s.shownResources).toEqual(["Автобус passenger_capacity=8pcs"]);
    // Продал автобус: ресурс отозван, навык перевозки остаётся.
    s = await send(u, "Продал автобус", { facts: [res("автобус", "Автобус", [], { resourceRole: "missing", ...ref("Автобус") })],
      removes: [{ type: "resource", label: "Автобус" }, ...(h ? [{ type: "skill", label: "Перевозка людей" }] : [])] });
    expect(s.resources).toEqual([]);
    expect(s.missing).toEqual(["Автобус"]);
    expect(s.skills).toEqual(["Перевозка людей"]);
    // Посторонний текст: злонамеренная модель «восстанавливает» автобус — отклонено.
    s = await send(u, "Могу копать", { facts: [skill("копать", "Копка"), ...(h ? [res("автобус", "Автобус", [seats(6)], ref("Автобус"))] : [])],
      removes: h ? [{ type: "no_resource", label: "Автобус" }] : [] });
    expect(s.resources).toEqual([]);
    expect(s.skills).toEqual(["Копка", "Перевозка людей"]);
    // Снова есть автобус: восстановлен тот же пункт (без дубля), характеристики из нового сообщения.
    s = await send(u, "Снова есть автобус на 6 мест", { facts: [res("автобус на 6 мест", h ? "Микроавтобус" : "Автобус", [seats(6)], ref("Автобус"))],
      removes: [{ type: "no_resource", label: "Автобус" }] });
    expect(s.resources).toEqual([{ label: "Автобус", attributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }] }]);
    expect(s.missing).toEqual([]);
    // Сообщение только про автобус: злонамеренная модель отзывает «копать» — отклонено.
    s = await send(u, "Автобус белый", { facts: [], ...(h ? { removes: [{ type: "skill", label: "Копка" }] } : {}) });
    expect(s.skills).toEqual(["Копка", "Перевозка людей"]);
    // Отзыв навыка другими словами: связь — ссылка модели + упоминание пункта («людей»).
    s = await send(u, "Больше не вожу людей", { facts: [revoke("перевозка людей", ref("Перевозка людей"))], removes: [{ type: "skill", label: "Перевозка людей" }] });
    expect(s.skills).toEqual(["Копка"]);
    expect(s.revoked).toEqual(["Перевозка людей"]);
    expect(s.resources).toEqual([{ label: "Автобус", attributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }] }]);
  }, 60_000);

it("several resources of one kind: «есть грузовая машина» is not merged; «ещё одна» is a second item; «этот» with two candidates is ambiguous", async () => {
  const u = await newUser();
  let s = await send(u, "Есть машина", { facts: [res("машина", "Машина")] });
  // Уточнение того же объекта — явная отсылка «эта».
  s = await send(u, "Эта машина грузовая, грузоподъёмность 5 тонн", { facts: [res("машина грузовая", "Грузовая машина", [{ key: "payload", value: 5, unit: "тонн" }], ref("Машина"))] });
  expect(s.resources).toEqual([{ label: "Грузовая машина", attributes: [{ key: "payload", value: 5, unit: "t" }] }]);
  // Без отсылки — возможно, другая машина: отдельный пункт, прежний не меняется.
  const v = await newUser();
  await send(v, "Есть машина", { facts: [res("машина", "Машина")] });
  s = await send(v, "Есть грузовая машина 5 тонн", { facts: [res("грузовая машина 5 тонн", "Грузовая машина", [{ key: "payload", value: 5, unit: "т" }], ref("Машина"))] });
  expect(s.resources).toEqual([{ label: "Грузовая машина", attributes: [{ key: "payload", value: 5, unit: "t" }] }, { label: "Машина", attributes: [] }]);
  // «Ещё одна машина» — второй пункт, а повтор той же машины — no-op.
  const w = await newUser();
  await send(w, "Есть машина", { facts: [res("машина", "Машина")] });
  s = await send(w, "Есть ещё одна машина", { facts: [res("машина", "Машина", [], ref("Машина")), res("ещё одна машина", "Машина")] });
  expect(s.resources.map((r) => r.label)).toEqual(["Машина", "Машина 2"]);
  // Два автобуса и «этот автобус» — неясно какой: ничего не меняется.
  const x = await newUser();
  await send(x, "Есть автобус на 6 мест", { facts: [res("автобус на 6 мест", "Автобус", [seats(6)])] });
  await send(x, "Есть ещё один автобус на 20 мест", { facts: [res("автобус на 20 мест", "Автобус", [seats(20)])] });
  s = await send(x, "Этот автобус теперь на 8 мест", { facts: [res("автобус", "Автобус", [seats(8)], ref("Автобус"))] });
  expect(s.resources).toEqual([{ label: "Автобус", attributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }] },
    { label: "Автобус 2", attributes: [{ key: "passenger_capacity", value: 20, unit: "pcs" }] }]);
  expect(seenItems?.some((i) => i.label === "Автобус 2")).toBe(true);
}, 60_000);
