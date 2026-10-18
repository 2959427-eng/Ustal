import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders, PROFILE_FACTS_PIPELINE_VERSION } from "@ustal/ai";
import type { ExtractedProfileFact, ProfileFactValue } from "@ustal/validation";
import { handleProfileFactsExtraction } from "./handlers/profile-facts-extraction.js";
import { handleProfileExtraction } from "./handlers/profile-extraction.js";
import { reprocessProfileFacts } from "./reprocess-facts.js";

/**
 * Phase 1 profile_facts (SHADOW) on a real isolated PostgreSQL: provenance, FK/ownership constraints,
 * failure isolation, re-extraction lineage, conflict model. Fixture AI only (no external models).
 */
assertLocalTestDatabase();
const db = getDb();
const users: string[] = [];
let city: string;
const v = (p: Partial<ProfileFactValue> = {}): ProfileFactValue =>
  ({ label: null, number: null, numberMax: null, unit: null, period: null, level: null, flag: null, timeframe: null, approximate: false, ...p });
const fact = (factType: ExtractedProfileFact["factType"], evidence: string, value: Partial<ProfileFactValue>): ExtractedProfileFact =>
  ({ factType, evidence, value: v(value), assertion: "explicit", confidence: 0.9, sensitive: false });
const wrap = <T>(data: T) => ({ data, provider: "mock", model: "fixture", latencyMs: 0, tokensInput: 0, tokensOutput: 0 });
const fixtures = new Map<string, ExtractedProfileFact[]>();

async function user() {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  users.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, name: "TEST facts", cityId: city, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
  return u!.id;
}
async function input(userId: string, text: string, createdAt?: Date) {
  const [row] = await db.insert(schema.profileSourceInputs)
    .values({ userId, inputType: "text", rawText: text, status: "confirmed", ...(createdAt ? { createdAt } : {}) }).returning();
  return row!;
}
const run = (userId: string, sourceInputId: string) =>
  handleProfileFactsExtraction({ id: randomUUID(), data: { userId, sourceInputId } } as never);
const factsOf = (userId: string) => db.select().from(schema.profileFacts)
  .where(eq(schema.profileFacts.userId, userId)).orderBy(asc(schema.profileFacts.createdAt));

