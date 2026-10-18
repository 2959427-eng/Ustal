import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import responsesRoutes from "./responses.js";
import contactsRoutes from "./contacts.js";
import assignmentsRoutes from "./assignments.js";

// ЭТАП 2 переговоров (2026-09-22, по итогам negotiation-architecture-audit):
// несколько кандидатов теперь могут быть `selected` одновременно; «Договорились»
// (POST .../start) должно гарантированно оставлять максимум одного `in_progress`
// исполнителя на заказ, а остальные `selected` — становиться терминальными
// (`cancelled`) и немедленно терять доступ к контактам. Этот файл — конкурентные
// (Promise.all) regression-тесты именно на эти новые инварианты, с проверкой
// фактического состояния в БД, а не только HTTP-кода. Существующие тесты из
// первого/второго security-прохода (order-lifecycle-race.integration.test.ts,
// assignments-flow.integration.test.ts) продолжают проходить отдельно.
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

/** Заказ (published) + N откликов + раскрытые контакты для каждого. */
async function makeOrderWithCandidates(authorId: string, executorIds: string[]) {
  const [o] = await db.insert(schema.orders).values({ authorId, cityId, sourceText: "TEST negotiation race", status: "published" }).returning();
  orderIds.push(o!.id);
  const responseIds: string[] = [];
  for (const execId of executorIds) {
    const created = await app.inject({ method: "POST", url: `/orders/${o!.id}/responses`, headers: as(execId), payload: {} });
    expect(created.statusCode).toBe(201);
    const responseId = created.json().id as string;
    const unlock = await app.inject({ method: "POST", url: `/orders/${o!.id}/contact-unlocks`, headers: as(authorId), payload: { responseId } });
    expect([200, 201]).toContain(unlock.statusCode);
    responseIds.push(responseId);
  }
  return { orderId: o!.id, responseIds };
}

async function select(authorId: string, orderId: string, responseId: string) {
  const pick = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(authorId), payload: { responseId } });
  expect(pick.statusCode).toBe(201);
  return pick.json().id as string;
}

const orderRow = async (orderId: string) => db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
const assignmentsOf = async (orderId: string) => db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.orderId, orderId) });
const contactOpen = async (viewerId: string, otherId: string, orderId: string) =>
  app.inject({ method: "GET", url: `/orders/${orderId}/contacts/${otherId}`, headers: as(viewerId) });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  for (const r of [responsesRoutes, contactsRoutes, assignmentsRoutes]) await app.register(r);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST negotiation-race", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
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

it("1. выбор двух разных кандидатов — оба selected и оба получают доступ к контактам", async () => {
  const author = await makeUser("mc1-a");
  const exec1 = await makeUser("mc1-e1");
  const exec2 = await makeUser("mc1-e2");
  const { orderId, responseIds } = await makeOrderWithCandidates(author, [exec1, exec2]);

  const a1 = await select(author, orderId, responseIds[0]!);
  const a2 = await select(author, orderId, responseIds[1]!);

  const assignments = await assignmentsOf(orderId);
  expect(assignments.length).toBe(2);
  expect(assignments.every((a) => a.status === "selected")).toBe(true);
  expect(await (await orderRow(orderId))?.status).toBe("negotiating");

  const c1 = await contactOpen(author, exec1, orderId);
  const c2 = await contactOpen(author, exec2, orderId);
  expect(c1.statusCode).toBe(200);
  expect(c2.statusCode).toBe(200);
  void a1;
  void a2;
});

it("2. два параллельных /start на двух РАЗНЫХ кандидатов одного заказа — ровно один in_progress, проигравший НЕ становится активным и получает 409", async () => {
  const author = await makeUser("mc2-a");
  const exec1 = await makeUser("mc2-e1");
  const exec2 = await makeUser("mc2-e2");
  const { orderId, responseIds } = await makeOrderWithCandidates(author, [exec1, exec2]);
  const a1 = await select(author, orderId, responseIds[0]!);
  const a2 = await select(author, orderId, responseIds[1]!);

  const [r1, r2] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${a1}/start`, headers: as(author), payload: {} }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${a2}/start`, headers: as(author), payload: {} }),
  ]);
  const codes = [r1.statusCode, r2.statusCode].sort();
  expect(codes).toEqual([200, 409]);

  const assignments = await assignmentsOf(orderId);
  const inProgress = assignments.filter((a) => a.status === "in_progress");
  const cancelled = assignments.filter((a) => a.status === "cancelled");
  const stillSelected = assignments.filter((a) => a.status === "selected");
  // Инвариант: не более одного in_progress, остальной(-ые) selected становятся
  // терминальными (cancelled), ни один не остаётся "подвисшим" в selected.
  expect(inProgress.length).toBe(1);
  expect(cancelled.length).toBe(1);
  expect(stillSelected.length).toBe(0);
  expect(await (await orderRow(orderId))?.status).toBe("in_progress");
});

