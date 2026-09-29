import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import profileFactsRoutes from "./profile-facts.js";
import profileRoutes from "./profile.js";
import usersRoutes from "./users.js";
import feedRoutes from "./feed.js";
import meRoutes from "./me.js";

/** Phase 2A owner-only profile_facts API on a real DB: ownership, precedence, revocation, visibility. */
process.env.NODE_ENV = "test";
assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const users: string[] = [];
let cityId: string;
const as = (u: string) => ({ "x-test-user": u });
const v = (p: Record<string, unknown> = {}) => ({ label: null, number: null, numberMax: null, unit: null, period: null, level: null, flag: null, timeframe: null, approximate: false, ...p });

async function makeUser() {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  users.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, name: "TEST facts owner", cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
  return u!.id;
}
/** An AI fact as the worker would store it (status resolved by hand: one per slot). */
async function aiFact(userId: string, over: Record<string, unknown> = {}, created = new Date()) {
  const [src] = await db.insert(schema.profileSourceInputs).values({ userId, inputType: "text", rawText: "Рассматриваю работу от 300 тыс.", status: "confirmed", createdAt: created }).returning();
  const [ext] = await db.insert(schema.profileFactExtractions).values({ userId, sourceInputId: src!.id, pipelineVersion: "t", promptVersion: "t", model: randomUUID(), status: "succeeded" }).returning();
  const [f] = await db.insert(schema.profileFacts).values({ userId, sourceInputId: src!.id, extractionId: ext!.id, factType: "compensation", slotKey: "compensation",
    value: v({ number: 300000 }), evidence: "от 300 тыс.", confidence: "0.9", assertion: "explicit", status: "active", ...over }).returning();
  return f!;
}
const get = (id: string) => db.select().from(schema.profileFacts).where(eq(schema.profileFacts.id, id)).then((r) => r[0]!);

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => { request.userId = request.headers["x-test-user"] as string; });
  for (const r of [profileFactsRoutes, profileRoutes, usersRoutes, feedRoutes, meRoutes]) await app.register(r);
  await app.ready();
  const [c] = await db.insert(schema.cities).values({ name: `TEST facts owner ${randomUUID()}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cityId = c!.id;
});
afterAll(async () => {
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.cities).where(eq(schema.cities.id, cityId));
  await app.close();
  await getSql().end();
});

it("ownership: only my facts are listed; every mutation on another user's fact is 404 and changes nothing", async () => {
  const a = await makeUser(), b = await makeUser();
  const fa = await aiFact(a);
  await aiFact(b);
  const list = await app.inject({ method: "GET", url: "/profile/facts", headers: as(b) });
  expect(list.json().facts.map((f: { id: string }) => f.id)).not.toContain(fa.id);
  for (const [method, url, payload] of [
    ["POST", `/profile/facts/${fa.id}/confirm`, undefined],
    ["PATCH", `/profile/facts/${fa.id}`, { value: { number: 1 } }],
    ["PATCH", `/profile/facts/${fa.id}/visibility`, { visibility: "shareable" }],
    ["DELETE", `/profile/facts/${fa.id}`, undefined],
    ["DELETE", `/profile/facts/sources/${fa.sourceInputId}`, undefined],
    ["POST", `/profile/facts/not-a-uuid/confirm`, undefined],
  ] as const) {
    const res = await app.inject({ method, url, headers: as(b), payload });
    expect(res.statusCode, `${method} ${url}`).toBe(404);
  }
  expect(await get(fa.id)).toMatchObject({ status: "active", userDecision: null, visibility: "private" });
});

it("new facts are private; the DTO shows trust and never raw internals of other users", async () => {
  const u = await makeUser();
  const f = await aiFact(u, { assertion: "inferred", confidence: "0.6" });
  const [dto] = (await app.inject({ method: "GET", url: "/profile/facts", headers: as(u) })).json().facts;
  expect(dto).toMatchObject({ id: f.id, visibility: "private", trust: "ai_inferred", status: "active", value: { number: 300000 } });
  expect(dto.extractionId).toBeUndefined();
});

it("confirm: a user-confirmed older fact outranks a newer AI fact in the same slot", async () => {
  const u = await makeUser();
  const older = await aiFact(u, { status: "superseded" }, new Date("2026-01-01"));
  const newer = await aiFact(u, { value: v({ number: 500000 }), evidence: "от 300 тыс." }, new Date("2026-06-01"));
  const res = await app.inject({ method: "POST", url: `/profile/facts/${older.id}/confirm`, headers: as(u) });
  expect(res.statusCode).toBe(200);
  expect(res.json().fact).toMatchObject({ trust: "user_confirmed", status: "active" });
  expect(await get(newer.id)).toMatchObject({ status: "superseded", supersededByFactId: older.id });
});

it("correct: corrected > confirmed > AI; AI value kept for audit; slot recomputed; sensitive/invalid rejected", async () => {
  const u = await makeUser();
  const confirmed = await aiFact(u, { userDecision: "confirmed", decidedAt: new Date() }, new Date("2026-06-01"));
  const lang = await aiFact(u, { factType: "language", slotKey: "language:английский", value: v({ label: "английский" }), evidence: "английский", status: "active" });
  const other = await aiFact(u, { status: "superseded" }, new Date("2026-01-01"));
  const res = await app.inject({ method: "PATCH", url: `/profile/facts/${other.id}`, headers: as(u), payload: { value: { number: 450000 } } });
  expect(res.statusCode).toBe(200);
  expect(res.json().fact).toMatchObject({ trust: "user_corrected", status: "active", value: { number: 450000 }, aiValue: { number: 300000 } });
  expect(await get(confirmed.id)).toMatchObject({ status: "superseded", supersededByFactId: other.id });
  const renamed = await app.inject({ method: "PATCH", url: `/profile/facts/${lang.id}`, headers: as(u), payload: { value: { label: "немецкий", level: "B1" } } });
  expect(await get(lang.id)).toMatchObject({ slotKey: "language:немецкий", userDecision: "corrected", status: "active" });
  expect(renamed.statusCode).toBe(200);
  expect((await app.inject({ method: "PATCH", url: `/profile/facts/${lang.id}`, headers: as(u), payload: { value: { label: "диабет" } } })).statusCode).toBe(422);
  expect((await app.inject({ method: "PATCH", url: `/profile/facts/${lang.id}`, headers: as(u), payload: { value: { label: null } } })).statusCode).toBe(400);
  expect((await app.inject({ method: "PATCH", url: `/profile/facts/${lang.id}`, headers: as(u), payload: { value: {} } })).statusCode).toBe(400);
  expect(await get(lang.id)).toMatchObject({ userValue: expect.objectContaining({ label: "немецкий" }) });
});

it("revoke: terminal, hidden from the current list, the next best fact of the slot becomes active", async () => {
  const u = await makeUser();
  const older = await aiFact(u, { status: "superseded" }, new Date("2026-01-01"));
  const newer = await aiFact(u, {}, new Date("2026-06-01"));
  expect((await app.inject({ method: "DELETE", url: `/profile/facts/${newer.id}`, headers: as(u) })).statusCode).toBe(204);
  expect(await get(newer.id)).toMatchObject({ status: "revoked", userDecision: "revoked", userValue: null });
  expect(await get(older.id)).toMatchObject({ status: "active" });
  const current = (await app.inject({ method: "GET", url: "/profile/facts", headers: as(u) })).json().facts.map((f: { id: string }) => f.id);
  const all = (await app.inject({ method: "GET", url: "/profile/facts?include=all", headers: as(u) })).json().facts.map((f: { id: string }) => f.id);
  expect(current).not.toContain(newer.id);
  expect(all).toContain(newer.id);
  for (const [method, url, payload] of [["POST", `/profile/facts/${newer.id}/confirm`, undefined], ["PATCH", `/profile/facts/${newer.id}`, { value: { number: 1 } }], ["PATCH", `/profile/facts/${newer.id}/visibility`, { visibility: "shareable" }]] as const)
    expect((await app.inject({ method, url, headers: as(u), payload })).statusCode).toBe(409);
  expect((await app.inject({ method: "DELETE", url: `/profile/facts/${newer.id}`, headers: as(u) })).statusCode).toBe(204); // idempotent
});

it("visibility: private by default, owner can switch to shareable; anything else is rejected", async () => {
  const u = await makeUser();
  const f = await aiFact(u);
  expect((await app.inject({ method: "PATCH", url: `/profile/facts/${f.id}/visibility`, headers: as(u), payload: { visibility: "public" } })).statusCode).toBe(400);
  const res = await app.inject({ method: "PATCH", url: `/profile/facts/${f.id}/visibility`, headers: as(u), payload: { visibility: "shareable" } });
  expect(res.json().fact.visibility).toBe("shareable");
});

it("withdrawing a source revokes every fact derived from it (confirmed included) and marks the source", async () => {
  const u = await makeUser();
  const f = await aiFact(u, { userDecision: "confirmed", decidedAt: new Date() });
  expect((await app.inject({ method: "DELETE", url: `/profile/facts/sources/${f.sourceInputId}`, headers: as(u) })).statusCode).toBe(204);
  expect(await get(f.id)).toMatchObject({ status: "revoked", userDecision: "revoked" });
  const [src] = await db.select().from(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.id, f.sourceInputId));
  expect(src!.revokedAt).not.toBeNull();
  expect(src!.rawText).toBe("Рассматриваю работу от 300 тыс."); // raw text retained (existing retention policy)
});

it("existing endpoints never expose facts; the facts API has no candidate search or foreign-user route", async () => {
  const u = await makeUser();
  await aiFact(u, { value: v({ number: 987654 }), evidence: "от 300 тыс." });
  for (const url of ["/profile", "/profile/draft", "/me"]) expect((await app.inject({ method: "GET", url, headers: as(u) })).body).not.toContain("987654");
  const routes = app.printRoutes({ commonPrefix: false }).split("\n").filter((l) => /fact/i.test(l)).join("\n");
  expect(routes).not.toMatch(/user|candidate|search/i);
});