beforeAll(async () => {
  const [c] = await db.insert(schema.cities).values({ name: `TEST facts ${randomUUID()}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  city = c!.id;
  vi.spyOn(mockProviders.extraction, "extractProfileFacts").mockImplementation(async ({ text }) => {
    const f = fixtures.get(text);
    if (!f) throw new Error("no fixture");
    return wrap({ facts: f });
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.cities).where(eq(schema.cities.id, city));
  await getSql().end();
});

describe("profile_facts shadow extraction", () => {
  it("one input -> several typed facts with provenance to that exact input and version", async () => {
    const u = await user();
    const text = "Работал директором завода 7 лет, около 300 сотрудников, вывел предприятие из убытков, переезжать не хочу, но командировки нормально.";
    fixtures.set(text, [
      fact("role", "Работал директором завода", { label: "директор завода", timeframe: "past" }),
      fact("experience", "директором завода 7 лет", { label: "директор завода", number: 7, unit: "год" }),
      fact("management", "около 300 сотрудников", { label: "сотрудники", number: 300, approximate: true }),
      fact("achievement", "вывел предприятие из убытков", { label: "вывел предприятие из убытков" }),
      fact("relocation", "переезжать не хочу", { flag: false }),
      fact("travel", "командировки нормально", { flag: true }),
      fact("industry", "Работал директором завода", { label: "металлургия" }), // invented -> rejected
    ]);
    const src = await input(u, text);
    const r = await run(u, src.id);
    expect(r).toMatchObject({ status: "succeeded", facts: 6, rejected: 1 });
    const rows = await factsOf(u);
    expect(rows.map((f) => f.factType).sort()).toEqual(["achievement", "experience", "management", "relocation", "role", "travel"]);
    for (const f of rows) {
      expect(f.sourceInputId).toBe(src.id);
      expect(text).toContain(f.evidence);
      expect(f.status).toBe("active");
    }
    const [ext] = await db.select().from(schema.profileFactExtractions).where(eq(schema.profileFactExtractions.id, rows[0]!.extractionId));
    expect(ext).toMatchObject({ status: "succeeded", pipelineVersion: PROFILE_FACTS_PIPELINE_VERSION, model: "mock", factsCount: 6, rejectedCount: 1, attempts: 1 });
    // raw input is untouched by extraction
    const [stored] = await db.select().from(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.id, src.id));
    expect(stored!.rawText).toBe(text);
    // idempotent: the same version is not extracted twice
    expect(await run(u, src.id)).toMatchObject({ status: "succeeded", reused: true });
    expect((await factsOf(u)).length).toBe(6);
  });

  it("hallucinated evidence (not in this input, even if it is in another input of the user) is rejected", async () => {
    const u = await user();
    await input(u, "Свободно говорю по-английски.");
    const text = "Умею водить грузовик.";
    fixtures.set(text, [fact("language", "Свободно говорю по-английски", { label: "английский" }), fact("skill", "водить грузовик", { label: "вождение грузовика" })]);
    const src = await input(u, text);
    expect(await run(u, src.id)).toMatchObject({ status: "succeeded", facts: 1, rejected: 1 });
    expect((await factsOf(u)).map((f) => f.factType)).toEqual(["skill"]);
  });

  it("AI failure: ledger=failed (technical code, no user text), no facts, input and capability profile unaffected", async () => {
    const u = await user();
    const text = "СЕКРЕТНЫЙ ТЕКСТ ПОЛЬЗОВАТЕЛЯ: электрик, меняю розетки.";
    const src = await input(u, text);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(mockProviders.extraction.extractProfileFacts).mockRejectedValueOnce(Object.assign(new Error(`timeout while processing ${text}`), { name: "APIConnectionTimeoutError" }));
    const r = await run(u, src.id);
    const logged = log.mock.calls.flat().join(" ");
    log.mockRestore();
    expect(r).toMatchObject({ status: "failed", reason: "APIConnectionTimeoutError" });
    expect(logged).not.toContain("СЕКРЕТНЫЙ");
    const [ext] = await db.select().from(schema.profileFactExtractions).where(eq(schema.profileFactExtractions.sourceInputId, src.id));
    expect(ext).toMatchObject({ status: "failed", error: "APIConnectionTimeoutError" });
    expect(await factsOf(u)).toEqual([]);
    const [stored] = await db.select().from(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.id, src.id));
    expect(stored).toMatchObject({ rawText: text, status: "confirmed" });
    // the existing AI-profile pipeline for the same input still works
    const profile = await handleProfileExtraction({ id: randomUUID(), data: { userId: u, sourceInputId: src.id } } as never);
    expect(profile.profileId).toBeDefined();
    // failed extractions are picked up by the reprocess tool
    fixtures.set(text, [fact("skill", "меняю розетки", { label: "замена розеток" })]);
    expect(await reprocessProfileFacts({ sourceInputId: src.id })).toMatchObject({ dryRun: true, toExtract: 1 });
    expect(await reprocessProfileFacts({ sourceInputId: src.id }, true)).toMatchObject({ results: { succeeded: 1 } });
    expect((await factsOf(u)).length).toBe(1);
  });

  it("re-extraction by a newer pipeline replaces old facts with lineage and never touches raw text", async () => {
    const u = await user();
    const text = "Знаю английский на уровне B2.";
    const src = await input(u, text);
    // an older pipeline version already produced a fact for this input
    const [old] = await db.insert(schema.profileFactExtractions).values({ userId: u, sourceInputId: src.id, pipelineVersion: "profile-facts-v0", promptVersion: "old", model: "old-model", status: "succeeded", factsCount: 1 }).returning();
    const [oldFact] = await db.insert(schema.profileFacts).values({ userId: u, sourceInputId: src.id, extractionId: old!.id, factType: "language", slotKey: "language:английский", value: v({ label: "английский" }), evidence: "английский", confidence: "0.8", assertion: "explicit", status: "active" }).returning();
    fixtures.set(text, [fact("language", "английский на уровне B2", { label: "английский", level: "B2" })]);
    expect(await reprocessProfileFacts({ userId: u })).toMatchObject({ toExtract: 1 });
    await reprocessProfileFacts({ userId: u }, true);
    const rows = await factsOf(u);
    const newFact = rows.find((f) => f.id !== oldFact!.id)!;
    expect(rows.find((f) => f.id === oldFact!.id)!.status).toBe("replaced");
    expect(newFact).toMatchObject({ status: "active", replacesFactId: oldFact!.id, value: expect.objectContaining({ level: "B2" }) });
    expect(await reprocessProfileFacts({ userId: u })).toMatchObject({ toExtract: 0 });
  });

  it("conflict: a later compensation statement supersedes the earlier one; re-extracting the old message keeps the newer", async () => {
    const u = await user();
    const t1 = "Рассматриваю работу от 300 тыс.", t2 = "Теперь меньше 500 тыс. не рассматриваю.";
    fixtures.set(t1, [fact("compensation", "от 300 тыс.", { number: 300000 })]);
    fixtures.set(t2, [fact("compensation", "меньше 500 тыс. не рассматриваю", { number: 500000 })]);
    const s1 = await input(u, t1, new Date("2026-01-10T00:00:00Z"));
    const s2 = await input(u, t2, new Date("2026-06-10T00:00:00Z"));
    await run(u, s2.id); // processed out of order on purpose
    await run(u, s1.id);
    const rows = await factsOf(u);
    const f1 = rows.find((f) => f.sourceInputId === s1.id)!, f2 = rows.find((f) => f.sourceInputId === s2.id)!;
    expect(f2).toMatchObject({ status: "active", supersededByFactId: null });
    expect(f1).toMatchObject({ status: "superseded", supersededByFactId: f2.id });
    // DB invariant: never two active facts for one slot
    await expect(db.update(schema.profileFacts).set({ status: "active" }).where(eq(schema.profileFacts.id, f1.id))).rejects.toThrow();
  });

  it("ownership: a job with another user's id, or a fact pointing to another user's input, is impossible", async () => {
    const a = await user(), b = await user();
    const text = "Есть свой фургон.";
    fixtures.set(text, [fact("resource", "свой фургон", { label: "фургон" })]);
    const srcA = await input(a, text);
    expect(await run(b, srcA.id)).toMatchObject({ status: "skipped", reason: "owner_mismatch" });
    expect(await factsOf(b)).toEqual([]);
    expect(await db.select().from(schema.profileFactExtractions).where(eq(schema.profileFactExtractions.sourceInputId, srcA.id))).toEqual([]);
    await run(a, srcA.id);
    const [fa] = await factsOf(a);
    // composite FK (source_input_id, user_id): a fact can never belong to a user who does not own the input
    await expect(db.update(schema.profileFacts).set({ userId: b }).where(eq(schema.profileFacts.id, fa!.id))).rejects.toThrow();
    const [extB] = await db.insert(schema.profileFactExtractions).values({ userId: b, sourceInputId: (await input(b, "x")).id, pipelineVersion: "t", promptVersion: "t", model: "t" }).returning();
    await expect(db.insert(schema.profileFacts).values({ userId: b, sourceInputId: srcA.id, extractionId: extB!.id, factType: "resource", slotKey: "resource:x", value: v(), evidence: "x", confidence: "0.5", assertion: "explicit", status: "superseded" })).rejects.toThrow();
  });

  it("guards: unconfirmed and oversized inputs are not extracted; DB rejects invalid status/confidence", async () => {
    const u = await user();
    const [pending] = await db.insert(schema.profileSourceInputs).values({ userId: u, inputType: "voice", transcript: "черновик", status: "awaiting_review" }).returning();
    expect(await run(u, pending!.id)).toMatchObject({ status: "skipped", reason: "source_not_confirmed" });
    const big = await input(u, "а".repeat(8001));
    expect(await run(u, big.id)).toMatchObject({ status: "skipped", reason: "source_too_large" });
    const [ext] = await db.select().from(schema.profileFactExtractions).where(eq(schema.profileFactExtractions.sourceInputId, big.id));
    await expect(db.insert(schema.profileFacts).values({ userId: u, sourceInputId: big.id, extractionId: ext!.id, factType: "skill", slotKey: "skill:x", value: v(), evidence: "а", confidence: "1.5", assertion: "explicit", status: "superseded" })).rejects.toThrow();
    await expect(db.insert(schema.profileFacts).values({ userId: u, sourceInputId: big.id, extractionId: ext!.id, factType: "skill", slotKey: "skill:x", value: v(), evidence: "а", confidence: "0.5", assertion: "explicit", status: "confirmed" })).rejects.toThrow();
  });

  it("deleting the user removes their inputs, extractions and facts (cascade)", async () => {
    const u = await user();
    const text = "Умею класть плитку.";
    fixtures.set(text, [fact("skill", "класть плитку", { label: "укладка плитки" })]);
    const src = await input(u, text);
    await run(u, src.id);
    await db.delete(schema.users).where(eq(schema.users.id, u));
    expect(await db.select().from(schema.profileFacts).where(eq(schema.profileFacts.sourceInputId, src.id))).toEqual([]);
    expect(await db.select().from(schema.profileFactExtractions).where(and(eq(schema.profileFactExtractions.userId, u)))).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // Phase 2A: user decisions survive reprocessing (corrected > confirmed > AI), source revocation.
  // ---------------------------------------------------------------------------------------------
  async function oldVersionFact(u: string, srcId: string, over: Partial<typeof schema.profileFacts.$inferInsert>) {
    const [ext] = await db.insert(schema.profileFactExtractions).values({ userId: u, sourceInputId: srcId, pipelineVersion: "profile-facts-v0", promptVersion: "old", model: `old-${randomUUID()}`, status: "succeeded" }).returning();
    const [f] = await db.insert(schema.profileFacts).values({ userId: u, sourceInputId: srcId, extractionId: ext!.id, factType: "language", slotKey: "language:английский",
      value: v({ label: "английский" }), evidence: "английский", confidence: "0.8", assertion: "explicit", status: "active", ...over }).returning();
    return f!;
  }
  const byId = async (id: string) => (await db.select().from(schema.profileFacts).where(eq(schema.profileFacts.id, id)))[0]!;
  const others = async (u: string, id: string) => (await factsOf(u)).filter((f) => f.id !== id);

  it("reprocess: a CONFIRMED fact keeps priority; the new AI output is stored but superseded by it", async () => {
    const u = await user();
    const text = "Знаю английский на уровне B2.";
    const src = await input(u, text);
    const confirmed = await oldVersionFact(u, src.id, { userDecision: "confirmed", decidedAt: new Date(), visibility: "shareable" });
    fixtures.set(text, [fact("language", "английский на уровне B2", { label: "английский", level: "B2" })]);
    await reprocessProfileFacts({ sourceInputId: src.id }, true);
    expect(await byId(confirmed.id)).toMatchObject({ status: "active", userDecision: "confirmed", visibility: "shareable" });
    const [fresh] = await others(u, confirmed.id);
    expect(fresh).toMatchObject({ status: "superseded", supersededByFactId: confirmed.id, userDecision: null, visibility: "private" });
  });

  it("reprocess: a CORRECTED fact is never overwritten, even when the correction renamed the slot", async () => {
    const u = await user();
    const text = "Знаю английский.";
    const src = await input(u, text);
    const corrected = await oldVersionFact(u, src.id, { userDecision: "corrected", decidedAt: new Date(), slotKey: "language:немецкий", userValue: v({ label: "немецкий", level: "C1" }) });
    fixtures.set(text, [fact("language", "английский", { label: "английский" })]);
    await reprocessProfileFacts({ sourceInputId: src.id }, true);
    expect(await byId(corrected.id)).toMatchObject({ status: "active", userDecision: "corrected", userValue: expect.objectContaining({ label: "немецкий" }) });
    const [fresh] = await others(u, corrected.id);
    expect(fresh).toMatchObject({ status: "superseded", slotKey: "language:немецкий", supersededByFactId: corrected.id });
    expect((await factsOf(u)).filter((f) => f.status === "active").map((f) => f.id)).toEqual([corrected.id]);
  });

  it("reprocess: a REVOKED fact does not come back; a new message is a new basis", async () => {
    const u = await user();
    const text = "Знаю английский.";
    const src = await input(u, text, new Date("2026-01-01T00:00:00Z"));
    const revoked = await oldVersionFact(u, src.id, { status: "revoked", userDecision: "revoked", decidedAt: new Date() });
    fixtures.set(text, [fact("language", "английский", { label: "английский" })]);
    await reprocessProfileFacts({ sourceInputId: src.id }, true);
    const [fresh] = await others(u, revoked.id);
    expect(fresh).toMatchObject({ status: "revoked", userDecision: "revoked", replacesFactId: revoked.id });
    expect((await factsOf(u)).some((f) => f.status === "active")).toBe(false);
    // the user says it again in a NEW message -> active again (new user basis)
    const text2 = "Снова подтянул английский.";
    fixtures.set(text2, [fact("language", "английский", { label: "английский" })]);
    const src2 = await input(u, text2);
    await run(u, src2.id);
    expect((await factsOf(u)).filter((f) => f.status === "active").map((f) => f.sourceInputId)).toEqual([src2.id]);
  });

  it("reprocess: an AI-only fact is replaced and its visibility carried over", async () => {
    const u = await user();
    const text = "Знаю английский.";
    const src = await input(u, text);
    const ai = await oldVersionFact(u, src.id, { visibility: "shareable" });
    fixtures.set(text, [fact("language", "английский", { label: "английский" })]);
    await reprocessProfileFacts({ sourceInputId: src.id }, true);
    expect(await byId(ai.id)).toMatchObject({ status: "replaced" });
    const [fresh] = await others(u, ai.id);
    expect(fresh).toMatchObject({ status: "active", replacesFactId: ai.id, visibility: "shareable" });
  });

  it("a newer message never silently overrides a confirmed fact (stored as superseded for the owner to review)", async () => {
    const u = await user();
    const t1 = "Рассматриваю работу от 300 тыс.", t2 = "Теперь меньше 500 тыс. не рассматриваю.";
    fixtures.set(t1, [fact("compensation", "от 300 тыс.", { number: 300000 })]);
    fixtures.set(t2, [fact("compensation", "меньше 500 тыс. не рассматриваю", { number: 500000 })]);
    const s1 = await input(u, t1, new Date("2026-01-10T00:00:00Z"));
    await run(u, s1.id);
    const [first] = await factsOf(u);
    await db.update(schema.profileFacts).set({ userDecision: "confirmed", decidedAt: new Date() }).where(eq(schema.profileFacts.id, first!.id));
    const s2 = await input(u, t2, new Date("2026-06-10T00:00:00Z"));
    await run(u, s2.id);
    const second = (await factsOf(u)).find((f) => f.sourceInputId === s2.id)!;
    expect(await byId(first!.id)).toMatchObject({ status: "active" });
    expect(second).toMatchObject({ status: "superseded", supersededByFactId: first!.id });
  });

  it("a withdrawn source is never extracted or reprocessed, and new facts default to private", async () => {
    const u = await user();
    const text = "Есть бетономешалка.";
    fixtures.set(text, [fact("resource", "бетономешалка", { label: "бетономешалка" })]);
    const src = await input(u, text);
    await run(u, src.id);
    expect((await factsOf(u))[0]).toMatchObject({ visibility: "private", userDecision: null });
    const other = await input(u, "Есть бетономешалка.");
    await db.update(schema.profileSourceInputs).set({ revokedAt: new Date() }).where(eq(schema.profileSourceInputs.id, other.id));
    expect(await run(u, other.id)).toMatchObject({ status: "skipped", reason: "source_revoked" });
    expect(await reprocessProfileFacts({ sourceInputId: other.id })).toMatchObject({ toExtract: 0 });
  });

  it("DB rejects inconsistent decisions (revoked<->status, user_value only for corrections, visibility values)", async () => {
    const u = await user();
    const src = await input(u, "x");
    const f = await oldVersionFact(u, src.id, {});
    await expect(db.update(schema.profileFacts).set({ status: "revoked" }).where(eq(schema.profileFacts.id, f.id))).rejects.toThrow();
    await expect(db.update(schema.profileFacts).set({ userDecision: "confirmed", userValue: v({ label: "x" }) }).where(eq(schema.profileFacts.id, f.id))).rejects.toThrow();
    await expect(db.update(schema.profileFacts).set({ visibility: "public" }).where(eq(schema.profileFacts.id, f.id))).rejects.toThrow();
  });
});

