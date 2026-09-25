import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import responsesRoutes from "./responses.js";
import contactsRoutes from "./contacts.js";
import assignmentsRoutes from "./assignments.js";
import usersRoutes from "./users.js";

// Targeted-аудит ЭТАП 2 переговоров (2026-09-22): теперь на одном заказе
// может быть несколько `selected`-кандидатов одновременно — это НОВАЯ
// поверхность атаки, которой не было при единственном исполнителе (раньше
// "изоляция кандидатов" была неактуальна, т.к. второго кандидата просто не
// существовало). Этот файл проверяет, что кандидат A не может читать/менять
// данные кандидата B (отклик, назначение, контакты, профиль) и что списковые
// эндпоинты не отдают лишние PII-поля.
vi.mock("../lib/notify.js", () => ({ notifyUser: vi.fn(async () => "n") }));

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
const orderIds: string[] = [];
let cityId: string;

const as = (user: string) => ({ "x-test-user": user });

async function makeUser(label: string) {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  userIds.push(u!.id);
  await db.insert(schema.userProfiles).values({
    userId: u!.id, name: `TEST ${label}`, cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
  });
  return u!.id;
}

/** Заказ (published) + два отклика + раскрытые контакты + оба кандидата "selected". */
async function makeTwoSelectedCandidates(authorId: string, execA: string, execB: string) {
  const [o] = await db.insert(schema.orders).values({ authorId, cityId, sourceText: "TEST isolation order", status: "published" }).returning();
  orderIds.push(o!.id);
  const orderId = o!.id;

  const createdA = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(execA), payload: { comment: "A comment" } });
  expect(createdA.statusCode).toBe(201);
  const responseA = createdA.json().id as string;
  const createdB = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(execB), payload: { comment: "B comment" } });
  expect(createdB.statusCode).toBe(201);
  const responseB = createdB.json().id as string;

  for (const rid of [responseA, responseB]) {
    const unlock = await app.inject({ method: "POST", url: `/orders/${orderId}/contact-unlocks`, headers: as(authorId), payload: { responseId: rid } });
    expect([200, 201]).toContain(unlock.statusCode);
  }

  const pickA = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(authorId), payload: { responseId: responseA } });
  expect(pickA.statusCode).toBe(201);
  const assignmentA = pickA.json().id as string;
  const pickB = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(authorId), payload: { responseId: responseB } });
  expect(pickB.statusCode).toBe(201);
  const assignmentB = pickB.json().id as string;

  return { orderId, responseA, responseB, assignmentA, assignmentB };
}

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  for (const r of [responsesRoutes, contactsRoutes, assignmentsRoutes, usersRoutes]) await app.register(r);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST negotiation-isolation", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id;
  cityIds.push(cityId);
});

afterAll(async () => {
  const allOrders = await db.query.orders.findMany({ where: inArray(schema.orders.authorId, userIds) });
  const allOrderIds = [...new Set([...orderIds, ...allOrders.map((o) => o.id)])];
  if (allOrderIds.length) {
    await db.delete(schema.orderAssignments).where(inArray(schema.orderAssignments.orderId, allOrderIds));
    await db.delete(schema.contactUnlocks).where(inArray(schema.contactUnlocks.orderId, allOrderIds));
    await db.delete(schema.responses).where(inArray(schema.responses.orderId, allOrderIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, allOrderIds));
  }
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

it("1. изоляция контактов: кандидат A не может получить контакты кандидата B (и наоборот)", async () => {
  const author = await makeUser("iso1-a");
  const execA = await makeUser("iso1-ea");
  const execB = await makeUser("iso1-eb");
  const { orderId } = await makeTwoSelectedCandidates(author, execA, execB);

  const aViewsB = await app.inject({ method: "GET", url: `/orders/${orderId}/contacts/${execB}`, headers: as(execA) });
  const bViewsA = await app.inject({ method: "GET", url: `/orders/${orderId}/contacts/${execA}`, headers: as(execB) });
  expect(aViewsB.statusCode).toBe(404);
  expect(bViewsA.statusCode).toBe(404);
});

it("2. изоляция откликов: кандидат A не может читать/менять/отзывать отклик кандидата B", async () => {
  const author = await makeUser("iso2-a");
  const execA = await makeUser("iso2-ea");
  const execB = await makeUser("iso2-eb");
  const { responseB } = await makeTwoSelectedCandidates(author, execA, execB);

  const patchAttempt = await app.inject({ method: "PATCH", url: `/responses/${responseB}`, headers: as(execA), payload: { comment: "hacked by A" } });
  expect(patchAttempt.statusCode).toBe(404);
  const deleteAttempt = await app.inject({ method: "DELETE", url: `/responses/${responseB}`, headers: as(execA) });
  expect(deleteAttempt.statusCode).toBe(404);

  const stillB = await db.query.responses.findFirst({ where: eq(schema.responses.id, responseB) });
  expect(stillB?.comment).toBe("B comment");
  expect(stillB?.status).toBe("active");
});

it("3. изоляция назначений: кандидат A не может вызвать start/cancel на assignment кандидата B", async () => {
  const author = await makeUser("iso3-a");
  const execA = await makeUser("iso3-ea");
  const execB = await makeUser("iso3-eb");
  const { orderId, assignmentB } = await makeTwoSelectedCandidates(author, execA, execB);

  const startAttempt = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentB}/start`, headers: as(execA), payload: {} });
  expect(startAttempt.statusCode).toBe(404);
  const cancelAttempt = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentB}/cancel`, headers: as(execA), payload: {} });
  expect(cancelAttempt.statusCode).toBe(404);

  const stillB = await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.id, assignmentB) });
  expect(stillB?.status).toBe("selected");
});

