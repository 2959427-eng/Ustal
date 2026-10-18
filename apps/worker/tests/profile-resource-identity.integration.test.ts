import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, PROFILE_SOURCE_SEPARATOR, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";

assertLocalTestDatabase();
vi.mock("@ustal/queue", async (orig) => ({ ...(await orig<typeof import("@ustal/queue")>()), getBoss: vi.fn(async () => ({ send: vi.fn(async () => "job") })) }));
const { handleProfileExtraction } = await import("../src/handlers/profile-extraction.js");
const profileRoutes = (await import("../../api/src/routes/profile.js")).default;
const db = getDb(), app = Fastify();
const users: string[] = [], cities: string[] = [];
const wrap = <T>(data: T) => ({ data, provider: "mock", model: "qa-resource-identity", tokensInput: 0, tokensOutput: 0, latencyMs: 0 });
let lastOnly = false;
const axes = new Map<string, number>();

beforeAll(async () => {
  app.decorate("authenticate", async (r: import("fastify").FastifyRequest) => { r.userId = r.headers["x-test-user"] as string; });
  await app.register(profileRoutes); await app.ready();
  vi.spyOn(mockProviders.extraction, "extractCapabilityProfile").mockImplementation(async (i) => wrap({ summary: i.text, capabilities: [], resources: [] }));
  vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (i) => {
    const segments = i.text.split(PROFILE_SOURCE_SEPARATOR);
    const facts = (lastOnly ? segments.slice(-1) : segments).map((evidence) => {
      const phrase = evidence.replace(/^(?:Есть|Нет|Снова есть) /u, "");
      return { kind: "resource" as const, subjectType: "physical_resource" as const,
        phrase, evidence, canonicalKeys: phrase.trim().toLowerCase() === "машина" ? ["car"] : [],
        resourceRole: evidence.startsWith("Нет ") ? "missing" as const : "available" as const,
        confidence: 0.95, mandatory: false, constraintType: "none" as const, constraintScope: "whole_task" as const,
        resourceCapacity: { value: null, unit: null, kind: null }, startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null };
    });
    return wrap({ facts });
  });
  // Different literal spellings have orthogonal embeddings: lexical identity,
  // rather than a lucky cosine score, must resolve the revoke/restore scenarios.
  vi.spyOn(mockProviders.embedding, "embed").mockImplementation(async (texts) => wrap({ vectors: texts.map((t) => {
    if (!axes.has(t)) axes.set(t, axes.size);
    return Array.from({ length: 1536 }, (_, i) => i === axes.get(t) ? 1 : 0);
  }) }));
});
afterAll(async () => {
  await app.close();
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  vi.restoreAllMocks(); await getSql().end();
});
async function newUser() {
  const [city] = await db.insert(schema.cities).values({ name: "QA_ID_" + randomUUID(), regionName: "QA", federalDistrict: "QA", timezone: "Asia/Vladivostok", isActive: false }).returning();
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "qa-local", status: "active" }).returning();
  users.push(u!.id); cities.push(city!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, cityId: city!.id, name: "QA Identity", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
  return u!.id;
}
async function add(u: string, text: string) {
  const [input] = await db.insert(schema.profileSourceInputs).values({ userId: u, inputType: "text", rawText: text, status: "confirmed" }).returning();
  const d = await handleProfileExtraction({ id: randomUUID(), data: { userId: u, sourceInputId: input!.id } } as never);
  expect((await app.inject({ method: "POST", url: `/profile/draft/${d.profileId}/apply`, headers: { "x-test-user": u } })).statusCode).toBe(200);
  return d.profileId;
}
async function state(u: string, profileId: string) {
  const p = (await app.inject({ method: "GET", url: "/profile", headers: { "x-test-user": u } })).json();
  const labels: string[] = [...p.resources.map((r: { label: string }) => r.label), ...p.unmapped.filter((f: { kind: string }) => f.kind === "resource").map((f: { phrase: string }) => f.phrase)];
  const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profileId), orderBy: (t, { desc }) => desc(t.processedAt) });
  const facts = await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc!.id));
  const active = facts.filter((f) => f.kind === "resource" && ["none", "available"].includes(f.resourceRole));
  const rows = await db.select().from(schema.userResources).where(eq(schema.userResources.capabilityProfileId, profileId));
  return { p, labels, active, facts, rows };
}

