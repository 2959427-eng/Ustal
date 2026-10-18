import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import ordersRoutes from "./orders.js";
import responsesRoutes from "./responses.js";
import contactsRoutes from "./contacts.js";
import assignmentsRoutes from "./assignments.js";
import reviewsRoutes from "./reviews.js";

// Второй, сфокусированный security-проход (2026-09-22): race conditions и
// обход state machine в критической цепочке заказа (выбор исполнителя,
// переговоры/В работе, executor_report, завершение, rating, контакты,
// отклики). Уведомления и очередь — не предмет этого прохода, мокаем.
vi.mock("../lib/notify.js", () => ({ notifyUser: vi.fn(async () => "n") }));
vi.mock("@ustal/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ustal/queue")>();
  return { ...actual, getBoss: vi.fn(async () => ({ send: vi.fn(async () => "test-job-id") })) };
});

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

/** Новый заказ (published) + отклик исполнителя + раскрытый контакт — базовая точка для гонок. */
async function makeUnlockedOrder(authorId: string, executorId: string) {
  const [o] = await db.insert(schema.orders).values({ authorId, cityId, sourceText: "TEST race order", status: "published" }).returning();
  orderIds.push(o!.id);
  const created = await app.inject({ method: "POST", url: `/orders/${o!.id}/responses`, headers: as(executorId), payload: {} });
  expect(created.statusCode).toBe(201);
  const responseId = created.json().id as string;
  const unlock = await app.inject({
    method: "POST",
    url: `/orders/${o!.id}/contact-unlocks`,
    headers: as(authorId),
    payload: { responseId },
  });
  expect([200, 201]).toContain(unlock.statusCode);
  return { orderId: o!.id, responseId };
}

async function select(authorId: string, orderId: string, responseId: string) {
  const pick = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(authorId), payload: { responseId } });
  expect(pick.statusCode).toBe(201);
  return pick.json().id as string;
}

async function selectAndStart(authorId: string, orderId: string, responseId: string) {
  const assignmentId = await select(authorId, orderId, responseId);
  const start = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/start`, headers: as(authorId), payload: {} });
  expect(start.statusCode).toBe(200);
  return assignmentId;
}

const orderRow = async (orderId: string) => db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
const liveAssignments = async (orderId: string) =>
  db.query.orderAssignments.findMany({
    where: and(eq(schema.orderAssignments.orderId, orderId), inArray(schema.orderAssignments.status, ["selected", "in_progress"])),
  });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  for (const r of [ordersRoutes, responsesRoutes, contactsRoutes, assignmentsRoutes, reviewsRoutes]) await app.register(r);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST lifecycle-race", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id;
  cityIds.push(cityId);
});

afterAll(async () => {
  const allOrders = await db.query.orders.findMany({ where: inArray(schema.orders.authorId, userIds) });
  const allOrderIds = [...new Set([...orderIds, ...allOrders.map((o) => o.id)])];
  if (allOrderIds.length) {
    await db.delete(schema.orderRatings).where(inArray(schema.orderRatings.orderId, allOrderIds));
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

// ---------------------------------------------------------------------------
// 1. Выбор исполнителя
// ---------------------------------------------------------------------------

it("выбор: два разных исполнителей одновременно — ЭТАП 2 переговоров: оба становятся selected", async () => {
  // Обновлено 2026-09-22 (ЭТАП 2 переговоров, negotiation-architecture-audit):
  // MVP под одного исполнителя снят — заказчик может вести переговоры с
  // несколькими кандидатами одновременно, поэтому конкурентный выбор ДВУХ
  // РАЗНЫХ откликов больше не должен конфликтовать: оба запроса успешны.
  const author = await makeUser("sel-a1");
  const exec1 = await makeUser("sel-e1");
  const exec2 = await makeUser("sel-e2");
  const { orderId, responseId: r1 } = await makeUnlockedOrder(author, exec1);
  const created2 = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec2), payload: {} });
  const r2 = created2.json().id as string;
  await app.inject({ method: "POST", url: `/orders/${orderId}/contact-unlocks`, headers: as(author), payload: { responseId: r2 } });

  const [res1, res2] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId: r1 } }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId: r2 } }),
  ]);
  const codes = [res1.statusCode, res2.statusCode].sort();
  expect(codes).toEqual([201, 201]);

  const live = await liveAssignments(orderId);
  expect(live.length).toBe(2);
  expect(live.every((a) => a.status === "selected")).toBe(true);
  expect(await (await orderRow(orderId))?.status).toBe("negotiating");
});

it("выбор: два параллельных запроса выбора ОДНОГО и того же отклика — назначение только одно", async () => {
  const author = await makeUser("sel-b1");
  const exec1 = await makeUser("sel-be1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);

  const [res1, res2] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId } }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId } }),
  ]);
  const codes = [res1.statusCode, res2.statusCode].sort();
  expect(codes).toEqual([201, 409]);
  const live = await liveAssignments(orderId);
  expect(live.length).toBe(1);
});

it("выбор: снятие выбора одновременно с выбором ДРУГОГО исполнителя — не остаётся два живых назначения", async () => {
  const author = await makeUser("sel-c1");
  const exec1 = await makeUser("sel-ce1");
  const exec2 = await makeUser("sel-ce2");
  const { orderId, responseId: r1 } = await makeUnlockedOrder(author, exec1);
  const created2 = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec2), payload: {} });
  const r2 = created2.json().id as string;
  await app.inject({ method: "POST", url: `/orders/${orderId}/contact-unlocks`, headers: as(author), payload: { responseId: r2 } });
  const assignment1 = await select(author, orderId, r1);

  const [cancelRes, selectRes] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignment1}/cancel`, headers: as(author), payload: {} }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId: r2 } }),
  ]);

  const live = await liveAssignments(orderId);
  // Инвариант: максимум одно живое назначение, и статус заказа должен ему соответствовать
  // (negotiating, если живое назначение есть; published — если нет).
  expect(live.length).toBeLessThanOrEqual(1);
  const order = await orderRow(orderId);
  if (live.length === 1) {
    expect(order?.status).toBe("negotiating");
  } else {
    expect(order?.status).toBe("published");
  }
  void cancelRes;
  void selectRes;
});

