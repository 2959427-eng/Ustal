import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import supportRoutes from "./support.js";
import { supportMailBody, type SupportMessage } from "../lib/support-mail.js";

assertLocalTestDatabase();
const db = getDb();
let userId: string, cityId: string;
const as = (u: string) => ({ "x-test-user": u });
async function appWith(sender: ((m: SupportMessage) => Promise<void>) | null) {
  const app = Fastify();
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const u = request.headers["x-test-user"] as string | undefined;
    if (!u) return reply.code(401).send({ error: { code: "unauthorized" } });
    request.userId = u;
  });
  await app.register(supportRoutes, { sender });
  await app.ready();
  return app;
}

beforeAll(async () => {
  const [city] = await db.insert(schema.cities).values({ name: "TEST support", regionName: "T", federalDistrict: "T", timezone: "UTC", isActive: false }).returning();
  cityId = city!.id;
  const [u] = await db.insert(schema.users).values({ phone: `+7${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}`, passwordHash: "x" }).returning();
  userId = u!.id;
  await db.insert(schema.userProfiles).values({ userId, name: "Тест Поддержки", cityId, acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
});
afterAll(async () => {
  await db.delete(schema.userProfiles).where(eq(schema.userProfiles.userId, userId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await db.delete(schema.cities).where(eq(schema.cities.id, cityId));
  await getSql().end();
});

describe("POST /support", () => {
  it("sends the message with identity taken from the database, not from the request", async () => {
    const sender = vi.fn(async (_m: SupportMessage) => {});
    const app = await appWith(sender);
    try {
      const r = await app.inject({ method: "POST", url: "/support", headers: as(userId), payload: { text: "  Не открывается заказ  ", appVersion: "1.0.0" } });
      expect(r.statusCode).toBe(202);
      expect(sender).toHaveBeenCalledTimes(1);
      const m = sender.mock.calls[0]![0];
      expect(m).toMatchObject({ userId, name: "Тест Поддержки", text: "Не открывается заказ", appVersion: "1.0.0" });
      expect(m.phone).toMatch(/^\+7\d{10}$/);
      // лишние поля (подмена имени/телефона/адреса) отклоняются
      const spoof = await app.inject({ method: "POST", url: "/support", headers: as(userId), payload: { text: "Проблема", phone: "+70000000000", to: "x@evil.test" } });
      expect(spoof.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("requires login, validates length, answers 503 when mail is not configured and 502 when sending fails", async () => {
    const ok = await appWith(async () => {});
    try {
      expect((await ok.inject({ method: "POST", url: "/support", payload: { text: "Проблема с входом" } })).statusCode).toBe(401);
      expect((await ok.inject({ method: "POST", url: "/support", headers: as(userId), payload: { text: "abc" } })).statusCode).toBe(400);
      expect((await ok.inject({ method: "POST", url: "/support", headers: as(userId), payload: { text: "x".repeat(2001) } })).statusCode).toBe(400);
    } finally { await ok.close(); }
    const off = await appWith(null);
    try { expect((await off.inject({ method: "POST", url: "/support", headers: as(userId), payload: { text: "Проблема с входом" } })).json().error.code).toBe("support_unavailable"); }
    finally { await off.close(); }
    const failing = await appWith(async () => { throw new Error("SMTP secret-host refused"); });
    try {
      const r = await failing.inject({ method: "POST", url: "/support", headers: as(userId), payload: { text: "Проблема с входом" } });
      expect(r.statusCode).toBe(502);
      expect(r.body).not.toMatch(/secret-host/);
    } finally { await failing.close(); }
  });

  it("limits a user to 5 messages per hour; failed sends do not count", async () => {
    const sender = vi.fn(async () => {});
    const app = await appWith(sender);
    try {
      for (let i = 0; i < 5; i++) expect((await app.inject({ method: "POST", url: "/support", headers: as(userId), payload: { text: `Обращение ${i}` } })).statusCode).toBe(202);
      expect((await app.inject({ method: "POST", url: "/support", headers: as(userId), payload: { text: "Шестое обращение" } })).statusCode).toBe(429);
      expect(sender).toHaveBeenCalledTimes(5);
    } finally { await app.close(); }
  });

  it("user text never reaches mail headers", () => {
    const { subject, text } = supportMailBody({ userId: "12345678-0000-4000-8000-000000000000", name: "N", phone: null,
      text: "line\r\nBcc: attacker@evil.test", appVersion: null, sentAt: new Date("2026-10-29T00:00:00Z") });
    expect(subject).toBe("USTAL: обращение в поддержку (12345678)");
    expect(text).toContain("Bcc: attacker@evil.test"); // только в теле письма как текст
  });
});