it("4. изоляция executor-report: кандидат A не может отметить статус по assignment кандидата B", async () => {
  const author = await makeUser("iso4-a");
  const execA = await makeUser("iso4-ea");
  const execB = await makeUser("iso4-eb");
  const { orderId, assignmentB } = await makeTwoSelectedCandidates(author, execA, execB);

  const reportAttempt = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments/${assignmentB}/executor-report-completed`,
    headers: as(execA),
    payload: {},
  });
  expect(reportAttempt.statusCode).toBe(404);
});

it("5. приватность: список откликов автору не отдаёт телефон/WhatsApp кандидатов", async () => {
  const author = await makeUser("iso5-a");
  const execA = await makeUser("iso5-ea");
  const execB = await makeUser("iso5-eb");
  const { orderId } = await makeTwoSelectedCandidates(author, execA, execB);

  const list = await app.inject({ method: "GET", url: `/orders/${orderId}/responses`, headers: as(author) });
  expect(list.statusCode).toBe(200);
  const items = list.json().items as Array<Record<string, unknown>>;
  expect(items.length).toBe(2);
  for (const item of items) {
    expect(Object.keys(item)).not.toContain("phone");
    expect(Object.keys(item)).not.toContain("whatsappPhone");
    expect(Object.keys(item)).not.toContain("email");
    // оба кандидата selected → оба должны быть видны с корректным assignmentStatus
    expect(["selected"]).toContain(item.assignmentStatus);
    expect(item.isContactUnlocked).toBe(true);
  }
});

it("6. изоляция профиля: кандидат A не может открыть карточку кандидата B через GET /users/{id}", async () => {
  const author = await makeUser("iso6-a");
  const execA = await makeUser("iso6-ea");
  const execB = await makeUser("iso6-eb");
  const { orderId } = await makeTwoSelectedCandidates(author, execA, execB);

  const profileAttempt = await app.inject({ method: "GET", url: `/users/${execB}?orderId=${orderId}`, headers: as(execA) });
  expect(profileAttempt.statusCode).toBe(404);
});

it("7. контакты: оба одновременно selected кандидата получают доступ к контакту заказчика (не друг к другу)", async () => {
  const author = await makeUser("iso7-a");
  const execA = await makeUser("iso7-ea");
  const execB = await makeUser("iso7-eb");
  const { orderId } = await makeTwoSelectedCandidates(author, execA, execB);

  const aViewsAuthor = await app.inject({ method: "GET", url: `/orders/${orderId}/contacts/${author}`, headers: as(execA) });
  const bViewsAuthor = await app.inject({ method: "GET", url: `/orders/${orderId}/contacts/${author}`, headers: as(execB) });
  expect(aViewsAuthor.statusCode).toBe(200);
  expect(bViewsAuthor.statusCode).toBe(200);
  expect(typeof aViewsAuthor.json().phone).toBe("string");
  expect(typeof bViewsAuthor.json().phone).toBe("string");
});