it("выбор: КРИТИЧНО — выбор исполнителя одновременно с отменой заказа не должен оставлять живое назначение на отменённом заказе", async () => {
  const author = await makeUser("sel-d1");
  const exec1 = await makeUser("sel-de1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);

  const [selectRes, cancelRes] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId } }),
    app.inject({ method: "POST", url: `/orders/${orderId}/cancel`, headers: as(author), payload: {} }),
  ]);

  const order = await orderRow(orderId);
  const live = await liveAssignments(orderId);
  // Ключевой инвариант: отменённый заказ не может иметь живое (selected/in_progress) назначение,
  // и наоборот — заказ с живым назначением не может быть отменён.
  const brokenInvariant = order?.status === "cancelled" && live.length > 0;
  expect({ orderStatus: order?.status, liveAssignments: live.length, selectStatus: selectRes.statusCode, cancelStatus: cancelRes.statusCode, brokenInvariant }).toEqual(
    expect.objectContaining({ brokenInvariant: false }),
  );
});

// ---------------------------------------------------------------------------
// 2. Переходы статуса (start / negotiating / in_progress)
// ---------------------------------------------------------------------------

it("start: два параллельных start одного назначения — идемпотентно, без порчи состояния", async () => {
  const author = await makeUser("start-a1");
  const exec1 = await makeUser("start-ae1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await select(author, orderId, responseId);

  const [r1, r2] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/start`, headers: as(author), payload: {} }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/start`, headers: as(author), payload: {} }),
  ]);
  const codes = [r1.statusCode, r2.statusCode].sort();
  expect(codes).toEqual([200, 409]);
  expect((await orderRow(orderId))?.status).toBe("in_progress");
  const [a] = await db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.id, assignmentId) });
  expect(a?.status).toBe("in_progress");
});

