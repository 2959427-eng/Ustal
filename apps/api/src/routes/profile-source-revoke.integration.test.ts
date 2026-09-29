import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, PROFILE_SOURCE_SEPARATOR as SEP, schema } from "@ustal/database";
import profileRoutes from "./profile.js";
import profileFactsRoutes from "./profile-facts.js";

/**
 * Source revoke lifecycle (2026-09-28), API side on a real DB: DELETE /profile/inputs/:id is ONE revoke
 * for the facts layer and the AI profile. The version that contains the message leaves matching/feed
 * at once (rebuild_pending), drafts built on it are invalidated, the rebuild job is enqueued.
 */
const sent: { name: string; data: unknown }[] = [];
let failQueue = false;
vi.mock("@ustal/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ustal/queue")>();
  return { ...actual, getBoss: vi.fn(async () => ({ send: vi.fn(async (name: string, data: unknown) => {
    if (failQueue) throw new Error("queue down");
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
const status = async (id: string) => (await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, id) }))?.status;

async function makeUser() {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  users.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, name: "TEST revoke api", cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
  return u!.id;
}
/** Profile history as the worker leaves it: A applied → B applied (cumulative) → C pending draft. */
async function history(userId: string) {
  const texts = ["Есть Газель", "Собираю мебель", "Умею красить"];
  const inputs = [];
  for (const [i, rawText] of texts.entries()) {
    const [s] = await db.insert(schema.profileSourceInputs).values({ userId, inputType: "text", rawText, status: "confirmed", createdAt: new Date(Date.now() - (10 - i) * 60000) }).returning();
    inputs.push(s!);
  }
  const statuses = ["superseded", "applied", "draft"] as const;
  const profiles = [];
  for (const [i, s] of inputs.entries()) {
    const [p] = await db.insert(schema.capabilityProfiles).values({ userId, summary: texts.slice(0, i + 1).join(" "), profileVersion: i + 1,
      extractionVersion: "test", sourceInputId: s.id, status: statuses[i]!, createdAt: new Date(Date.now() - (9 - i) * 60000) }).returning();
    await db.insert(schema.matchingDocuments).values({ profileId: p!.id, processingVersion: "test", sourceHash: randomUUID(),
      sourceText: texts.slice(0, i + 1).join(SEP), embeddingModel: "test" });
    profiles.push(p!);
  }
  await db.insert(schema.userResources).values({ capabilityProfileId: profiles[1]!.id, ontologyNodeId: randomUUID(), label: "газель",
    resourceType: "transport", evidenceType: "explicit", confidence: "0.95" });
  const [ext] = await db.insert(schema.profileFactExtractions).values({ userId, sourceInputId: inputs[0]!.id, pipelineVersion: "t", promptVersion: "t", model: randomUUID(), status: "succeeded" }).returning();
  const [fact] = await db.insert(schema.profileFacts).values({ userId, sourceInputId: inputs[0]!.id, extractionId: ext!.id, factType: "asset", slotKey: "asset:газель",
    value: { label: "газель", number: null, numberMax: null, unit: null, period: null, level: null, flag: null, timeframe: null, approximate: false },
    evidence: "Есть Газель", confidence: "0.9", assertion: "explicit", status: "active" }).returning();
  return { inputs, profiles, fact: fact! };
}

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => { request.userId = request.headers["x-test-user"] as string; });
  for (const r of [profileRoutes, profileFactsRoutes]) await app.register(r);
  await app.ready();
  const [c] = await db.insert(schema.cities).values({ name: `TEST revoke api ${randomUUID()}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cityId = c!.id;
});
beforeEach(() => { sent.length = 0; failQueue = false; });
afterAll(async () => {
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.cities).where(eq(schema.cities.id, cityId));
  await app.close();
  await getSql().end();
});

it("revoking an applied message: facts revoked, profile leaves matching at once, drafts invalidated, rebuild enqueued", async () => {
  const u = await makeUser();
  const { inputs, profiles, fact } = await history(u);
  expect((await app.inject({ method: "GET", url: "/profile", headers: as(u) })).json()).toMatchObject({ rebuilding: false, profile: { id: profiles[1]!.id } });

  const res = await app.inject({ method: "DELETE", url: `/profile/inputs/${inputs[0]!.id}`, headers: as(u) });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ sourceInputId: inputs[0]!.id, status: "revoked", profileRebuild: "pending" });
  expect(await status(profiles[1]!.id)).toBe("rebuild_pending");
  expect(await status(profiles[0]!.id)).toBe("superseded");
  expect(await status(profiles[2]!.id)).toBe("invalidated");
  expect((await db.query.profileFacts.findFirst({ where: eq(schema.profileFacts.id, fact.id) }))).toMatchObject({ status: "revoked", userDecision: "revoked" });
  expect(await db.query.rematchRequests.findFirst({ where: eq(schema.rematchRequests.userId, u) })).toBeDefined();
  expect(sent).toEqual([{ name: "profile_rebuild", data: { userId: u } }]);

  // Nothing of the old version is shown or applied while the rebuild runs.
  expect((await app.inject({ method: "GET", url: "/profile", headers: as(u) })).json())
    .toMatchObject({ profile: null, capabilities: [], resources: [], rebuilding: true });
  expect((await app.inject({ method: "GET", url: "/profile/draft", headers: as(u) })).json()).toEqual({ draft: null });
  expect((await app.inject({ method: "POST", url: `/profile/draft/${profiles[2]!.id}/apply`, headers: as(u) })).statusCode).toBe(409);
  expect((await app.inject({ method: "GET", url: `/profile/inputs/${inputs[0]!.id}`, headers: as(u) })).json().revokedAt).not.toBeNull();
  // Raw text kept only as internal audit.
  expect((await db.query.profileSourceInputs.findFirst({ where: eq(schema.profileSourceInputs.id, inputs[0]!.id) }))?.rawText).toBe("Есть Газель");

  // Idempotent.
  const again = await app.inject({ method: "DELETE", url: `/profile/inputs/${inputs[0]!.id}`, headers: as(u) });
  expect(again.json()).toMatchObject({ profileRebuild: "pending" });
  expect(await status(profiles[1]!.id)).toBe("rebuild_pending");
});

it("a draft that appears later can not be applied while a rebuild is pending", async () => {
  const u = await makeUser();
  const { inputs, profiles } = await history(u);
  await app.inject({ method: "DELETE", url: `/profile/inputs/${inputs[0]!.id}`, headers: as(u) });
  const [late] = await db.insert(schema.capabilityProfiles).values({ userId: u, summary: "late", profileVersion: 9, extractionVersion: "test", status: "draft" }).returning();
  const res = await app.inject({ method: "POST", url: `/profile/draft/${late!.id}/apply`, headers: as(u) });
  expect(res.statusCode).toBe(409);
  expect(await status(profiles[1]!.id)).toBe("rebuild_pending");
});

it("revoking a message that is only in a pending draft: no rebuild, only its draft goes away", async () => {
  const u = await makeUser();
  const { inputs, profiles } = await history(u);
  const res = await app.inject({ method: "DELETE", url: `/profile/inputs/${inputs[2]!.id}`, headers: as(u) });
  expect(res.json()).toMatchObject({ profileRebuild: "not_needed" });
  expect(await status(profiles[1]!.id)).toBe("applied");
  expect(await status(profiles[2]!.id)).toBe("invalidated");
  expect(sent).toEqual([]);
});

it("the facts-layer alias has the same semantics", async () => {
  const u = await makeUser();
  const { inputs, profiles, fact } = await history(u);
  const res = await app.inject({ method: "DELETE", url: `/profile/facts/sources/${inputs[1]!.id}`, headers: as(u) });
  expect(res.statusCode).toBe(204);
  expect(await status(profiles[1]!.id)).toBe("rebuild_pending");
  expect((await db.query.profileFacts.findFirst({ where: eq(schema.profileFacts.id, fact.id) }))?.status).toBe("active");
  expect(sent.map((s) => s.name)).toEqual(["profile_rebuild"]);
});

it("queue failure does not fail the revoke: the profile is already out of matching, the worker sweep rebuilds it", async () => {
  const u = await makeUser();
  const { inputs, profiles } = await history(u);
  failQueue = true;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = await app.inject({ method: "DELETE", url: `/profile/inputs/${inputs[0]!.id}`, headers: as(u) });
  log.mockRestore();
  expect(res.statusCode).toBe(202);
  expect(await status(profiles[1]!.id)).toBe("rebuild_pending");
});

it("ownership: another user's message is 404 and nothing changes; bad id is 404", async () => {
  const owner = await makeUser(), other = await makeUser();
  const { inputs, profiles } = await history(owner);
  for (const url of [`/profile/inputs/${inputs[0]!.id}`, `/profile/facts/sources/${inputs[0]!.id}`, "/profile/inputs/not-a-uuid"]) {
    const res = await app.inject({ method: "DELETE", url, headers: as(other) });
    expect(res.statusCode).toBe(404);
  }
  expect((await db.query.profileSourceInputs.findFirst({ where: eq(schema.profileSourceInputs.id, inputs[0]!.id) }))?.revokedAt).toBeNull();
  expect(await status(profiles[1]!.id)).toBe("applied");
  expect(sent).toEqual([]);
});

it("a revoked voice message can not be confirmed or edited afterwards", async () => {
  const u = await makeUser();
  const [s] = await db.insert(schema.profileSourceInputs).values({ userId: u, inputType: "voice", transcript: "Есть Газель", status: "awaiting_review" }).returning();
  expect((await app.inject({ method: "DELETE", url: `/profile/inputs/${s!.id}`, headers: as(u) })).json()).toMatchObject({ profileRebuild: "not_needed" });
  expect((await app.inject({ method: "POST", url: `/profile/inputs/${s!.id}/confirm`, headers: as(u) })).statusCode).toBe(409);
  expect((await app.inject({ method: "PATCH", url: `/profile/inputs/${s!.id}`, headers: as(u), payload: { transcriptCorrected: "Есть Газель!" } })).statusCode).toBe(409);
  expect(sent).toEqual([]);
});
