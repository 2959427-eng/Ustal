import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { SEMANTIC_POLICY } from "@ustal/matching";
import { handleMatchingRun } from "../src/handlers/matching-run.js";
import { generalAccessPoolFingerprint } from "../src/general-access.js";
assertLocalTestDatabase();

/**
 * Whole-run validity regression (fix 2026-10-15, Codex acceptance FAIL 2). A matching run may be returned as is
 * (inputHash early return) only if everything that decides the delivery is unchanged — including people OUTSIDE the
 * ordinary shortlist who get a general-access delivery, and never after a technical/degraded AI result.
 * Shortlist = 1: person A (strong ordinary candidate, review: scope conflict -> not eligible) fills the shortlist,
 * person B is outside it and can only receive the order as a simple task. Unique texts per test (AI review cache).
 */
const db = getDb(), users: string[] = [], cities: string[] = [];
const keepShortlist = SEMANTIC_POLICY.shortlist;
afterAll(async () => {
  SEMANTIC_POLICY.shortlist = keepShortlist;
  if (users.length) await db.delete(schema.blocks).where(inArray(schema.blocks.blockerId, users));
  if (users.length) { await db.delete(schema.orders).where(inArray(schema.orders.authorId, users)); await db.delete(schema.users).where(inArray(schema.users.id, users)); }
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});
const vec = (i: number) => Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : 0));
let review: () => object | "degraded" = () => ({ compatible: false, confidence: 0.95, reason: "только своя сфера", hardConflict: { kind: "scope", profileEvidence: "x", orderEvidence: "y" } });
let refusal: (text: string) => boolean | "fail" = () => false;
const reviewCalls: string[] = [], refusalCalls: string[] = [];
beforeEach(() => {
  SEMANTIC_POLICY.shortlist = 1;
  reviewCalls.length = 0; refusalCalls.length = 0;
  review = () => ({ compatible: false, confidence: 0.95, reason: "только своя сфера", hardConflict: { kind: "scope", profileEvidence: "x", orderEvidence: "y" } });
  refusal = () => false;
  vi.spyOn(mockProviders.extraction, "reviewSemantic").mockImplementation(async (input) => {
    reviewCalls.push(input.profile.join(" "));
    const v = review();
    const base = { provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 };
    return (v === "degraded" ? { data: { compatible: true, confidence: 0.8, reason: "ok", hardConflict: null }, ...base, degraded: true } : { data: v, ...base }) as never;
  });
  vi.spyOn(mockProviders.extraction, "checkRefusal").mockImplementation(async (input) => {
    refusalCalls.push(input.refusal);
    const v = refusal(input.refusal);
    if (v === "fail") throw new Error("provider timeout");
    return { data: { involves: v, reason: "test" }, provider: "mock", model: "mock", latencyMs: 0, tokensInput: 0, tokensOutput: 0 };
  });
});

