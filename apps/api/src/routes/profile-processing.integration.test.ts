/**
 * GET /profile/draft сообщает, что сохранённое сообщение ещё обрабатывается (mobile QA 2026-10-14, M11):
 * клиент после перезапуска продолжает ждать результат без локальной отметки. Источник — сервер.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, inArray, sql } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import profileRoutes from "./profile.js";

assertLocalTestDatabase();
const db = getDb();
const users: string[] = [];
const app = Fastify();
beforeAll(async () => {
  app.decorate("authenticate", async (r: import("fastify").FastifyRequest) => { r.userId = r.headers["x-test-user"] as string; });
  await app.register(profileRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await getSql().end();
});
async function user() {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  users.push(u!.id);
  return u!.id;
}
async function input(userId: string, over: Partial<typeof schema.profileSourceInputs.$inferInsert> = {}, ageHours = 0) {
  const [i] = await db.insert(schema.profileSourceInputs).values({ userId, inputType: "text", rawText: "Есть дрель", status: "confirmed", ...over }).returning();
  if (ageHours) await db.execute(sql`update profile_source_inputs set created_at = now() - make_interval(hours => ${ageHours}) where id = ${i!.id}`);
  return i!;
}
const draft = async (userId: string) => (await app.inject({ method: "GET", url: "/profile/draft", headers: { "x-test-user": userId } })).json();

it("saved message without a result → processing with the time it was sent; result ready → not processing", async () => {
  const u = await user();
  expect(await draft(u)).toEqual({ draft: null, processing: false, processingSince: null });
  const i = await input(u);
  const r = await draft(u);
  expect(r).toMatchObject({ draft: null, processing: true });
  expect(Date.parse(r.processingSince)).toBe(i.createdAt.getTime());
  const [p] = await db.insert(schema.capabilityProfiles).values({ userId: u, summary: "s", profileVersion: 1, extractionVersion: "t", status: "draft", sourceInputId: i.id }).returning();
  const withDraft = await draft(u);
  expect(withDraft.draft.id).toBe(p!.id);
  expect(withDraft).toMatchObject({ processing: false, processingSince: null });
});

it("a newer message still processing is reported next to an existing older draft; the earliest pending time is used", async () => {
  const u = await user();
  const first = await input(u, {}, 1);
  await db.insert(schema.capabilityProfiles).values({ userId: u, summary: "s", profileVersion: 1, extractionVersion: "t", status: "draft", sourceInputId: first.id });
  const second = await input(u, { rawText: "Есть стремянка" });
  const r = await draft(u);
  expect(r.draft).not.toBeNull();
  expect(r).toMatchObject({ processing: true, processingSince: second.createdAt.toISOString() });
});

it("not processing: revoked, awaiting transcript review, invalidated-only is still pending, older than the recovery window, recovery exhausted", async () => {
  const u = await user();
  await input(u, { revokedAt: new Date() });
  await input(u, { inputType: "voice", rawText: null, status: "awaiting_review" });
  await input(u, {}, 49);
  const exhausted = await input(u);
  await db.insert(schema.profileInputRecovery).values({ sourceInputId: exhausted.id, stage: "extraction", userId: u, state: "exhausted", failedAttempts: 10 });
  expect(await draft(u)).toMatchObject({ processing: false });
  // Черновик, отменённый отзывом/отклонением (invalidated), — сообщение снова ждёт разбора.
  const inv = await input(u);
  await db.insert(schema.capabilityProfiles).values({ userId: u, summary: "s", profileVersion: 1, extractionVersion: "t", status: "invalidated", sourceInputId: inv.id });
  expect(await draft(u)).toMatchObject({ processing: true, processingSince: inv.createdAt.toISOString() });
});

it("another user's pending message is not reported", async () => {
  const a = await user(), b = await user();
  await input(a);
  expect(await draft(b)).toMatchObject({ processing: false });
  void eq;
});