it("start: КРИТИЧНО — start одновременно со снятием выбора (cancel-assignment) не должен оставлять заказ in_progress без живого назначения", async () => {
  const author = await makeUser("start-b1");
  const exec1 = await makeUser("start-be1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await select(author, orderId, responseId);

  const [startRes, cancelRes] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/start`, headers: as(author), payload: {} }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/cancel`, headers: as(author), payload: {} }),
  ]);

  const order = await orderRow(orderId);
  const [assignment] = await db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.id, assignmentId) });
  // Ключевой инвариант: если назначение отменено (снято, строки больше нет), заказ НЕ должен быть in_progress.
  const brokenInvariant = !assignment && order?.status === "in_progress";
  expect({
    orderStatus: order?.status,
    assignmentExists: !!assignment,
    assignmentStatus: assignment?.status,
    startStatus: startRes.statusCode,
    cancelStatus: cancelRes.statusCode,
    brokenInvariant,
  }).toEqual(expect.objectContaining({ brokenInvariant: false }));
});

// ---------------------------------------------------------------------------
// 3. executor_report
// ---------------------------------------------------------------------------

it("executor_report: одновременно completed и issue — ровно одно значение, без крэша", async () => {
  const author = await makeUser("erep-a1");
  const exec1 = await makeUser("erep-ae1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await selectAndStart(author, orderId, responseId);

  const [r1, r2] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/executor-report-completed`, headers: as(exec1), payload: {} }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/executor-report-issue`, headers: as(exec1), payload: {} }),
  ]);
  expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
  const [a] = await db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.id, assignmentId) });
  expect(["completed", "issue"]).toContain(a?.executorReport);
  expect(a?.executorReportAt).toBeTruthy();
});