async function city() {
  const [c] = await db.insert(schema.cities).values({ name: "TEST_wholerun_" + randomUUID(), regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cities.push(c!.id); return c!.id;
}
async function person(cityId: string) {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "test-only", status: "active" }).returning();
  users.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, cityId, name: "TEST", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
  return u!.id;
}
type F = { kind: string; phrase: string; constraintType?: string; startHour?: number | null; endHour?: number | null; daysOfWeek?: number[] | null };
async function profile(userId: string, text: string, facts: F[], v: number[]) {
  const [p] = await db.insert(schema.capabilityProfiles).values({ userId, summary: text, profileVersion: 1, extractionVersion: "test", status: "applied" }).returning();
  await db.insert(schema.profileEmbeddings).values({ capabilityProfileId: p!.id, embeddingModel: "test", embedding: v });
  const [doc] = await db.insert(schema.matchingDocuments).values({ profileId: p!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: v }).returning();
  for (const f of facts) await addFact(doc!.id, f, text);
  return doc!.id;
}
async function addFact(documentId: string, f: F, evidence: string) {
  const [row] = await db.insert(schema.matchingFacts).values({ documentId, kind: f.kind, phrase: f.phrase, evidence, nodeIds: [], confidence: "1", mandatory: false,
    constraintType: f.constraintType ?? "none", constraintScope: "whole_task", startHour: f.startHour ?? null, endHour: f.endHour ?? null,
    daysOfWeek: f.daysOfWeek === undefined ? null : f.daysOfWeek, embedding: vec(9) }).returning();
  return row!.id;
}
const GENERAL = { accessLevel: "general", explicitRequirements: [], reason: "простая задача", version: "order-access-v1" };
async function order(cityId: string, author: string, text: string, desiredAt: Date | null = null) {
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId, sourceText: text, status: "published", riskLevel: 0, publishedAt: new Date(), desiredAt }).returning();
  await db.insert(schema.orderAiExtractions).values({ orderId: o!.id, extractionVersion: "v1", rawResult: { regulated: false, requiresQualification: false, actions: [], access: GENERAL } });
  const [doc] = await db.insert(schema.matchingDocuments).values({ orderId: o!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test", embedding: vec(0) }).returning();
  await db.insert(schema.matchingFacts).values({ documentId: doc!.id, kind: "capability", phrase: text, evidence: text, nodeIds: [], confidence: "1", mandatory: false, embedding: vec(0) });
  return o!.id;
}
async function run(orderId: string) {
  const r = await handleMatchingRun({ id: randomUUID(), data: { orderId } } as never);
  if (!("matchingRunId" in r)) throw new Error("no run");
  const candidates = await db.select().from(schema.matchingCandidates).where(eq(schema.matchingCandidates.matchingRunId, r.matchingRunId));
  const traces = await db.select().from(schema.matchingTraces).where(eq(schema.matchingTraces.matchingRunId, r.matchingRunId));
  return { runId: r.matchingRunId, delivered: new Set(candidates.map((c) => c.userId)), traces };
}
/** A in the shortlist (not eligible for a simple task), B outside it with an empty profile. */
async function scene(desiredAt: Date | null = null, bFacts: F[] = []) {
  const tag = randomUUID().slice(0, 8);
  const c = await city(), author = await person(c), a = await person(c), b = await person(c);
  await profile(a, `Делаю только сайты ${tag}`, [{ kind: "capability", phrase: `перенести коробки ${tag}` }], vec(0));
  const bDoc = await profile(b, `Ищу подработку ${tag}`, bFacts, vec(9));
  const orderId = await order(c, author, `Помочь перенести коробки ${tag}`, desiredAt);
  const first = await run(orderId);
  // B really is outside the ordinary shortlist: his only trace comes from the general-access path.
  expect(first.traces.find((t) => t.userId === b)?.decision).toBe("general_access");
  expect(first.traces.find((t) => t.userId === a)?.decision).not.toMatch(/^general_access/);
  expect(first.delivered.has(b)).toBe(true);
  return { tag, c, author, a, b, bDoc, orderId, first };
}

it("T5: nothing changed -> the whole-run early return still works (same run, no AI calls)", async () => {
  const s = await scene();
  reviewCalls.length = 0; refusalCalls.length = 0;
  const again = await run(s.orderId);
  expect(again.runId).toBe(s.first.runId);
  expect(reviewCalls).toHaveLength(0);
  expect(refusalCalls).toHaveLength(0);
});

it("T1 + T2: a new active restriction of a person outside the shortlist is checked; after revoke access returns", async () => {
  const s = await scene();
  refusal = (text) => text.includes("коробк");
  const restriction = await addFact(s.bDoc, { kind: "exclude", phrase: "переноска коробок", constraintType: "exclusion" }, `Не таскаю коробки ${s.tag}`);
  const t1 = await run(s.orderId);
  expect(t1.runId).not.toBe(s.first.runId); // the stale delivery is not reused
  expect(refusalCalls).toEqual([`Не таскаю коробки ${s.tag}`]); // the restriction really is checked
  expect(t1.delivered.has(s.b)).toBe(false);
  // T2: the person lifts the restriction (it becomes an inert superseded fact, as profile-restrictions does).
  await db.update(schema.matchingFacts).set({ kind: "superseded", constraintType: "none" }).where(eq(schema.matchingFacts.id, restriction));
  const t2 = await run(s.orderId);
  expect(t2.runId).not.toBe(t1.runId);
  expect(t2.delivered.has(s.b)).toBe(true);
});

it("T3: a temporary restriction-check failure is fail-safe and is retried by the next run", async () => {
  const tag = randomUUID().slice(0, 8);
  const c = await city(), author = await person(c), a = await person(c), b = await person(c);
  await profile(a, `Делаю только сайты ${tag}`, [{ kind: "capability", phrase: `перенести коробки ${tag}` }], vec(0));
  await profile(b, `Не работаю с животными ${tag}`, [{ kind: "exclude", phrase: "работа с животными", constraintType: "exclusion" }], vec(9));
  const orderId = await order(c, author, `Помочь перенести коробки ${tag}`);
  refusal = () => "fail";
  const r1 = await run(orderId);
  expect(refusalCalls).toHaveLength(1);
  expect(r1.delivered.has(b)).toBe(false); // fail-safe: not shown
  refusal = () => false; // AI recovered, nothing else changed
  const r2 = await run(orderId);
  expect(r2.runId).not.toBe(r1.runId); // the failed run is not a reusable whole-run result
  expect(refusalCalls).toHaveLength(2); // the check is executed again
  expect(r2.delivered.has(b)).toBe(true);
  const r3 = await run(orderId); // now stable -> reused
  expect(r3.runId).toBe(r2.runId);
});

it("T4: eligibility data of a person outside the shortlist changes -> the run is recomputed", async () => {
  const s = await scene();
  await addFact(s.bDoc, { kind: "capability", phrase: "IT-задачи", constraintType: "scope" }, `Беру только IT-задачи ${s.tag}`);
  const t4 = await run(s.orderId);
  expect(t4.runId).not.toBe(s.first.runId);
  expect(t4.delivered.has(s.b)).toBe(false);
  // a block between author and B also changes the pool
  await db.delete(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, s.bDoc));
  const back = await run(s.orderId);
  expect(back.delivered.has(s.b)).toBe(true);
  await db.insert(schema.blocks).values({ blockerId: s.author, blockedId: s.b });
  const blocked = await run(s.orderId);
  expect(blocked.runId).not.toBe(back.runId);
  expect(blocked.delivered.has(s.b)).toBe(false);
});

