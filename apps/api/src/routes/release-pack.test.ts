import Fastify from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  order: null as Record<string, unknown> | null,
  responses: [] as Record<string, unknown>[],
  device: null as Record<string, unknown> | null,
  blocked: false,
  conditions: [] as unknown[],
}));
vi.mock("../lib/blocks.js", () => ({ areBlocked: async () => state.blocked, blockedCounterparts: async () => new Set() }));
vi.mock("@ustal/database", async (original) => {
  const actual = await original<typeof import("@ustal/database")>();
  const params = (where: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(where).params;
  const filtered = (where: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    const p = params(where); state.conditions.push(p);
    return state.responses.filter((r) => r.executorId === p[0] && (p.length === 1 || r.orderId === p[1]));
  };
  return { ...actual, getDb: () => ({
    query: {
      orders: { findFirst: async () => state.order, findMany: async () => state.order ? [state.order] : [] },
      users: { findFirst: async () => ({ status: "active" }) },
      responses: { findFirst: async ({ where }: { where: Parameters<PgDialect["sqlToQuery"]>[0] }) => { const p = params(where); return state.responses.find((r) => r.orderId === p[0] && r.executorId === p[1]); }, findMany: async ({ where, limit, offset }: { where: Parameters<PgDialect["sqlToQuery"]>[0]; limit: number; offset: number }) => filtered(where).slice(offset, offset + limit) },
      cities: { findFirst: async () => ({ name: "City" }) },
      orderMedia: { findMany: async () => [{ mediaId: "photo", position: 0 }] },
      contactUnlocks: { findMany: async () => [] },
      orderAssignments: { findMany: async () => [{ orderId: state.order?.id, id: "assignment", status: "in_progress", executorReport: null }] },
    },
    // Число активных откликов для приёма откликов (order-view, 2026-10-15): лимит не достигнут.
    select: () => ({ from: () => ({ where: async () => [{ n: 0 }] }) }),
    insert: () => ({ values: (values: Record<string, unknown>) => ({ onConflictDoUpdate: () => ({ returning: async () => { state.device = { id: "device", ...values }; return [state.device]; } }) }) }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async (where: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const p = params(where); state.conditions.push(p);
      if (state.device && state.device.userId === p[0] && state.device.expoPushToken === p[1]) Object.assign(state.device, values);
    } }) }),
  }) };
});
import devicesRoutes from "./devices.js";
import orderViewRoutes from "./order-view.js";
import myRoutes from "./my.js";
const orderId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const as = (id: string) => ({ "x-test-user": id });
async function appFor(route: typeof devicesRoutes) {
  const app = Fastify();
  app.decorate("authenticate", async (r: import("fastify").FastifyRequest) => { r.userId = r.headers["x-test-user"] as string; });
  await app.register(route); return app;
}
beforeEach(() => {
  state.responses = []; state.blocked = false; state.device = null; state.conditions = [];
  state.order = { id: orderId, authorId: "A", cityId: "city", status: "published", sourceText: "Real order text", normalizedTitle: "AI title", normalizedDescription: "AI text", priceMinor: 4200, acceptsPriceOffers: true, currency: "RUB", transcript: "private", riskLevel: 1 };
});
it("A register -> A detach -> B register; stale A detach cannot deactivate B", async () => {
  const app = await appFor(devicesRoutes);
  const payload = { expoPushToken: "ExponentPushToken[test-token]", platform: "ios" };
  try {
    expect((await app.inject({ method: "POST", url: "/devices", headers: as("A"), payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/devices", headers: as("A"), payload })).statusCode).toBe(204);
    expect(state.device?.isActive).toBe(false);
    await app.inject({ method: "POST", url: "/devices", headers: as("B"), payload });
    await app.inject({ method: "DELETE", url: "/devices", headers: as("A"), payload });
    expect(state.device).toMatchObject({ userId: "B", isActive: true });
  } finally { await app.close(); }
});
it("returns canonical public fields with just orderId, never private AI/transcript/contact fields", async () => {
  const app = await appFor(orderViewRoutes);
  try {
    const res = await app.inject({ url: `/orders/${orderId}/view`, headers: as("B") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ description: "Real order text", priceMinor: 4200, acceptsPriceOffers: true, photoMediaIds: ["photo"], canRespond: true, acceptingResponses: true });
    for (const key of ["transcript", "phone", "riskLevel", "requirements"]) expect(res.json()).not.toHaveProperty(key);
    state.order!.status = "processing";
    expect((await app.inject({ url: `/orders/${orderId}/view`, headers: as("B") })).statusCode).toBe(404);
    state.order!.status = "in_progress"; state.responses = [{ id: "r", orderId, executorId: "B" }];
    expect((await app.inject({ url: `/orders/${orderId}/view`, headers: as("B") })).statusCode).toBe(200);
    expect((await app.inject({ url: `/orders/${orderId}/view`, headers: as("C") })).statusCode).toBe(404);
    state.blocked = true;
    expect((await app.inject({ url: `/orders/${orderId}/view`, headers: as("B") })).statusCode).toBe(404);
  } finally { await app.close(); }
});
it("per-order lookup finds response 61 and retains its assignment actions; isolates owner", async () => {
  state.responses = Array.from({ length: 61 }, (_, i) => ({ id: `r${i}`, executorId: "B", orderId: i === 60 ? orderId : `other${i}`, status: "active", createdAt: new Date() }));
  const app = await appFor(myRoutes);
  try {
    const res = await app.inject({ url: `/my/responses?limit=1&orderId=${orderId}`, headers: as("B") });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({ id: "r60", assignmentId: "assignment", assignmentStatus: "in_progress" });
    expect(state.conditions).toContainEqual(["B", orderId]);
    const other = await app.inject({ url: `/my/responses?limit=1&orderId=${orderId}`, headers: as("C") });
    expect(other.json().items).toEqual([]);
  } finally { await app.close(); }
});