it("executor_report: report не своим исполнителем — 404, чужой assignment не меняется", async () => {
  const author = await makeUser("erep-b1");
  const exec1 = await makeUser("erep-be1");
  const intruder = await makeUser("erep-bi1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await selectAndStart(author, orderId, responseId);

  const res = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/executor-report-completed`, headers: as(intruder), payload: {} });
  expect(res.statusCode).toBe(404);
  const [a] = await db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.id, assignmentId) });
  expect(a?.executorReport).toBeNull();
});

it("executor_report: report одновременно с завершением заказчиком — после complete report не должен переоткрывать сигнал на финализированном назначении", async () => {
  const author = await makeUser("erep-c1");
  const exec1 = await makeUser("erep-ce1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await selectAndStart(author, orderId, responseId);

  await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/complete`, headers: as(author), payload: {} }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/executor-report-issue`, headers: as(exec1), payload: {} }),
  ]);

  const [a] = await db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.id, assignmentId) });
  // Инвариант: назначение либо ещё не видело report (report случился раньше complete и мог пройти),
  // но если назначение уже completed, oно должно остаться completed (report не переводит его обратно).
  expect(a?.status).toBe("completed");
});

// ---------------------------------------------------------------------------
// 4. Завершение заказа
// ---------------------------------------------------------------------------

it("завершение: два параллельных complete — идемпотентно, без противоречивого состояния", async () => {
  const author = await makeUser("fin-a1");
  const exec1 = await makeUser("fin-ae1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await selectAndStart(author, orderId, responseId);

  const [r1, r2] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/complete`, headers: as(author), payload: {} }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/complete`, headers: as(author), payload: {} }),
  ]);
  const codes = [r1.statusCode, r2.statusCode].sort();
  expect(codes).toEqual([200, 409]);
  const order = await orderRow(orderId);
  const [a] = await db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.id, assignmentId) });
  expect(order?.status).toBe("completed");
  expect(a?.status).toBe("completed");
});

it("завершение: КРИТИЧНО — complete одновременно с not-completed не должен давать противоречивое финальное состояние", async () => {
  const author = await makeUser("fin-b1");
  const exec1 = await makeUser("fin-be1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await selectAndStart(author, orderId, responseId);

  const [completeRes, notCompletedRes] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/complete`, headers: as(author), payload: {} }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/not-completed`, headers: as(author), payload: {} }),
  ]);

  const order = await orderRow(orderId);
  const [a] = await db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.id, assignmentId) });
  // Ключевой инвариант: ровно ОДИН из двух запросов должен был реально выиграть (200),
  // и order.status/assignment.status должны СОВПАДАТЬ с исходом победителя, а не быть перезаписаны проигравшим.
  const codes = [completeRes.statusCode, notCompletedRes.statusCode].sort();
  const consistent = order?.status === a?.status; // 'completed'==='completed' или 'not_completed'==='not_completed'
  expect({ codes, orderStatus: order?.status, assignmentStatus: a?.status, consistent }).toEqual(
    expect.objectContaining({ codes: [200, 409], consistent: true }),
  );
});

it("завершение: повторное not-completed после completed — отклоняется, состояние не меняется", async () => {
  const author = await makeUser("fin-c1");
  const exec1 = await makeUser("fin-ce1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await selectAndStart(author, orderId, responseId);

  const done = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/complete`, headers: as(author), payload: {} });
  expect(done.statusCode).toBe(200);
  const late = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/not-completed`, headers: as(author), payload: {} });
  expect(late.statusCode).toBe(409);
  const order = await orderRow(orderId);
  expect(order?.status).toBe("completed");
});

// ---------------------------------------------------------------------------
// 5. Rating
// ---------------------------------------------------------------------------

it("rating: две параллельные оценки одного заказа одним и тем же заказчиком — только одна запись", async () => {
  const author = await makeUser("rate-a1");
  const exec1 = await makeUser("rate-ae1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await selectAndStart(author, orderId, responseId);
  await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/complete`, headers: as(author), payload: {} });

  const [r1, r2] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/rating`, headers: as(author), payload: { rating: 5 } }),
    app.inject({ method: "POST", url: `/orders/${orderId}/rating`, headers: as(author), payload: { rating: 1 } }),
  ]);
  const codes = [r1.statusCode, r2.statusCode].sort();
  expect(codes).toEqual([201, 409]);
  const ratings = await db.query.orderRatings.findMany({ where: and(eq(schema.orderRatings.orderId, orderId), eq(schema.orderRatings.fromUserId, author)) });
  expect(ratings.length).toBe(1);
});

it("rating: до финализации (в работе) — корректно отклоняется, не создаёт запись", async () => {
  const author = await makeUser("rate-b1");
  const exec1 = await makeUser("rate-be1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await selectAndStart(author, orderId, responseId);
  void assignmentId;

  // loadRatingContext требует order_assignments.status='completed' — пока заказ
  // "в работе", такого назначения нет, и эндпоинт намеренно отвечает 404 (не
  // палит наличие заказа/назначения в другом статусе), а не 409. Это дизайн,
  // а не баг: проверено чтением routes/reviews.ts — не связано с race/state.
  const res = await app.inject({ method: "POST", url: `/orders/${orderId}/rating`, headers: as(author), payload: { rating: 5 } });
  expect(res.statusCode).toBe(404);
  const ratings = await db.query.orderRatings.findMany({ where: eq(schema.orderRatings.orderId, orderId) });
  expect(ratings.length).toBe(0);
});

it("rating: исполнитель независимо оценивает заказчика", async () => {
  const author = await makeUser("rate-c1");
  const exec1 = await makeUser("rate-ce1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await selectAndStart(author, orderId, responseId);
  await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/complete`, headers: as(author), payload: {} });

  const res = await app.inject({ method: "POST", url: `/orders/${orderId}/rating`, headers: as(exec1), payload: { rating: 5 } });
  expect(res.statusCode).toBe(201);
  const ratings = await db.query.orderRatings.findMany({ where: eq(schema.orderRatings.orderId, orderId) });
  expect(ratings).toHaveLength(1);
  expect(ratings[0]?.toRole).toBe("customer");
});

// ---------------------------------------------------------------------------
// 6. Контакты
// ---------------------------------------------------------------------------

