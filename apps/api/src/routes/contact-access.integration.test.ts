import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import responsesRoutes from "./responses.js";
import contactsRoutes from "./contacts.js";
import assignmentsRoutes from "./assignments.js";
import myRoutes from "./my.js";

vi.mock("../lib/notify.js", () => ({ notifyUser: vi.fn(async () => "n") }));

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
let customer: string, exec: string, exec2: string, cityId: string;
const as = (user: string) => ({ "x-test-user": user });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  for (const r of [responsesRoutes, contactsRoutes, assignmentsRoutes, myRoutes]) await app.register(r);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST contact access", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id;
  cityIds.push(cityId);
  for (let i = 0; i < 3; i++) {
    const [u] = await db.insert(schema.users).values({ phone: `+7${Math.floor(1e9 + Math.random() * 9e9)}`, passwordHash: "local-test" }).returning();
    userIds.push(u!.id);
    await db.insert(schema.userProfiles).values({
      userId: u!.id, name: `TEST c${i}`, cityId, whatsappPhone: "+79990000000", acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
    });
  }
  [customer, exec, exec2] = userIds as [string, string, string];
});

afterAll(async () => {
  const ids = (await db.query.orders.findMany({ where: eq(schema.orders.authorId, customer) })).map((o) => o.id);
  if (ids.length) {
    await db.delete(schema.orderAssignments).where(inArray(schema.orderAssignments.orderId, ids));
    await db.delete(schema.contactUnlocks).where(inArray(schema.contactUnlocks.orderId, ids));
    await db.delete(schema.responses).where(inArray(schema.responses.orderId, ids));
  }
  await db.delete(schema.orders).where(eq(schema.orders.authorId, customer));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

const contact = async (orderId: string, by: string, other: string) =>
  (await app.inject({ method: "GET", url: `/orders/${orderId}/contacts/${other}`, headers: as(by) })).statusCode;
const both = async (orderId: string, e: string) => [await contact(orderId, customer, e), await contact(orderId, e, customer)];
const status = async (id: string) => (await db.query.orders.findFirst({ where: eq(schema.orders.id, id) }))?.status;
const post = (url: string, user: string, payload: object = {}) => app.inject({ method: "POST", url, headers: as(user), payload });

async function setup(executors: string[] = [exec]) {
  const [o] = await db.insert(schema.orders).values({ authorId: customer, cityId, sourceText: "TEST contact order", status: "published" }).returning();
  const responseIds: Record<string, string> = {};
  for (const e of executors) {
    const created = await post(`/orders/${o!.id}/responses`, e);
    responseIds[e] = created.json().id;
    expect([200, 201]).toContain((await post(`/orders/${o!.id}/contact-unlocks`, customer, { responseId: responseIds[e] })).statusCode);
  }
  return { orderId: o!.id, responseIds };
}
async function toInProgress(orderId: string, responseId: string) {
  const pick = await post(`/orders/${orderId}/assignments`, customer, { responseId });
  const assignmentId = pick.json().id as string;
  return { assignmentId, base: `/orders/${orderId}/assignments/${assignmentId}` };
}
const candidates = async (orderId: string) => (await app.inject({ method: "GET", url: `/orders/${orderId}/responses`, headers: as(customer) })).json().items as { executorId: string; isContactUnlocked: boolean }[];
const myResponse = async (orderId: string, e: string) =>
  ((await app.inject({ method: "GET", url: "/my/responses", headers: as(e) })).json().items as { orderId: string; isContactUnlocked: boolean }[]).find((i) => i.orderId === orderId);

it("contacts live through candidate → negotiating → in_progress, and close right after «Выполнено»", async () => {
  const { orderId, responseIds } = await setup([exec, exec2]);
  expect(await both(orderId, exec)).toEqual([200, 200]);
  expect(await both(orderId, exec2)).toEqual([200, 200]);

  const { base } = await toInProgress(orderId, responseIds[exec]!);
  expect(await status(orderId)).toBe("negotiating");
  expect(await both(orderId, exec2)).toEqual([200, 200]); // ещё кандидат: переговоры идут

  expect((await post(`${base}/start`, customer)).statusCode).toBe(200);
  expect(await both(orderId, exec)).toEqual([200, 200]);
  expect(await both(orderId, exec2)).toEqual([404, 404]); // не выбран → закрыт
  expect((await candidates(orderId)).find((c) => c.executorId === exec)?.isContactUnlocked).toBe(true);
  expect((await myResponse(orderId, exec))?.isContactUnlocked).toBe(true);
  expect((await myResponse(orderId, exec2))?.isContactUnlocked).toBe(false);

  expect((await post(`${base}/complete`, customer)).statusCode).toBe(200);
  expect(await both(orderId, exec)).toEqual([404, 404]); // сразу, без окна
  expect((await candidates(orderId)).find((c) => c.executorId === exec)?.isContactUnlocked).toBe(false);
  expect((await myResponse(orderId, exec))?.isContactUnlocked).toBe(false);
  // на завершённом заказе новые контакты не раскрываются
  expect((await post(`/orders/${orderId}/contact-unlocks`, customer, { responseId: responseIds[exec]! })).statusCode).toBe(409);
});

it("«Не выполнено» closes contacts as well", async () => {
  const { orderId, responseIds } = await setup();
  const { base } = await toInProgress(orderId, responseIds[exec]!);
  await post(`${base}/start`, customer);
  expect(await both(orderId, exec)).toEqual([200, 200]);
  expect((await post(`${base}/not-completed`, customer)).statusCode).toBe(200);
  expect(await both(orderId, exec)).toEqual([404, 404]);
});

it("withdrawn response closes the contact; cancel of the selection closes it too", async () => {
  const a = await setup();
  expect(await both(a.orderId, exec)).toEqual([200, 200]);
  expect((await app.inject({ method: "DELETE", url: `/responses/${a.responseIds[exec]}`, headers: as(exec) })).statusCode).toBe(204);
  expect(await both(a.orderId, exec)).toEqual([404, 404]);

  const b = await setup();
  const { base } = await toInProgress(b.orderId, b.responseIds[exec]!);
  expect((await post(`${base}/cancel`, customer)).statusCode).toBe(200);
  expect(await both(b.orderId, exec)).toEqual([404, 404]);
});

it("closing the order while a selection is pending drops the selection and closes contacts", async () => {
  const { orderId, responseIds } = await setup();
  const { assignmentId } = await toInProgress(orderId, responseIds[exec]!);
  expect(await status(orderId)).toBe("negotiating");
  expect((await post(`/orders/${orderId}/close`, customer)).statusCode).toBe(200);
  expect(await status(orderId)).toBe("closed");
  expect(await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.id, assignmentId) })).toBeUndefined();
  expect((await db.query.responses.findFirst({ where: eq(schema.responses.id, responseIds[exec]!) }))?.status).toBe("not_selected");
  expect(await both(orderId, exec)).toEqual([404, 404]);
});
