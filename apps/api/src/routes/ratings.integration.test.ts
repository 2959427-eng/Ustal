import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import reviewsRoutes from "./reviews.js";
import myRoutes from "./my.js";
import usersRoutes from "./users.js";

vi.mock("../lib/notify.js", () => ({ notifyUser: vi.fn(async () => "n") }));

/**
 * Двусторонний рейтинг: после завершённого заказа заказчик и исполнитель
 * оценивают друг друга 1–5, независимо и без текста — два отдельных
 * рейтинга на аккаунт (как исполнитель / как заказчик, см. lib/reputation.ts),
 * не смешиваются. Один пользователь не может дважды оценить другого по
 * одному заказу (`order_ratings_order_from_unique`). Оценивать могут только
 * реальные участники завершённого заказа.
 */
assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
let customer: string, exec: string, stranger: string, cityId: string;
const as = (user: string) => ({ "x-test-user": user });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  await app.register(reviewsRoutes);
  await app.register(myRoutes);
  await app.register(usersRoutes);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST rating", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id;
  cityIds.push(cityId);
  for (let i = 0; i < 3; i++) {
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
    userIds.push(u!.id);
    await db.insert(schema.userProfiles).values({
      userId: u!.id, name: `TEST r${i}`, cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
    });
  }
  [customer, exec, stranger] = userIds as [string, string, string];
});

afterAll(async () => {
  const ids = (await db.query.orders.findMany({ where: eq(schema.orders.authorId, customer) })).map((o) => o.id);
  if (ids.length) {
    await db.delete(schema.orderRatings).where(inArray(schema.orderRatings.orderId, ids));
    await db.delete(schema.orderAssignments).where(inArray(schema.orderAssignments.orderId, ids));
    await db.delete(schema.responses).where(inArray(schema.responses.orderId, ids));
  }
  await db.delete(schema.orders).where(eq(schema.orders.authorId, customer));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

async function makeOrder(status: string, assignment?: "completed" | "not_completed" | "in_progress", published = true) {
  const [o] = await db.insert(schema.orders).values({
    authorId: customer, cityId, sourceText: "TEST rated order", status, publishedAt: published ? new Date() : null,
  }).returning();
  const [resp] = await db.insert(schema.responses).values({ orderId: o!.id, executorId: exec, status: "active" }).returning();
  if (assignment) {
    await db.insert(schema.orderAssignments).values({ orderId: o!.id, executorId: exec, responseId: resp!.id, status: assignment });
  }
  return o!.id;
}
const rate = (orderId: string, user: string, rating: number | null) =>
  app.inject({ method: "POST", url: `/orders/${orderId}/rating`, headers: as(user), payload: { rating } });
const state = async (orderId: string, user: string) => (await app.inject({ method: "GET", url: `/orders/${orderId}/rating`, headers: as(user) })).json();
const rep = async (user: string) => (await app.inject({ method: "GET", url: "/me/reputation", headers: as(user) })).json();

it("customer side: rates the executor, cannot double-rate, only a real participant can rate", async () => {
  const early = await makeOrder("in_progress", "in_progress");
  expect((await rate(early, customer, 5)).statusCode).toBe(404); // ещё не выполнен — оценивать нечего

  const oid = await makeOrder("completed", "completed");
  expect(await state(oid, customer)).toEqual({ pending: true, targetRole: "executor" });
  // посторонний не участвует
  expect((await rate(oid, stranger, 5)).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: `/orders/${oid}/rating`, headers: as(stranger) })).statusCode).toBe(404);

  const pendingCustomer = (await app.inject({ method: "GET", url: "/my/orders", headers: as(customer) })).json().items.find((i: { id: string }) => i.id === oid);
  expect(pendingCustomer).toMatchObject({ ratingPending: true, archived: false });

  // невалидная оценка отклоняется
  expect((await rate(oid, customer, 6)).statusCode).toBeGreaterThanOrEqual(400);
  expect((await rate(oid, customer, 0)).statusCode).toBeGreaterThanOrEqual(400);

  const r1 = await rate(oid, customer, 4);
  expect(r1.statusCode).toBe(201);
  expect(r1.json().skipped).toBe(false);
  expect(await state(oid, customer)).toEqual({ pending: false });
  expect((await rate(oid, customer, 1)).statusCode).toBe(409); // повторно нельзя
  const c1 = (await app.inject({ method: "GET", url: "/my/orders", headers: as(customer) })).json().items.find((i: { id: string }) => i.id === oid);
  expect(c1).toMatchObject({ ratingPending: false, archived: true });

  const execRep = await rep(exec);
  expect(execRep.executor).toMatchObject({ rating: 4, ratingCount: 1, completed: 1, notCompleted: 0 });

  // второй заказ: средний балл и число оценок исполнителя растут
  const oid2 = await makeOrder("completed", "completed");
  expect((await rate(oid2, customer, 5)).statusCode).toBe(201);
  expect((await rep(exec)).executor).toMatchObject({ rating: 4.5, ratingCount: 2, completed: 2, notCompleted: 0 });
});