it.each([
  ["самолёт", "самолет"], ["кофемашина", "кофемашина."], ["Генератор", "генератор"],
  ["  ГЕНЕРАТОР  ", "генератор"], ["самоле\u0308т", "самолет"], ["редкий прибор QX", "РЕДКИЙ   прибор QX…"],
])("QA defect 8: %s + %s → one resource in API and persisted facts", async (a, b) => {
  const u = await newUser(); await add(u, `Есть ${a}`);
  const id = await add(u, `Есть ${b}`);
  const s = await state(u, id);
  expect(s.labels).toHaveLength(1); expect(s.active).toHaveLength(1);
});

it("машина and кофемашина remain two different entities", async () => {
  const u = await newUser(); await add(u, "Есть машина");
  const s = await state(u, await add(u, "Есть кофемашина"));
  expect(s.labels).toHaveLength(2); expect(s.active).toHaveLength(2);
  expect(s.rows).toHaveLength(1);
});

it("unknown resource add ё → revoke е → restore ё, then repeat е", async () => {
  const u = await newUser(); await add(u, "Есть самолёт");
  let s = await state(u, await add(u, "Нет самолет"));
  expect(s.labels).toHaveLength(0); expect(s.active).toHaveLength(0);
  s = await state(u, await add(u, "Снова есть самолёт"));
  expect(s.labels).toHaveLength(1); expect(s.active).toHaveLength(1);
  s = await state(u, await add(u, "Есть самолет"));
  expect(s.labels).toHaveLength(1); expect(s.active).toHaveLength(1);
  expect(s.active[0]!.nodeIds).toEqual([]);
});

it("unknown carry-forward does not duplicate a repeated resource when AI returns only the new message", async () => {
  const u = await newUser(); await add(u, "Есть самолёт");
  lastOnly = true;
  try {
    const s = await state(u, await add(u, "Есть самолет."));
    expect(s.labels).toHaveLength(1); expect(s.active).toHaveLength(1);
  } finally { lastOnly = false; }
});

it("repeating a mapped resource creates one resource row and one active fact", async () => {
  const u = await newUser(); await add(u, "Есть машина");
  const s = await state(u, await add(u, "Есть МАШИНА"));
  expect(s.rows).toHaveLength(1); expect(s.labels).toHaveLength(1); expect(s.active).toHaveLength(1);
});

it("unmapped repeat of a previously mapped item is one persisted fact after carry-forward", async () => {
  const u = await newUser(); await add(u, "Есть машина");
  lastOnly = true;
  try {
    const s = await state(u, await add(u, "Есть машина."));
    expect(s.rows).toHaveLength(1); expect(s.labels).toHaveLength(1); expect(s.active).toHaveLength(1);
    expect(s.active[0]!.nodeIds).toHaveLength(1);
  } finally { lastOnly = false; }
});

it("revoke and restore with different orthography preserve a different resource", async () => {
  const u = await newUser(); await add(u, "Есть самолёт"); await add(u, "Есть кофемашина");
  let s = await state(u, await add(u, "Нет САМОЛЕТ."));
  expect(s.labels).toEqual(["кофемашина"]); expect(s.active).toHaveLength(1);
  s = await state(u, await add(u, "Снова есть самолет"));
  expect(s.labels).toHaveLength(2); expect(s.active).toHaveLength(2);
  expect(s.labels).toContain("самолет");
});

it("legacy unknown duplicates are hidden in GET and not copied into a new document", async () => {
  const u = await newUser();
  const id = await add(u, "Есть самолёт");
  const old = await state(u, id);
  const { id: _id, ...duplicate } = old.active[0]!;
  await db.insert(schema.matchingFacts).values({ ...duplicate, phrase: "САМОЛЕТ." });
  expect((await state(u, id)).labels).toHaveLength(1);
  lastOnly = true;
  try {
    const s = await state(u, await add(u, "Есть генератор"));
    expect(s.labels).toHaveLength(2); expect(s.active).toHaveLength(2);
    expect(s.active.filter((f) => /самол[её]т/i.test(f.phrase))).toHaveLength(1);
  } finally { lastOnly = false; }
});
