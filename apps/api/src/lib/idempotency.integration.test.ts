/**
 * QA 2026-10-14, дефект №7: одинаковый Idempotency-Key — ровно одно выполнение запроса. Защита на уровне БД
 * (резерв ключа в idempotency_keys до выполнения), проверяется настоящим PostgreSQL и маршрутом профиля.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";

const sent: { name: string; data: { sourceInputId?: string }; options?: { singletonKey?: string } }[] = [];
vi.mock("@ustal/queue", async (orig) => ({ ...(await orig<typeof import("@ustal/queue")>()),
  getBoss: vi.fn(async () => ({ send: vi.fn(async (name: string, data: never, options?: never) => { sent.push({ name, data, options }); return "job"; }) })) }));
const profileRoutes = (await import("../routes/profile.js")).default;
const { withIdempotency } = await import("./idempotency.js");

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const users: string[] = [];
let calls = 0;
let failNext = false;
beforeAll(async () => {
  app.decorate("authenticate", async (r: FastifyRequest) => { r.userId = r.headers["x-test-user"] as string; });
  await app.register(profileRoutes);
  app.post("/qa/idem", { preHandler: (app as unknown as { authenticate: never }).authenticate }, async (request, reply) => {
    await withIdempotency(request, reply, "POST /qa/idem", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      if (failNext) { failNext = false; throw new Error("transient"); }
      return { status: 201, body: { call: calls } };
    });
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await getSql().end();
});
async function user() {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "qa", status: "active" }).returning();
  users.push(u!.id);
  return u!.id;
}
const post = (userId: string, key: string, payload: unknown, url = "/profile/inputs") =>
  app.inject({ method: "POST", url, payload: payload as never, headers: { "x-test-user": userId, "idempotency-key": key } });
const inputsOf = (userId: string) => db.select().from(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.userId, userId));
const extractionJobs = (ids: string[]) => sent.filter((s) => s.name === "profile_extraction" && ids.includes(s.data.sourceInputId!));

describe("Idempotency-Key на POST /profile/inputs", () => {
  it("стресс: 100 конкурентных запросов одного пользователя с одним ключом → одна запись, одна задача, 100 одинаковых ответов", async () => {
    const u = await user();
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 100 }, () => post(u, key, { inputType: "text", text: "Есть дрель" })));
    expect(new Set(responses.map((r) => r.statusCode))).toEqual(new Set([202]));
    expect(new Set(responses.map((r) => JSON.stringify(r.json(), Object.keys(r.json()).sort()))).size).toBe(1);
    const rows = await inputsOf(u);
    expect(rows).toHaveLength(1);
    expect(responses[0]!.json()).toEqual({ sourceInputId: rows[0]!.id, status: "processing" });
    expect(extractionJobs([rows[0]!.id])).toHaveLength(1);
    expect(extractionJobs([rows[0]!.id])[0]!.options?.singletonKey).toBe(`profile-extraction:${rows[0]!.id}`);
  }, 60_000);

  it("повтор после успеха — тот же ответ, без новой записи и задачи", async () => {
    const u = await user();
    const key = randomUUID();
    const first = await post(u, key, { inputType: "text", text: "Есть стремянка" });
    const again = await Promise.all(Array.from({ length: 5 }, () => post(u, key, { inputType: "text", text: "Есть стремянка" })));
    for (const r of again) expect([r.statusCode, r.json()]).toEqual([first.statusCode, first.json()]);
    const rows = await inputsOf(u);
    expect(rows).toHaveLength(1);
    expect(extractionJobs([rows[0]!.id])).toHaveLength(1);
  });

  it("одинаковый ключ у разных пользователей не конфликтует: 20 пользователей одновременно — у каждого своя запись", async () => {
    const key = randomUUID();
    const us = await Promise.all(Array.from({ length: 20 }, () => user()));
    const responses = await Promise.all(us.map((u) => post(u, key, { inputType: "text", text: "Есть перфоратор" })));
    expect(responses.map((r) => r.statusCode)).toEqual(us.map(() => 202));
    const rows = await db.select().from(schema.profileSourceInputs).where(inArray(schema.profileSourceInputs.userId, us));
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((r) => r.userId)).size).toBe(20);
  });

  it("тот же ключ с другим телом → 409 и одна запись, даже если запросы пришли одновременно", async () => {
    const u = await user();
    const key = randomUUID();
    const rs = await Promise.all([post(u, key, { inputType: "text", text: "Есть болгарка" }), post(u, key, { inputType: "text", text: "Есть лобзик" })]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(rs.find((r) => r.statusCode === 409)!.json().error.code).toBe("idempotency_key_conflict");
    expect(await inputsOf(u)).toHaveLength(1);
  });

  it("сбой очереди после сохранения ввода → 202 (восстановит worker), повтор с тем же ключом не создаёт второй ввод", async () => {
    const u = await user();
    const key = randomUUID();
    const queue = await import("@ustal/queue");
    vi.mocked(queue.getBoss).mockRejectedValueOnce(new Error("queue down"));
    const r = await post(u, key, { inputType: "text", text: "Есть тачка" });
    expect(r.statusCode).toBe(202);
    const again = await post(u, key, { inputType: "text", text: "Есть тачка" });
    expect(again.json()).toEqual(r.json());
    expect(await inputsOf(u)).toHaveLength(1);
  });

  it("ответ 4xx (лимит / неверное тело) сохраняется как ответ ключа; запрос без ключа и длинный ключ → 400", async () => {
    const u = await user();
    const bad = await post(u, randomUUID(), { inputType: "voice", audioMediaId: randomUUID() });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/profile/inputs", payload: { inputType: "text", text: "x" }, headers: { "x-test-user": u } })).statusCode).toBe(400);
    expect((await post(u, "k".repeat(201), { inputType: "text", text: "x" })).json().error.code).toBe("idempotency_key_invalid");
  });
});

describe("резерв ключа", () => {
  it("handler упал → резерв снят, повтор с тем же ключом выполняется заново (один раз)", async () => {
    const u = await user();
    const key = randomUUID();
    failNext = true;
    const before = calls;
    expect((await post(u, key, {}, "/qa/idem")).statusCode).toBe(500);
    const rs = await Promise.all(Array.from({ length: 10 }, () => post(u, key, {}, "/qa/idem")));
    expect(rs.map((r) => r.statusCode)).toEqual(rs.map(() => 201));
    expect(calls - before).toBe(2);
    expect(new Set(rs.map((r) => r.json().call)).size).toBe(1);
  });

  it("брошенный резерв (процесс API упал посреди запроса) перехватывается ровно одним запросом через 2 минуты", async () => {
    const u = await user();
    const key = randomUUID();
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(JSON.stringify({})).digest("hex");
    await db.insert(schema.idempotencyKeys).values({ userId: u, endpoint: "POST /qa/idem", key, requestHash: hash, responseStatus: 0, responseBody: {},
      createdAt: new Date(Date.now() - 3 * 60_000) });
    const before = calls;
    const rs = await Promise.all(Array.from({ length: 10 }, () => post(u, key, {}, "/qa/idem")));
    expect(rs.map((r) => r.statusCode)).toEqual(rs.map(() => 201));
    expect(calls - before).toBe(1);
    const [row] = await db.select().from(schema.idempotencyKeys).where(and(eq(schema.idempotencyKeys.userId, u), eq(schema.idempotencyKeys.key, key)));
    expect(row!.responseStatus).toBe(201);
  });

  it("ожидающий запрос получает сохранённый ответ, как только первый завершится; статус 0 клиенту не уходит", async () => {
    const u = await user();
    const key = randomUUID();
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(JSON.stringify({})).digest("hex");
    const [row] = await db.insert(schema.idempotencyKeys).values({ userId: u, endpoint: "POST /qa/idem", key, requestHash: hash, responseStatus: 0, responseBody: {} }).returning();
    const waiting = post(u, key, {}, "/qa/idem");
    await new Promise((r) => setTimeout(r, 300));
    await db.update(schema.idempotencyKeys).set({ responseStatus: 201, responseBody: { call: "first" } }).where(eq(schema.idempotencyKeys.id, row!.id));
    const r = await waiting;
    expect([r.statusCode, r.json()]).toEqual([201, { call: "first" }]);
  });
});