it("executor side: independently rates the customer, without affecting the executor rating", async () => {
  const oid = await makeOrder("completed", "completed");
  expect(await state(oid, exec)).toEqual({ pending: true, targetRole: "customer" });

  const r1 = await rate(oid, exec, 5);
  expect(r1.statusCode).toBe(201);
  expect(await state(oid, exec)).toEqual({ pending: false });

  const custRep = await rep(customer);
  expect(custRep.customer).toMatchObject({ rating: 5, ratingCount: 1 });
  // рейтинг заказчика (как заказчика) и его же рейтинг как исполнителя — независимые числа, не смешиваются
  expect(custRep.executor).toMatchObject({ rating: null, ratingCount: 0 });
  // симметрично: то, что заказчика оценили, не трогает рейтинг исполнителя-оценивающего
  const execRep = await rep(exec);
  expect(execRep.customer).toMatchObject({ rating: null, ratingCount: 0 });

  // повторно исполнитель оценить того же заказчика по тому же заказу не может
  expect((await rate(oid, exec, 1)).statusCode).toBe(409);

  // а заказчик по этому же заказу всё ещё может независимо оценить исполнителя
  expect(await state(oid, customer)).toEqual({ pending: true, targetRole: "executor" });
  expect((await rate(oid, customer, 4)).statusCode).toBe(201);

  // отклик исполнителя архивируется сразу по факту "выполнено", независимо от того, оценил ли он заказчика
  const execResp = (await app.inject({ method: "GET", url: "/my/responses", headers: as(exec) })).json().items.find((i: { orderId: string }) => i.orderId === oid);
  expect(execResp).toMatchObject({ archived: true });
});

it("customer.total counts every order created; not-completed/cancelled outcomes are counted; drafts are not rateable", async () => {
  const before = (await rep(customer)).customer.total;
  const nc = await makeOrder("not_completed", "not_completed");
  expect((await rate(nc, customer, 5)).statusCode).toBe(404);
  const cancelledPublished = await makeOrder("cancelled", undefined, true);
  await makeOrder("cancelled", undefined, false); // отменённый черновик всё равно создан — считается в total, но не в "отменено"
  expect(cancelledPublished).toBeTruthy();

  const after = await rep(customer);
  // total выросло ровно на число реально вставленных здесь заказов (3), независимо от статуса
  expect(after.customer.total).toBe(before + 3);
  expect((await rep(exec)).executor).toMatchObject({ notCompleted: 1 });
  expect(after.customer).toMatchObject({ cancelled: 2 }); // not_completed + опубликованный cancelled; черновик-отмена не считается

  const my = (await app.inject({ method: "GET", url: "/my/orders", headers: as(customer) })).json().items;
  expect(my.find((i: { id: string }) => i.id === nc)).toMatchObject({ archived: true, ratingPending: false });
  const myResp = (await app.inject({ method: "GET", url: "/my/responses", headers: as(exec) })).json().items;
  expect(myResp.find((i: { orderId: string }) => i.orderId === nc)).toMatchObject({ archived: true });
});

it("public profile: both sides show an independent rating alongside their own history", async () => {
  const oid = await makeOrder("completed", "completed");
  const res = await app.inject({ method: "GET", url: `/users/${exec}?orderId=${oid}`, headers: as(customer) });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.reputation.executor).toMatchObject({ completed: 4 });
  expect(body.reputation.customer).toBeDefined();

  const author = await app.inject({ method: "GET", url: `/users/${customer}?orderId=${oid}`, headers: as(exec) });
  expect(author.statusCode).toBe(200);
  expect(author.json().reputation.customer.total).toBeGreaterThan(0);
});