it("T6: a degraded ordinary review is not frozen by the whole-run cache", async () => {
  const tag = randomUUID().slice(0, 8);
  const c = await city(), author = await person(c), a = await person(c);
  await profile(a, `Помогаю с переездами ${tag}`, [{ kind: "capability", phrase: `перенести коробки ${tag}` }], vec(0));
  const orderId = await order(c, author, `Помочь перенести коробки ${tag}`);
  review = () => "degraded";
  const r1 = await run(orderId);
  expect(reviewCalls).toHaveLength(1);
  const r2 = await run(orderId);
  expect(r2.runId).not.toBe(r1.runId);
  expect(reviewCalls).toHaveLength(2); // neither the verdict nor the run was memoized
});

// ---- NULL / field-position collisions in the general-access pool hash (Codex re-acceptance FAIL 2) ----
const pool = (cityId: string, authorId: string) => generalAccessPoolFingerprint(db, { cityId, authorId });
const EVENING = new Date("2026-11-02T10:00:00Z"); // Monday 20:00 Asia/Vladivostok
async function bare() {
  const tag = randomUUID().slice(0, 8);
  const c = await city(), author = await person(c), b = await person(c);
  const doc = await profile(b, `Ищу подработку ${tag}`, [], vec(9));
  return { c, author, b, doc };
}
const factRow = async (doc: string) => (await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc)))[0]!;

it("T7: availability «before 18» and «after 18» give different hashes", async () => {
  const s = await bare();
  const id = await addFact(s.doc, { kind: "availability", phrase: "работа", constraintType: "availability", endHour: 18 }, "Работаю до 18:00");
  const before = await pool(s.c, s.author);
  await db.update(schema.matchingFacts).set({ startHour: 18, endHour: null }).where(eq(schema.matchingFacts.id, id));
  const after = await pool(s.c, s.author);
  expect(after).not.toBe(before);
  await db.update(schema.matchingFacts).set({ startHour: 9, endHour: 18 }).where(eq(schema.matchingFacts.id, id)); // both bounds
  const both = await pool(s.c, s.author);
  expect(new Set([before, after, both]).size).toBe(3);
  await db.delete(schema.matchingFacts).where(eq(schema.matchingFacts.id, id)); // no restriction at all
  expect(new Set([before, after, both, await pool(s.c, s.author)]).size).toBe(4);
});