it("3. проигравший кандидат сразу теряет доступ к контактам, победитель — сохраняет", async () => {
  const author = await makeUser("mc3-a");
  const exec1 = await makeUser("mc3-e1");
  const exec2 = await makeUser("mc3-e2");
  const { orderId, responseIds } = await makeOrderWithCandidates(author, [exec1, exec2]);
  const a1 = await select(author, orderId, responseIds[0]!);
  await select(author, orderId, responseIds[1]!);

  const start = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${a1}/start`, headers: as(author), payload: {} });
  expect(start.statusCode).toBe(200);

  // exec1 — победитель: доступ к контакту сохраняется (в обе стороны).
  expect((await contactOpen(author, exec1, orderId)).statusCode).toBe(200);
  expect((await contactOpen(exec1, author, orderId)).statusCode).toBe(200);
  // exec2 — проигравший: доступ закрыт немедленно, без задержки (в обе стороны).
  expect((await contactOpen(author, exec2, orderId)).statusCode).toBe(404);
  expect((await contactOpen(exec2, author, orderId)).statusCode).toBe(404);
});

it("4. повторный /start на другого (уже проигравшего) кандидата не может создать второго активного исполнителя", async () => {
  const author = await makeUser("mc4-a");
  const exec1 = await makeUser("mc4-e1");
  const exec2 = await makeUser("mc4-e2");
  const { orderId, responseIds } = await makeOrderWithCandidates(author, [exec1, exec2]);
  const a1 = await select(author, orderId, responseIds[0]!);
  const a2 = await select(author, orderId, responseIds[1]!);

  const start1 = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${a1}/start`, headers: as(author), payload: {} });
  expect(start1.statusCode).toBe(200);

  // a2 уже cancelled (демоция при старте a1) — повторная явная попытка start
  // на него не должна создать второго активного исполнителя.
  const start2 = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${a2}/start`, headers: as(author), payload: {} });
  expect(start2.statusCode).toBe(409);

  const assignments = await assignmentsOf(orderId);
  expect(assignments.filter((a) => a.status === "in_progress").length).toBe(1);
  expect(assignments.find((a) => a.id === a2)?.status).toBe("cancelled");
});

it("5. устаревший (запоздавший) cancel на уже проигравшего кандидата не может вернуть его в активные / не ломает состояние победителя", async () => {
  const author = await makeUser("mc5-a");
  const exec1 = await makeUser("mc5-e1");
  const exec2 = await makeUser("mc5-e2");
  const { orderId, responseIds } = await makeOrderWithCandidates(author, [exec1, exec2]);
  const a1 = await select(author, orderId, responseIds[0]!);
  const a2 = await select(author, orderId, responseIds[1]!);

  const start1 = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${a1}/start`, headers: as(author), payload: {} });
  expect(start1.statusCode).toBe(200);

  // "Устаревший" запрос: клиент проигравшего кандидата, не зная об исходе
  // переговоров, всё ещё пытается отменить СВОЙ выбор (a2, уже cancelled).
  const staleCancel = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${a2}/cancel`, headers: as(author), payload: {} });
  expect(staleCancel.statusCode).toBe(409);

  const assignments = await assignmentsOf(orderId);
  expect(assignments.find((a) => a.id === a1)?.status).toBe("in_progress");
  expect(assignments.find((a) => a.id === a2)?.status).toBe("cancelled");
  expect(await (await orderRow(orderId))?.status).toBe("in_progress");
});

it("6. КРИТИЧНО — выбор нового кандидата параллельно со start другого не создаёт второй активный исполнитель на заказе", async () => {
  const author = await makeUser("mc6-a");
  const exec1 = await makeUser("mc6-e1");
  const exec3 = await makeUser("mc6-e3");
  const { orderId, responseIds } = await makeOrderWithCandidates(author, [exec1]);
  const a1 = await select(author, orderId, responseIds[0]!);

  // Третий кандидат откликается и получает раскрытый контакт уже во время гонки.
  const created3 = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec3), payload: {} });
  const r3 = created3.json().id as string;
  await app.inject({ method: "POST", url: `/orders/${orderId}/contact-unlocks`, headers: as(author), payload: { responseId: r3 } });

  const [startRes, selectRes] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${a1}/start`, headers: as(author), payload: {} }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId: r3 } }),
  ]);
  expect(startRes.statusCode).toBe(200);
  // Оба исхода допустимы в зависимости от того, кто раньше взял блокировку
  // orders: либо выбор третьего кандидата успевает ДО старта (и тогда start
  // демотирует его в cancelled вместе с остальными), либо заказ уже in_progress
  // к моменту выбора — тогда выбор отклоняется как "заказ больше не открыт".
  expect([201, 409]).toContain(selectRes.statusCode);

  const assignments = await assignmentsOf(orderId);
  const inProgress = assignments.filter((a) => a.status === "in_progress");
  expect(inProgress.length).toBe(1);
  expect(inProgress[0]?.executorId).toBe(exec1);
  const stillSelected = assignments.filter((a) => a.status === "selected");
  expect(stillSelected.length).toBe(0);
  if (selectRes.statusCode === 201) {
    const a3 = selectRes.json().id as string;
    expect(assignments.find((a) => a.id === a3)?.status).toBe("cancelled");
  } else {
    expect(selectRes.json().error.code).toBe("invalid_status");
  }
});
