import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import ordersRoutes from "./orders.js";
import myRoutes from "./my.js";

const notification = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../lib/notify.js", () => ({ notifyUser: notification.send }));
beforeEach(() => { notification.send.mockReset(); notification.send.mockResolvedValue("test-notice"); });
assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
const orderIds: string[] = [];
let author: string, other: string, executor: string, cityId: string;
const as = (u: string) => ({ "x-test-user": u });

async function makeOrder(status: string) {
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId, sourceText: "TEST delete", status }).returning();
  orderIds.push(o!.id);
  return o!.id;
}
const myIds = async () => (await app.inject({ method: "GET", url: "/my/orders", headers: as(author) })).json().items.map((i: { id: string }) => i.id) as string[];

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  await app.register(ordersRoutes);
  await app.register(myRoutes);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST delete", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id; cityIds.push(cityId);
  for (let i = 0; i < 3; i++) {
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
    userIds.push(u!.id);
    await db.insert(schema.userProfiles).values({ userId: u!.id, name: `TEST d${i}`, cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
  }
  [author, other, executor] = userIds as [string, string, string];
});

afterAll(async () => {
  await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

it("author deletes a published order: hidden from my orders, active responses closed, row kept", async () => {
  const id = await makeOrder("published");
  const [resp] = await db.insert(schema.responses).values({ orderId: id, executorId: executor }).returning();
  expect(await myIds()).toContain(id);
  const res = await app.inject({ method: "POST", url: `/orders/${id}/cancel`, headers: as(author) });
  expect(res.statusCode).toBe(204);
  expect(notification.send).toHaveBeenCalledWith(executor, "order_cancelled_response", expect.objectContaining({orderId:id,responseId:resp!.id}));
  expect(notification.send).toHaveBeenCalledTimes(1);
  expect(await myIds()).not.toContain(id);
  expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, id) }))?.status).toBe("cancelled");
  expect((await db.query.responses.findFirst({ where: eq(schema.responses.id, resp!.id) }))?.status).toBe("not_selected");
});

it("cannot delete someone else's order", async () => {
  const id = await makeOrder("published");
  expect((await app.inject({ method: "POST", url: `/orders/${id}/cancel`, headers: as(other) })).statusCode).toBe(404);
});

it("cannot delete an order with a selected executor", async () => {
  const id = await makeOrder("negotiating");
  const [resp] = await db.insert(schema.responses).values({ orderId: id, executorId: executor }).returning();
  await db.insert(schema.orderAssignments).values({ orderId: id, executorId: executor, responseId: resp!.id });
  const res = await app.inject({ method: "POST", url: `/orders/${id}/cancel`, headers: as(author) });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe("has_assignment");
  expect(notification.send).not.toHaveBeenCalled();
  expect(await myIds()).toContain(id);
});

it("cannot delete a closed order", async () => {
  const id = await makeOrder("closed");
  expect((await app.inject({ method: "POST", url: `/orders/${id}/cancel`, headers: as(author) })).statusCode).toBe(409);
});

it("notification failure does not turn a saved cancellation into failure or duplicate it", async () => {
  const id = await makeOrder("published");
  await db.insert(schema.responses).values({orderId:id,executorId:executor});
  notification.send.mockRejectedValue(new Error("queue unavailable"));
  const first = await app.inject({method:"POST",url:"/orders/"+id+"/cancel",headers:as(author)});
  expect(first.statusCode).toBe(204);
  expect((await db.query.orders.findFirst({where:eq(schema.orders.id,id)}))?.status).toBe("cancelled");
  const repeat = await app.inject({method:"POST",url:"/orders/"+id+"/cancel",headers:as(author)});
  expect(repeat.statusCode).toBe(409);
  expect(notification.send).toHaveBeenCalledTimes(1);
});
