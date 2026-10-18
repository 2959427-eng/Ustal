import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import responsesRoutes from "./responses.js";
import contactsRoutes from "./contacts.js";
import assignmentsRoutes from "./assignments.js";
import myRoutes from "./my.js";

// Уведомления ставят задачи в pg-boss — в интеграционном тесте они не нужны.
vi.mock("../lib/notify.js", () => ({ notifyUser: vi.fn(async () => "n") }));

/**
 * UX-аудит 2026-09-22 (claude/ux-journey-audit-2026-09-22.md), два
 * исправления:
 *  - MVP blocker #1: исполнитель отмечает "работа выполнена"/"не
 *    получилось" (executor-report-*) — это только сигнал заказчику, заказ
 *    сам НЕ переводит в completed/not_completed;
 *  - «Важно» №3: PATCH /responses/{id} (уже был на бэкенде) теперь
 *    реально используется мобильным клиентом для правки отклика без
 *    отзыва — здесь проверяем сам эндпоинт, которым он пользуется.
 */
assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
let author: string, exec1: string, exec2: string, cityId: string;

const as = (user: string) => ({ "x-test-user": user });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  await app.register(responsesRoutes);
  await app.register(contactsRoutes);
  await app.register(assignmentsRoutes);
  await app.register(myRoutes);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST executor-actions", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id;
  cityIds.push(cityId);
  for (let i = 0; i < 3; i++) {
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
    userIds.push(u!.id);
    await db.insert(schema.userProfiles).values({
      userId: u!.id, name: `TEST ea${i}`, cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
    });
  }
  [author, exec1, exec2] = userIds as [string, string, string];
});

afterAll(async () => {
  await db.delete(schema.orders).where(eq(schema.orders.authorId, author));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

async function makeInProgressOrder() {
  const [o] = await db.insert(schema.orders).values({
    authorId: author, cityId, sourceText: "TEST order in_progress", status: "published",
  }).returning();
  const orderId = o!.id;
  const created = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec1), payload: {} });
  const responseId = created.json().id as string;
  await app.inject({ method: "POST", url: `/orders/${orderId}/contact-unlocks`, headers: as(author), payload: { responseId } });
  const pick = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId } });
  const assignmentId = pick.json().id as string;
  const start = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/start`, headers: as(author), payload: {} });
  expect(start.statusCode).toBe(200);
  return { orderId, responseId, assignmentId };
}

it("executor-report-completed: сигнал заказчику, заказ остаётся in_progress — финализирует только заказчик", async () => {
  const { orderId, assignmentId } = await makeInProgressOrder();

  const report = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments/${assignmentId}/executor-report-completed`,
    headers: as(exec1),
    payload: {},
  });
  expect(report.statusCode).toBe(200);
  expect(report.json().executorReport).toBe("completed");

  // Заказ НЕ завершился сам — решение по-прежнему только у заказчика.
  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  expect(order?.status).toBe("in_progress");
  const assignment = await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.id, assignmentId) });
  expect(assignment?.status).toBe("in_progress");

  // Заказчик видит отметку рядом со своими кнопками «Выполнено»/«Не выполнено».
  const candidates = await app.inject({ method: "GET", url: `/orders/${orderId}/responses`, headers: as(author) });
  expect(candidates.json().items[0].executorReport).toBe("completed");

  // Исполнитель тоже видит свою отметку через /my/responses.
  const mine = await app.inject({ method: "GET", url: "/my/responses", headers: as(exec1) });
  const mineItem = mine.json().items.find((i: { orderId: string }) => i.orderId === orderId);
  expect(mineItem.executorReport).toBe("completed");
  expect(mineItem.assignmentId).toBe(assignmentId);

  // Только теперь заказчик реально завершает заказ.
  const complete = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/complete`, headers: as(author), payload: {} });
  expect(complete.statusCode).toBe(200);
  expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) }))?.status).toBe("completed");
});

it("executor-report-issue: тоже не финализирует заказ; чужой исполнитель отметить не может", async () => {
  const { orderId, assignmentId } = await makeInProgressOrder();

  // Чужой исполнитель (не назначенный на это assignment) — 404, не может ни подтвердить, ни навредить.
  const foreign = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments/${assignmentId}/executor-report-issue`,
    headers: as(exec2),
    payload: {},
  });
  expect(foreign.statusCode).toBe(404);

  const report = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments/${assignmentId}/executor-report-issue`,
    headers: as(exec1),
    payload: {},
  });
  expect(report.statusCode).toBe(200);
  expect(report.json().executorReport).toBe("issue");
  expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) }))?.status).toBe("in_progress");

  // Заказчик по-прежнему сам решает — может отметить «Не выполнено».
  const notCompleted = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/not-completed`, headers: as(author), payload: {} });
  expect(notCompleted.statusCode).toBe(200);
  expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) }))?.status).toBe("not_completed");
});

it("executor-report-*: недоступно, пока не «в работе» (например, ещё только выбран)", async () => {
  const [o] = await db.insert(schema.orders).values({
    authorId: author, cityId, sourceText: "TEST order selected-only", status: "published",
  }).returning();
  const orderId = o!.id;
  const created = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec1), payload: {} });
  const responseId = created.json().id as string;
  await app.inject({ method: "POST", url: `/orders/${orderId}/contact-unlocks`, headers: as(author), payload: { responseId } });
  const pick = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId } });
  const assignmentId = pick.json().id as string;

  const report = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments/${assignmentId}/executor-report-completed`,
    headers: as(exec1),
    payload: {},
  });
  expect(report.statusCode).toBe(409);
  expect(report.json().error.code).toBe("invalid_status");
});

it("PATCH /responses/{id}: правка цены/комментария активного отклика без отзыва", async () => {
  const [o] = await db.insert(schema.orders).values({
    authorId: author, cityId, sourceText: "TEST order editable response", status: "published", acceptsPriceOffers: true,
  }).returning();
  const orderId = o!.id;
  const created = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/responses`,
    headers: as(exec1),
    payload: {},
  });
  const responseId = created.json().id as string;
  expect(created.json().offeredPriceMinor).toBeNull();

  const edited = await app.inject({
    method: "PATCH",
    url: `/responses/${responseId}`,
    headers: as(exec1),
    payload: { offeredPriceMinor: 150000, comment: "Уточнённая цена и сроки" },
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().offeredPriceMinor).toBe(150000);
  expect(edited.json().comment).toBe("Уточнённая цена и сроки");

  const stored = await db.query.responses.findFirst({ where: eq(schema.responses.id, responseId) });
  expect(stored?.offeredPriceMinor).toBe(150000);
  expect(stored?.comment).toBe("Уточнённая цена и сроки");

  // Чужой отклик редактировать нельзя.
  const foreign = await app.inject({
    method: "PATCH",
    url: `/responses/${responseId}`,
    headers: as(exec2),
    payload: { comment: "чужое" },
  });
  expect(foreign.statusCode).toBe(404);
});