it("контакты: после отмены выбора (cancel-assignment) доступ должен быть закрыт даже при гонке с чтением", async () => {
  const author = await makeUser("contact-a1");
  const exec1 = await makeUser("contact-ae1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  const assignmentId = await select(author, orderId, responseId);

  const [cancelRes, readRes] = await Promise.all([
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/cancel`, headers: as(author), payload: {} }),
    app.inject({ method: "GET", url: `/orders/${orderId}/contacts/${exec1}`, headers: as(author) }),
  ]);
  void cancelRes;
  // Читаем контакт ПОСЛЕ того, как обе гоночные операции точно завершились — доступ должен быть закрыт.
  const after = await app.inject({ method: "GET", url: `/orders/${orderId}/contacts/${exec1}`, headers: as(author) });
  expect(after.statusCode).toBe(404);
  void readRes;
});

// ---------------------------------------------------------------------------
// 7. Responses / applications
// ---------------------------------------------------------------------------

it("responses: несколько параллельных откликов одного исполнителя на один заказ — только один активный", async () => {
  const author = await makeUser("resp-a1");
  const exec1 = await makeUser("resp-ae1");
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId, sourceText: "TEST resp race", status: "published" }).returning();
  orderIds.push(o!.id);

  const results = await Promise.all(
    Array.from({ length: 4 }, () => app.inject({ method: "POST", url: `/orders/${o!.id}/responses`, headers: as(exec1), payload: {} })),
  );
  const succeeded = results.filter((r) => r.statusCode === 201);
  const conflicted = results.filter((r) => r.statusCode === 409);
  expect(succeeded.length).toBe(1);
  expect(conflicted.length).toBe(3);
  const active = await db.query.responses.findMany({ where: and(eq(schema.responses.orderId, o!.id), eq(schema.responses.status, "active")) });
  expect(active.length).toBe(1);
});

it("responses: КРИТИЧНО — edit одновременно с withdraw не должен оставлять изменения на отозванном отклике", async () => {
  const author = await makeUser("resp-b1");
  const exec1 = await makeUser("resp-be1");
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId, sourceText: "TEST resp edit-withdraw", status: "published" }).returning();
  orderIds.push(o!.id);
  const created = await app.inject({ method: "POST", url: `/orders/${o!.id}/responses`, headers: as(exec1), payload: { comment: "original" } });
  const responseId = created.json().id as string;

  const [editRes, withdrawRes] = await Promise.all([
    app.inject({ method: "PATCH", url: `/responses/${responseId}`, headers: as(exec1), payload: { comment: "edited after withdraw?" } }),
    app.inject({ method: "DELETE", url: `/responses/${responseId}`, headers: as(exec1) }),
  ]);

  const [row] = await db.select().from(schema.responses).where(eq(schema.responses.id, responseId));
  // Both serial orders are valid: edit then withdraw, or withdraw then rejected edit.
  expect(withdrawRes.statusCode).toBe(204);
  expect([200, 409]).toContain(editRes.statusCode);
  expect(row?.status).toBe("withdrawn");
  expect(row?.comment).toBe(editRes.statusCode === 200 ? "edited after withdraw?" : "original");
  const lateEdit = await app.inject({ method: "PATCH", url: `/responses/${responseId}`, headers: as(exec1), payload: { comment: "must not persist" } });
  expect(lateEdit.statusCode).toBe(409);
  const final = await db.query.responses.findFirst({ where: eq(schema.responses.id, responseId) });
  expect(final?.comment).toBe(row?.comment);
});

it("responses: withdraw одновременно с выбором заказчиком — ровно один исход, без двух живых сущностей", async () => {
  const author = await makeUser("resp-c1");
  const exec1 = await makeUser("resp-ce1");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);

  const [withdrawRes, selectRes] = await Promise.all([
    app.inject({ method: "DELETE", url: `/responses/${responseId}`, headers: as(exec1) }),
    app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId } }),
  ]);

  const [row] = await db.select().from(schema.responses).where(eq(schema.responses.id, responseId));
  const live = await liveAssignments(orderId);
  // Либо отклик отозван и назначения нет, либо отклик выбран (не withdrawn) и назначение есть — никогда оба сразу.
  const bothHappened = row?.status === "withdrawn" && live.length > 0;
  expect({ withdrawStatus: withdrawRes.statusCode, selectStatus: selectRes.statusCode, responseStatus: row?.status, liveAssignments: live.length, bothHappened }).toEqual(
    expect.objectContaining({ bothHappened: false }),
  );
});

it("responses: новый отклик после перехода заказа в in_progress (через start) — отклоняется", async () => {
  const author = await makeUser("resp-d1");
  const exec1 = await makeUser("resp-de1");
  const exec2 = await makeUser("resp-de2");
  const { orderId, responseId } = await makeUnlockedOrder(author, exec1);
  await selectAndStart(author, orderId, responseId);

  const late = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec2), payload: {} });
  expect(late.statusCode).toBe(409);
});
