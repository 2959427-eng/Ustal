import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { JOB_TYPES } from "@ustal/queue";
import profileRoutes from "./profile.js";
import feedRoutes from "./feed.js";
import meRoutes from "./me.js";
import usersRoutes from "./users.js";
import myRoutes from "./my.js";

/**
 * Phase 1 profile_facts (SHADOW), API side: the profile input is stored and queued exactly as before;
 * the separate facts job is enqueued best-effort (its failure never changes the response); no existing
 * endpoint exposes facts; there is no facts / candidate-search endpoint at all.
 */
const sent: { name: string; data: unknown }[] = [];
let failFactsEnqueue = false;
vi.mock("@ustal/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ustal/queue")>();
  return { ...actual, getBoss: vi.fn(async () => ({ send: vi.fn(async (name: string, data: unknown) => {
    if (failFactsEnqueue && name === actual.JOB_TYPES.PROFILE_FACTS_EXTRACTION) throw new Error("queue down");
    sent.push({ name, data });
    return "job";
  }) })) };
});

process.env.NODE_ENV = "test";
assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const users: string[] = [];
let cityId: string;
const as = (u: string) => ({ "x-test-user": u, "idempotency-key": randomUUID() });
const MARKER = "СЕКРЕТНЫЙ-ФАКТ-7f3a";

async function makeUser() {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  users.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, name: "TEST facts api", cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
  return u!.id;
}

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => { request.userId = request.headers["x-test-user"] as string; });
  for (const r of [profileRoutes, feedRoutes, meRoutes, usersRoutes, myRoutes]) await app.register(r);
  await app.ready();
  const [c] = await db.insert(schema.cities).values({ name: `TEST facts api ${randomUUID()}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cityId = c!.id;
});
beforeEach(() => { sent.length = 0; failFactsEnqueue = false; delete process.env.PROFILE_FACTS_EXTRACTION; });
afterAll(async () => {
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.cities).where(eq(schema.cities.id, cityId));
  await app.close();
  await getSql().end();
});

it("POST /profile/inputs stores the raw text and enqueues profile extraction AND the separate facts job", async () => {
  const u = await makeUser();
  const res = await app.inject({ method: "POST", url: "/profile/inputs", headers: as(u), payload: { inputType: "text", text: "Есть Газель, работаю грузчиком." } });
  expect(res.statusCode).toBe(202);
  const id = res.json().sourceInputId;
  expect(sent.map((s) => s.name)).toEqual([JOB_TYPES.PROFILE_EXTRACTION, JOB_TYPES.PROFILE_FACTS_EXTRACTION]);
  expect(sent[1]!.data).toEqual({ userId: u, sourceInputId: id });
  const [row] = await db.select().from(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.id, id));
  expect(row!.rawText).toBe("Есть Газель, работаю грузчиком.");
});

it("a failing facts enqueue never breaks the input or the existing profile pipeline (logged without user text)", async () => {
  const u = await makeUser();
  failFactsEnqueue = true;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = await app.inject({ method: "POST", url: "/profile/inputs", headers: as(u), payload: { inputType: "text", text: `Текст ${MARKER}` } });
  const logged = log.mock.calls.flat().join(" ");
  log.mockRestore();
  expect(res.statusCode).toBe(202);
  expect(sent.map((s) => s.name)).toEqual([JOB_TYPES.PROFILE_EXTRACTION]);
  expect(logged).toContain("profile_facts_enqueue_failed");
  expect(logged).not.toContain(MARKER);
});

it("PROFILE_FACTS_EXTRACTION=disabled stops enqueueing the shadow job only", async () => {
  process.env.PROFILE_FACTS_EXTRACTION = "disabled";
  const u = await makeUser();
  const res = await app.inject({ method: "POST", url: "/profile/inputs", headers: as(u), payload: { inputType: "text", text: "Умею красить стены." } });
  expect(res.statusCode).toBe(202);
  expect(sent.map((s) => s.name)).toEqual([JOB_TYPES.PROFILE_EXTRACTION]);
});

it("facts never appear in existing API responses, and no facts/candidate-search endpoint exists", async () => {
  const u = await makeUser();
  const [src] = await db.insert(schema.profileSourceInputs).values({ userId: u, inputType: "text", rawText: `Умею ${MARKER}`, status: "confirmed" }).returning();
  const [ext] = await db.insert(schema.profileFactExtractions).values({ userId: u, sourceInputId: src!.id, pipelineVersion: "t", promptVersion: "t", model: "t", status: "succeeded" }).returning();
  await db.insert(schema.profileFacts).values({ userId: u, sourceInputId: src!.id, extractionId: ext!.id, factType: "compensation", slotKey: "compensation",
    value: { label: MARKER, number: 777777 }, evidence: MARKER, confidence: "0.9", assertion: "explicit", status: "active" });
  for (const url of ["/profile", "/profile/draft", "/me", "/feed", "/my/orders", "/my/responses", "/me/reputation"]) {
    const res = await app.inject({ method: "GET", url, headers: as(u) });
    expect(res.body, url).not.toContain(MARKER);
    expect(res.body, url).not.toContain("777777");
    expect(res.body, url).not.toMatch(/profile_?facts/i);
  }
  const routes = app.printRoutes({ commonPrefix: false });
  expect(routes).not.toMatch(/fact/i);
  expect(routes).not.toMatch(/candidate|search/i);
});
