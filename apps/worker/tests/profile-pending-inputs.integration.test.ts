/**
 * QA 2026-10-14 R6: pending inputs must form a cumulative proposal.
 * Uses the real worker, PostgreSQL persistence and API with deterministic AI.
 * Kept outside src because this integration suite spans API and worker rootDirs.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { assertLocalTestDatabase, getDb, getSql, loadInputsToReextract, schema } from "@ustal/database";
import { and, eq, inArray } from "drizzle-orm";
import { mockProviders } from "@ustal/ai";
vi.mock("@ustal/queue", async (orig) => ({ ...(await orig<typeof import("@ustal/queue")>()), getBoss: vi.fn(async () => ({ send: vi.fn(async () => "job") })) }));
const { handleProfileExtraction } = await import("../src/handlers/profile-extraction.js");
const profileRoutes = (await import("../../api/src/routes/profile.js")).default;
const { revokeProfileSourceInput } = await import("../../api/src/lib/source-revoke.js");
const { rebuildProfileIfNeeded } = await import("../src/profile-rebuild.js");
const app = Fastify();
assertLocalTestDatabase();
const db = getDb();
const fixtureUsers: string[] = [], fixtureCities: string[] = [];
const wrap = (data: unknown) => ({ data, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 }) as never;
const res = (phrase: string, key: string | null, ev: string) => ({ kind: "resource", subjectType: "physical_resource", resourceRole: "available", canonicalKeys: key ? [key] : [],
  confidence: 0.95, mandatory: false, constraintType: "none", constraintScope: "whole_task", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null, phrase, evidence: ev });
const ANSWERS: Record<string, [string, string | null]> = { "Есть машина": ["машина", "car"], "Есть дрель": ["дрель", "drill"], "Есть стремянка": ["стремянка", "ladder"],
  "Есть самолёт": ["самолёт", null], "есть самолет": ["самолет", null], "Есть кофемашина": ["кофемашина", null], "Есть кофемашина.": ["кофемашина.", null] };
let duringNormalization: (() => Promise<void>) | undefined;
beforeAll(async () => {
  app.decorate("authenticate", async (r: import("fastify").FastifyRequest) => { r.userId = r.headers["x-test-user"] as string; });
  await app.register(profileRoutes); await app.ready();
  vi.spyOn(mockProviders.extraction, "extractCapabilityProfile").mockImplementation(async (i) => wrap({ summary: i.text, capabilities: [], resources: [] }));
  vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (i) => {
    await duringNormalization?.();
    const parts = i.text.split('\nПоследнее изменение пользователя:\n');
    const facts = parts.map((text) => { const [p, k] = ANSWERS[text]!; return res(p, k, text); });
    return wrap({ facts });
  });
});
afterAll(async () => {
  await app.close();
  if (fixtureUsers.length) await db.delete(schema.users).where(inArray(schema.users.id, fixtureUsers));
  if (fixtureCities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, fixtureCities));
  await getSql().end();
});
async function newUser() {
  const [city] = await db.insert(schema.cities).values({ name: "QA_R_" + randomUUID(), regionName: "QA", federalDistrict: "QA", timezone: "Asia/Vladivostok", isActive: false }).returning();
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "qa", status: "active" }).returning();
  fixtureUsers.push(u!.id); fixtureCities.push(city!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, cityId: city!.id, name: "QA", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
  return u!.id;
}
const send = async (userId: string, text: string) => {
  const [i] = await db.insert(schema.profileSourceInputs).values({ userId, inputType: "text", rawText: text, status: "confirmed" }).returning();
  return handleProfileExtraction({ id: randomUUID(), data: { userId, sourceInputId: i!.id } } as never);
};
const apply = (userId: string, id: string) => app.inject({ method: "POST", url: `/profile/draft/${id}/apply`, headers: { "x-test-user": userId, "idempotency-key": randomUUID() } });
const resources = async (userId: string) => {
  const p = (await app.inject({ method: "GET", url: "/profile", headers: { "x-test-user": userId } })).json();
  return [...p.resources.map((r: { label: string }) => r.label), ...p.unmapped.filter((u: { kind: string }) => u.kind === "resource").map((u: { phrase: string }) => u.phrase)].sort();
};

it("R6 «Есть дрель» then «Есть стремянка» before draft 1 is applied: both are kept", async () => {
  const u = await newUser();
  await apply(u, (await send(u, "Есть машина")).profileId);
  const d1 = await send(u, "Есть дрель");
  const d2 = await send(u, "Есть стремянка");
  expect((await apply(u, d1.profileId)).statusCode).toBe(200);
  expect((await apply(u, d2.profileId)).statusCode).toBe(200);
  expect(await resources(u)).toEqual(["дрель", "машина", "стремянка"]);
});

it("applying only the latest pending draft retains both messages in UI and matching source", async () => {
  const u = await newUser();
  await send(u, "Есть дрель");
  const d = await send(u, "Есть стремянка");
  expect((await apply(u, d.profileId)).statusCode).toBe(200);
  expect(await resources(u)).toEqual(["дрель", "стремянка"]);
  const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, d.profileId) });
  expect(doc!.sourceText).toContain("Есть дрель");
  expect(doc!.sourceText).toContain("Есть стремянка");
  const facts = await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc!.id));
  expect(facts.filter((f) => f.kind === "resource").map((f) => f.phrase).sort()).toEqual(["дрель", "стремянка"]);
});

it("simultaneous extraction rebases the losing snapshot", async () => {
  const u = await newUser();
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  duringNormalization = async () => { if (++arrived === 2) release(); if (arrived <= 2) await gate; };
  try {
    const drafts = await Promise.all([send(u, "Есть дрель"), send(u, "Есть стремянка")]);
    const latest = drafts.sort((a, b) => b.profileVersion - a.profileVersion)[0]!;
    expect((await apply(u, latest.profileId)).statusCode).toBe(200);
    expect(await resources(u)).toEqual(["дрель", "стремянка"]);
    expect(arrived).toBe(3);
  } finally { duringNormalization = undefined; }
});

it("discarding an earlier proposal invalidates dependents and re-extracts only the retained message", async () => {
  const u = await newUser();
  const d1 = await send(u, "Есть дрель");
  const d2 = await send(u, "Есть стремянка");
  expect((await app.inject({ method: "POST", url: `/profile/draft/${d1.profileId}/discard`, headers: { "x-test-user": u } })).statusCode).toBe(204);
  expect((await apply(u, d2.profileId)).statusCode).toBe(409);
  const inputs = await loadInputsToReextract(db, u);
  expect(inputs).toHaveLength(1);
  const rebuilt = await handleProfileExtraction({ id: randomUUID(), data: { userId: u, sourceInputId: inputs[0]! } } as never);
  expect((await apply(u, rebuilt.profileId)).statusCode).toBe(200);
  expect(await resources(u)).toEqual(["стремянка"]);
});

it("revoking a pending source invalidates dependent drafts and never restores the revoked item", async () => {
  const u = await newUser();
  const d1 = await send(u, "Есть дрель");
  const d2 = await send(u, "Есть стремянка");
  const p = await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, d1.profileId) });
  await revokeProfileSourceInput(u, p!.sourceInputId!);
  expect((await apply(u, d2.profileId)).statusCode).toBe(409);
  const inputs = await loadInputsToReextract(db, u);
  expect(inputs).toHaveLength(1);
  const rebuilt = await handleProfileExtraction({ id: randomUUID(), data: { userId: u, sourceInputId: inputs[0]! } } as never);
  expect((await apply(u, rebuilt.profileId)).statusCode).toBe(200);
  expect(await resources(u)).toEqual(["стремянка"]);
});

it("discard during AI work rebases the in-flight message", async () => {
  const u = await newUser();
  const d1 = await send(u, "Есть дрель");
  duringNormalization = async () => {
    duringNormalization = undefined;
    expect((await app.inject({ method: "POST", url: `/profile/draft/${d1.profileId}/discard`, headers: { "x-test-user": u } })).statusCode).toBe(204);
  };
  try {
    const d2 = await send(u, "Есть стремянка");
    expect((await apply(u, d2.profileId)).statusCode).toBe(200);
    expect(await resources(u)).toEqual(["стремянка"]);
  } finally { duringNormalization = undefined; }
});

it("duplicate delivery returns the existing draft rather than duplicating the input", async () => {
  const u = await newUser();
  const d = await send(u, "Есть дрель");
  const p = await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, d.profileId) });
  expect(await handleProfileExtraction({ id: randomUUID(), data: { userId: u, sourceInputId: p!.sourceInputId! } } as never)).toEqual(d);
  const versions = await db.select().from(schema.capabilityProfiles).where(and(eq(schema.capabilityProfiles.userId, u), eq(schema.capabilityProfiles.sourceInputId, p!.sourceInputId!)));
  expect(versions).toHaveLength(1);
});

it("applying the base during AI work keeps both messages and rejects later rollback", async () => {
  const u = await newUser();
  const d1 = await send(u, "Есть дрель");
  duringNormalization = async () => {
    duringNormalization = undefined;
    expect((await apply(u, d1.profileId)).statusCode).toBe(200);
  };
  try {
    const d2 = await send(u, "Есть стремянка");
    expect((await apply(u, d2.profileId)).statusCode).toBe(200);
    expect((await apply(u, d1.profileId)).statusCode).toBe(409);
    expect(await resources(u)).toEqual(["дрель", "стремянка"]);
  } finally { duringNormalization = undefined; }
});

it("revoking a message included through an older pending draft rebuilds the applied lineage", async () => {
  const u = await newUser();
  const d1 = await send(u, "Есть дрель");
  const d2 = await send(u, "Есть стремянка");
  expect((await apply(u, d2.profileId)).statusCode).toBe(200);
  const p = await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, d1.profileId) });
  expect(await revokeProfileSourceInput(u, p!.sourceInputId!)).toEqual({ profileRebuild: "pending" });
  expect((await rebuildProfileIfNeeded(u)).action).toBe("rebuilt");
  expect(await resources(u)).toEqual(["стремянка"]);
});
