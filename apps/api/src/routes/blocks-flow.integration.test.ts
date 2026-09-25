import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import responsesRoutes from "./responses.js";
import contactsRoutes from "./contacts.js";
import assignmentsRoutes from "./assignments.js";
import blocksRoutes from "./blocks.js";

vi.mock("../lib/notify.js", () => ({ notifyUser: vi.fn(async () => "n") }));

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
let customer: string, exec: string, cityId: string;
const as = (user: string) => ({ "x-test-user": user });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  for (const r of [responsesRoutes, contactsRoutes, assignmentsRoutes, blocksRoutes]) await app.register(r);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST blocks", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id;
  cityIds.push(cityId);
  for (let i = 0; i < 2; i++) {
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
    userIds.push(u!.id);
    await db.insert(schema.userProfiles).values({
      userId: u!.id, name: `TEST b${i}`, cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
    });
  }
  [customer, exec] = userIds as [string, string];
});

afterAll(async () => {
  const ids = (await db.query.orders.findMany({ where: eq(schema.orders.authorId, customer) })).map((o) => o.id);
  if (ids.length) {
    await db.delete(schema.orderAssignments).where(inArray(schema.orderAssignments.orderId, ids));
    await db.delete(schema.contactUnlocks).where(inArray(schema.contactUnlocks.orderId, ids));
    await db.delete(schema.responses).where(inArray(schema.responses.orderId, ids));
  }
  await db.delete(schema.orders).where(eq(schema.orders.authorId, customer));
  await db.delete(schema.blocks).where(inArray(schema.blocks.blockerId, userIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

const unblock = async () => { await db.delete(schema.blocks).where(inArray(schema.blocks.blockerId, userIds)); };
const orderStatus = async (id: string) => (await db.query.orders.findFirst({ where: eq(schema.orders.id, id) }))?.status;
const contactStatus = async (orderId: string, by: string, other: string) =>
  (await app.inject({ method: "GET", url: `/orders/${orderId}/contacts/${other}`, headers: as(by) })).statusCode;

async function setup() {
  const [o] = await db.insert(schema.orders).values({ authorId: customer, cityId, sourceText: "TEST blocked order", status: "published" }).returning();
  const created = await app.inject({ method: "POST", url: `/orders/${o!.id}/responses`, headers: as(exec), payload: {} });
  const responseId = created.json().id as string;
  const unlock = await app.inject({ method: "POST", url: `/orders/${o!.id}/contact-unlocks`, headers: as(customer), payload: { responseId } });
  expect([200, 201]).toContain(unlock.statusCode);
  return { orderId: o!.id, responseId };
}

it("customer blocks executor with an active response: response withdrawn, no candidate, no contacts, no new interaction", async () => {
  const { orderId, responseId } = await setup();
  expect(await contactStatus(orderId, customer, exec)).toBe(200);
  expect(await contactStatus(orderId, exec, customer)).toBe(200);

  expect((await app.inject({ method: "POST", url: "/blocks", headers: as(customer), payload: { blockedId: exec } })).statusCode).toBe(201);

  expect((await db.query.responses.findFirst({ where: eq(schema.responses.id, responseId) }))?.status).toBe("withdrawn");
  const list = (await app.inject({ method: "GET", url: `/orders/${orderId}/responses`, headers: as(customer) })).json().items;
  expect(list).toHaveLength(0);
  expect(await contactStatus(orderId, customer, exec)).toBe(404);
  expect(await contactStatus(orderId, exec, customer)).toBe(404);
  expect((await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec), payload: {} })).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: `/orders/${orderId}/contact-unlocks`, headers: as(customer), payload: { responseId } })).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(customer), payload: { responseId } })).statusCode).toBe(404);
  await unblock();
});

it("executor blocks the customer while selected (negotiating): selection is cancelled, order is published again", async () => {
  const { orderId, responseId } = await setup();
  const pick = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(customer), payload: { responseId } });
  expect(pick.statusCode).toBe(201);
  expect(await orderStatus(orderId)).toBe("negotiating");

  expect((await app.inject({ method: "POST", url: "/blocks", headers: as(exec), payload: { blockedId: customer } })).statusCode).toBe(201);

  expect(await orderStatus(orderId)).toBe("published");
  expect(await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.orderId, orderId) })).toBeUndefined();
  expect(await db.query.contactUnlocks.findFirst({ where: eq(schema.contactUnlocks.orderId, orderId) })).toBeUndefined();
  expect(await contactStatus(orderId, customer, exec)).toBe(404);
  await unblock();
});

it("in_progress is NOT torn down: contacts are closed, but the customer can still finish the order", async () => {
  const { orderId, responseId } = await setup();
  const pick = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(customer), payload: { responseId } });
  const assignmentId = pick.json().id as string;
  expect((await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/start`, headers: as(customer), payload: {} })).statusCode).toBe(200);

  expect((await app.inject({ method: "POST", url: "/blocks", headers: as(customer), payload: { blockedId: exec } })).statusCode).toBe(201);

  expect(await orderStatus(orderId)).toBe("in_progress");
  expect((await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.id, assignmentId) }))?.status).toBe("in_progress");
  // заказчик по-прежнему видит исполнителя в списке, чтобы нажать «Выполнено»
  const list = (await app.inject({ method: "GET", url: `/orders/${orderId}/responses`, headers: as(customer) })).json().items;
  expect(list).toHaveLength(1);
  expect(list[0].assignmentStatus).toBe("in_progress");
  // а контакты закрыты в обе стороны
  expect(await contactStatus(orderId, customer, exec)).toBe(404);
  expect(await contactStatus(orderId, exec, customer)).toBe(404);

  const done = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments/${assignmentId}/complete`, headers: as(customer), payload: {} });
  expect(done.statusCode).toBe(200);
  expect(await orderStatus(orderId)).toBe("completed");
  await unblock();
  void and;
});