it("T8: null vs empty value and separator/field-position ambiguity give different hashes", async () => {
  const s = await bare();
  const id = await addFact(s.doc, { kind: "availability", phrase: "работа", constraintType: "availability", endHour: 18, daysOfWeek: null }, "Работаю до 18");
  const nullDays = await pool(s.c, s.author);
  await db.update(schema.matchingFacts).set({ daysOfWeek: [] }).where(eq(schema.matchingFacts.id, id));
  expect(await pool(s.c, s.author)).not.toBe(nullDays);
  // old serialization joined fields with "~": ("a~b","c") and ("a","b~c") collided
  await db.update(schema.matchingFacts).set({ daysOfWeek: null, phrase: "a~b", evidence: "c" }).where(eq(schema.matchingFacts.id, id));
  const first = await pool(s.c, s.author);
  await db.update(schema.matchingFacts).set({ phrase: "a", evidence: "b~c" }).where(eq(schema.matchingFacts.id, id));
  expect(await pool(s.c, s.author)).not.toBe(first);
  // a person without a profile vs a person whose profile has no document: different positions of the missing value
  const noDocCity = await city(), a1 = await person(noDocCity), u1 = await person(noDocCity);
  await db.insert(schema.capabilityProfiles).values({ userId: u1, summary: "x", profileVersion: 1, extractionVersion: "test", status: "applied" });
  const withProfile = await pool(noDocCity, a1);
  await db.update(schema.capabilityProfiles).set({ status: "superseded" }).where(eq(schema.capabilityProfiles.userId, u1));
  expect(await pool(noDocCity, a1)).not.toBe(withProfile);
});

it("T10 + T11: unchanged input is stable; the same logical fact set in another DB order hashes the same", async () => {
  const s = await bare();
  const facts: F[] = [
    { kind: "exclude", phrase: "работа с животными", constraintType: "exclusion" },
    { kind: "availability", phrase: "работа", constraintType: "availability", startHour: 9, endHour: null },
    { kind: "resource", phrase: "автомобиль" },
  ];
  for (const f of facts) await addFact(s.doc, f, "текст");
  const h1 = await pool(s.c, s.author);
  expect(await pool(s.c, s.author)).toBe(h1); // T10
  await db.delete(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, s.doc));
  for (const f of [...facts].reverse()) await addFact(s.doc, f, "текст"); // new ids, reversed physical order
  expect(await pool(s.c, s.author)).toBe(h1); // T11
});

it("T9: a restriction changed only in a nullable field forbids the whole-run early return", async () => {
  const s = await scene(EVENING, [{ kind: "availability", phrase: "работа", constraintType: "availability", startHour: 18, daysOfWeek: null }]);
  const fact = await factRow(s.bDoc);
  await db.update(schema.matchingFacts).set({ daysOfWeek: [6] }).where(eq(schema.matchingFacts.id, fact.id)); // Saturday only
  const again = await run(s.orderId);
  expect(again.runId).not.toBe(s.first.runId);
});

it("T12: availability changes from «after 18» to «before 18» -> no stale reuse, the order is withdrawn", async () => {
  const s = await scene(EVENING, [{ kind: "availability", phrase: "работа", constraintType: "availability", startHour: 18 }]);
  const fact = await factRow(s.bDoc);
  await db.update(schema.matchingFacts).set({ startHour: null, endHour: 18 }).where(eq(schema.matchingFacts.id, fact.id));
  const again = await run(s.orderId);
  expect(again.runId).not.toBe(s.first.runId);
  expect(again.delivered.has(s.b)).toBe(false);
  const audit = (again.traces.find((t) => t.userId === s.b)!.detail as { general_access?: { refusedBy?: string } }).general_access;
  expect(audit?.refusedBy).toMatch(/outside_availability/);
});
