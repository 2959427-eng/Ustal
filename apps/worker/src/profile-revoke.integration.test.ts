import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, PROFILE_SOURCE_SEPARATOR, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import type { SemanticFact } from "@ustal/validation";
import { handleProfileExtraction } from "./handlers/profile-extraction.js";
import { handleOrderExtraction } from "./handlers/order-extraction.js";
import { handleMatchingRun } from "./handlers/matching-run.js";
import { dispatchRematches } from "./rematch.js";
import { reprocessProfile } from "./reprocess.js";
import { dispatchProfileRebuilds, handleProfileRebuild, rebuildProfileIfNeeded } from "./profile-rebuild.js";
import { requestRematch } from "./semantic.js";

/**
 * Source revoke lifecycle (2026-09-28) on a real PostgreSQL with fixture AI: a revoked message leaves the
 * AI profile (rebuilt from the remaining messages by the normal pipeline) and therefore matching.
 */
assertLocalTestDatabase();
const db = getDb();
const users: string[] = [], cities: string[] = [], orders: string[] = [];
const fixtures = new Map<string, SemanticFact[]>();
const vectors = new Map<string, number[]>();
const vector = (axis: number) => Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0));
const wrap = <T>(data: T) => ({ data, provider: "mock", model: "fixture-revoke", latencyMs: 0, tokensInput: 0, tokensOutput: 0 });
function fact(phrase: string, keys: string[], axis: number, kind: SemanticFact["kind"], extra: Partial<SemanticFact> = {}): SemanticFact {
  vectors.set(phrase, vector(axis));
  return { phrase, canonicalKeys: keys, kind, mandatory: false, confidence: 0.95, evidence: "", constraintType: "none",
    constraintScope: "fact", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
    startHour: null, endHour: null, daysOfWeek: null, ...extra };
}
/** Registers what the (fixture) model reads in a message; any source containing the message yields these facts. */
function says(text: string, facts: SemanticFact[]) { fixtures.set(text, facts); return text; }
const van = (tag: string) => fact(`${tag} газель`, ["van"], 410, "resource", { resourceRole: "available" });
const assembly = (tag: string) => fact(`${tag} сборка мебели`, ["assembly"], 420, "capability");
let city: string;
const reviewCalls: Array<{ profile: string[] }> = [];

async function user() {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test", status: "active" }).returning();
  users.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, name: "TEST revoke", cityId: city, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
  return u!.id;
}
async function send(userId: string, text: string) {
  const [s] = await db.insert(schema.profileSourceInputs).values({ userId, inputType: "text", rawText: text, status: "confirmed" }).returning();
  return s!;
}
async function extract(userId: string, sourceInputId: string) {
  return handleProfileExtraction({ id: randomUUID(), data: { userId, sourceInputId } } as never);
}
/** Same state change as POST /profile/draft/:id/apply. */
async function apply(userId: string, profileId: string) {
  await db.transaction(async (tx) => {
    await tx.update(schema.capabilityProfiles).set({ status: "superseded" })
      .where(and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.status, "applied")));
    await tx.update(schema.capabilityProfiles).set({ status: "applied" }).where(eq(schema.capabilityProfiles.id, profileId));
    await requestRematch(tx, userId);
  });
}
async function message(userId: string, text: string, applyIt = true) {
  const s = await send(userId, text);
  const p = await extract(userId, s.id);
  if (applyIt) await apply(userId, p.profileId);
  return { sourceInputId: s.id, profileId: p.profileId };
}
/**
 * The DB effect of DELETE /profile/inputs/:id (apps/api/src/lib/source-revoke.ts; covered there by the API
 * test): revoked_at, and — when the current profile contains the message — rebuild_pending + drafts invalidated.
 * `onlyTimestamp` simulates a state the API never leaves but the worker must still handle safely.
 */
async function revoke(userId: string, sourceInputId: string, onlyTimestamp = false) {
  await db.update(schema.profileSourceInputs).set({ revokedAt: new Date() }).where(eq(schema.profileSourceInputs.id, sourceInputId));
  if (onlyTimestamp) return;
  await db.transaction(async (tx) => {
    await tx.update(schema.capabilityProfiles).set({ status: "rebuild_pending" })
      .where(and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.status, "applied")));
    await tx.update(schema.capabilityProfiles).set({ status: "invalidated" })
      .where(and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.status, "draft")));
    await requestRematch(tx, userId);
  });
}
async function applied(userId: string) {
  return db.query.capabilityProfiles.findFirst({
    where: and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.status, "applied")),
    orderBy: desc(schema.capabilityProfiles.profileVersion),
  });
}
async function snapshot(profileId: string) {
  const nodes = await db.query.ontologyNodes.findMany();
  const key = (id: string) => nodes.find((n) => n.id === id)?.canonicalKey;
  const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profileId), orderBy: desc(schema.matchingDocuments.processedAt) });
  const facts = doc ? await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc.id)) : [];
  const res = await db.query.userResources.findMany({ where: eq(schema.userResources.capabilityProfileId, profileId) });
  const caps = await db.query.userCapabilities.findMany({ where: eq(schema.userCapabilities.capabilityProfileId, profileId) });
  const profile = await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, profileId) });
  return { sourceText: doc?.sourceText ?? "", summary: profile?.summary ?? "", phrases: facts.map((f) => f.phrase),
    resources: res.map((r) => key(r.ontologyNodeId)), capabilities: caps.map((c) => key(c.ontologyNodeId)) };
}
async function vanOrder(tag: string) {
  const author = await user();
  const text = says(`${tag} заказ: перевезти шкаф на газели`, [
    fact(`${tag} газель`, ["van"], 410, "resource", { mandatory: true, constraintScope: "whole_task" }),
  ]);
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId: city, sourceText: text, status: "processing" }).returning();
  orders.push(o!.id);
  await handleOrderExtraction({ id: randomUUID(), data: { orderId: o!.id } } as never);
  await db.update(schema.orders).set({ status: "published" }).where(eq(schema.orders.id, o!.id));
  return o!.id;
}
async function matched(orderId: string, userId: string) {
  const run = await handleMatchingRun({ id: randomUUID(), data: { orderId } } as never);
  if (!("matchingRunId" in run)) throw Error("matching skipped");
  return !!(await db.query.matchingCandidates.findFirst({
    where: (t, { and, eq }) => and(eq(t.matchingRunId, run.matchingRunId), eq(t.userId, userId)),
  }));
}

beforeAll(async () => {
  const [c] = await db.insert(schema.cities).values({ name: `TEST revoke ${randomUUID()}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  city = c!.id; cities.push(city);
  vi.spyOn(mockProviders.extraction, "extractCapabilityProfile").mockImplementation(async (input) =>
    wrap({ summary: input.text, capabilities: [], resources: [] }));
  vi.spyOn(mockProviders.extraction, "extractOrder").mockImplementation(async (input) => wrap({
    normalizedTitle: input.text, normalizedDescription: input.text, actions: [], requiredCapabilities: [], desiredCapabilities: [],
    requiredResources: [], desiredResources: [], physicalRequirements: [], complexity: "low", requiresQualification: false,
    regulated: false, estimatedDurationMinutes: null, contextualChips: [],
  }));
  // The fixture "model" reads every registered message contained in the source (a cumulative profile
  // source yields the facts of all its messages; a rebuilt one only those of the remaining messages).
  vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (input) => {
    const facts = [...fixtures].filter(([text]) => input.text.includes(text))
      .flatMap(([text, fs]) => fs.map((f) => ({ ...f, evidence: text })));
    if (!facts.length) throw Error("Missing explicit provider fixture");
    return wrap({ facts });
  });
  vi.spyOn(mockProviders.embedding, "embed").mockImplementation(async (texts) =>
    wrap({ vectors: texts.map((t) => vectors.get(t) ?? vectors.get(t.split("\n")[0]!) ?? vector(100)) }));
  vi.spyOn(mockProviders.extraction, "reviewSemantic").mockImplementation(async (input) => {
    // Fixture judgement: the order needs a van; only a profile source that states one is compatible.
    reviewCalls.push(input as { profile: string[] });
    const hasVan = (input as { profile: string[] }).profile.some((t) => /газел/i.test(t));
    return wrap(hasVan ? { compatible: true, confidence: 0.95, reason: "Has the required vehicle" }
      : { compatible: false, confidence: 0.95, reason: "No vehicle stated" });
  });
}, 30000);
afterAll(async () => {
  vi.restoreAllMocks();
  if (orders.length) await db.delete(schema.moderationCases).where(inArray(schema.moderationCases.orderId, orders));
  if (orders.length) await db.delete(schema.orders).where(inArray(schema.orders.id, orders));
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});

describe("source revoke: the AI profile is rebuilt from the remaining messages and matching follows", () => {
  it("«Есть Газель» → profile → revoke → rebuilt without it → Газель no longer affects matching", async () => {
    const u = await user();
    const gazel = await message(u, says("REV1 Есть Газель", [van("REV1")]));
    const furniture = await message(u, says("REV1 Собираю мебель", [assembly("REV1")]));
    const before = await snapshot(furniture.profileId);
    expect(before.resources).toEqual(["van"]);
    expect(before.sourceText).toContain("Газель");
    const oid = await vanOrder("REV1");
    expect(await matched(oid, u)).toBe(true);

    await revoke(u, gazel.sourceInputId);
    // Immediately: the version with the revoked message is out of matching (not applied any more).
    expect(await applied(u)).toBeUndefined();
    expect(await matched(oid, u)).toBe(false);

    const extractCalls = vi.mocked(mockProviders.extraction.extractCapabilityProfile).mock.calls.length;
    const result = await handleProfileRebuild({ id: randomUUID(), data: { userId: u } } as never, async () => undefined);
    expect(result).toMatchObject({ action: "rebuilt", previousProfileId: furniture.profileId, inputs: 1, reextracted: 0 });
    // Normal pipeline over raw remaining messages, not sentence surgery on generated text.
    expect(vi.mocked(mockProviders.extraction.extractCapabilityProfile).mock.calls.at(-1)![0]).toEqual({ text: "REV1 Собираю мебель" });
    expect(vi.mocked(mockProviders.extraction.extractCapabilityProfile).mock.calls.length).toBe(extractCalls + 1);
    const current = await applied(u);
    expect(current?.id).not.toBe(furniture.profileId);
    expect(current?.sourceInputId).toBeNull();
    const after = await snapshot(current!.id);
    expect(after).toMatchObject({ sourceText: "REV1 Собираю мебель", summary: "REV1 Собираю мебель",
      resources: [], capabilities: ["assembly"] });
    expect(after.phrases.some((p) => /газел/i.test(p))).toBe(false);
    // Audit: old versions and the raw message are kept internally.
    expect((await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, furniture.profileId) }))?.status).toBe("superseded");
    expect((await db.query.profileSourceInputs.findFirst({ where: eq(schema.profileSourceInputs.id, gazel.sourceInputId) }))?.rawText).toBe("REV1 Есть Газель");

    // Matching recalculates through the existing rematch path; the order no longer matches.
    const queued: string[] = [];
    // The dispatcher is a bounded global tick (oldest requests first, as in the worker loop): requests left by other
    // test files running in parallel can come first, so tick until this user's request is done, like the worker does.
    for (let i = 0; i < 20; i++) {
      await dispatchRematches(async (orderId) => { queued.push(orderId); });
      const pending = await db.query.rematchRequests.findFirst({ where: eq(schema.rematchRequests.userId, u) });
      if (!pending || pending.cursor === "ffffffff-ffff-ffff-ffff-ffffffffffff") break;
    }
    expect(queued).toContain(oid);
    reviewCalls.length = 0;
    expect(await matched(oid, u)).toBe(false);
    expect(reviewCalls.flatMap((c) => c.profile).some((t) => /газел/i.test(t))).toBe(false);
    // Idempotent: nothing left to rebuild.
    expect(await rebuildProfileIfNeeded(u)).toEqual({ action: "noop" });
  });

  it("reverse: Газель stated in another active message keeps the resource and the match", async () => {
    const u = await user();
    const first = await message(u, says("REV2 Есть Газель", [van("REV2")]));
    await message(u, says("REV2 Собираю мебель", [assembly("REV2")]));
    await message(u, says("REV2 Газель своя, вожу сам", [van("REV2")]));
    const oid = await vanOrder("REV2");
    await revoke(u, first.sourceInputId);
    expect(await rebuildProfileIfNeeded(u)).toMatchObject({ action: "rebuilt", inputs: 2 });
    const after = await snapshot((await applied(u))!.id);
    expect(after.sourceText).toBe(["REV2 Собираю мебель", "REV2 Газель своя, вожу сам"].join(PROFILE_SOURCE_SEPARATOR));
    expect(after.resources).toEqual(["van"]);
    expect(await matched(oid, u)).toBe(true);
  });

  it("reverse, identical text in two messages: revoking one keeps the other (and no rebuild loop)", async () => {
    const u = await user();
    const a = await message(u, says("REV3 Есть Газель", [van("REV3")]));
    await message(u, "REV3 Есть Газель");
    await revoke(u, a.sourceInputId);
    expect(await rebuildProfileIfNeeded(u)).toMatchObject({ action: "rebuilt", inputs: 1 });
    expect((await snapshot((await applied(u))!.id)).resources).toEqual(["van"]);
    expect(await rebuildProfileIfNeeded(u)).toEqual({ action: "noop" });
  });

  it("revoking the only message clears the AI profile: the user leaves matching", async () => {
    const u = await user();
    const only = await message(u, says("REV4 Есть Газель", [van("REV4")]));
    const oid = await vanOrder("REV4");
    expect(await matched(oid, u)).toBe(true);
    await revoke(u, only.sourceInputId);
    expect(await rebuildProfileIfNeeded(u)).toEqual({ action: "cleared", previousProfileId: only.profileId });
    expect(await applied(u)).toBeUndefined();
    expect(await matched(oid, u)).toBe(false);
    expect(await rebuildProfileIfNeeded(u)).toEqual({ action: "noop" });
  });

  it("revoked text never re-enters: later messages, reprocessing and re-extraction of the revoked message", async () => {
    const u = await user();
    const gazel = await message(u, says("REV5 Есть Газель", [van("REV5")]));
    await message(u, says("REV5 Собираю мебель", [assembly("REV5")]));
    await revoke(u, gazel.sourceInputId);
    await rebuildProfileIfNeeded(u);
    const next = await message(u, says("REV5 Умею красить стены", [fact("REV5 покраска", [], 430, "capability")]));
    const s1 = await snapshot(next.profileId);
    expect(s1.sourceText).toBe(["REV5 Собираю мебель", "REV5 Умею красить стены"].join(PROFILE_SOURCE_SEPARATOR));
    expect(s1.resources).toEqual([]);
    await reprocessProfile(next.profileId, undefined, true);
    expect((await snapshot(next.profileId)).sourceText).not.toContain("Газель");
    await expect(extract(u, gazel.sourceInputId)).rejects.toThrow("revoked");
    const again = await send(u, "REV5 Есть Газель");
    await db.update(schema.profileSourceInputs).set({ revokedAt: new Date() }).where(eq(schema.profileSourceInputs.id, again.id));
    await expect(extract(u, again.id)).rejects.toThrow("revoked");
  });

  it("safety nets when only revoked_at is set: extraction, reprocess and the worker sweep rebuild first", async () => {
    // extraction of a new message first rebuilds the base, so the draft never inherits the revoked text
    const u1 = await user();
    const g1 = await message(u1, says("REV6 Есть Газель", [van("REV6")]));
    await message(u1, says("REV6 Собираю мебель", [assembly("REV6")]));
    await revoke(u1, g1.sourceInputId, true);
    const draft = await message(u1, says("REV6 Умею красить", [fact("REV6 покраска", [], 431, "capability")]), false);
    const d = await snapshot(draft.profileId);
    expect(d.sourceText).toBe(["REV6 Собираю мебель", "REV6 Умею красить"].join(PROFILE_SOURCE_SEPARATOR));
    expect(d.resources).toEqual([]);

    // reprocess of an applied profile that still contains a revoked message rebuilds instead
    const u2 = await user();
    const g2 = await message(u2, says("REV7 Есть Газель", [van("REV7")]));
    const f2 = await message(u2, says("REV7 Собираю мебель", [assembly("REV7")]));
    await revoke(u2, g2.sourceInputId, true);
    expect(await reprocessProfile(f2.profileId)).toMatchObject({ action: "rebuild-after-source-revoke", dryRun: true });
    expect(await reprocessProfile(f2.profileId, undefined, true)).toMatchObject({ action: "rebuilt", inputs: 1 });
    expect((await snapshot((await applied(u2))!.id)).sourceText).toBe("REV7 Собираю мебель");

    // the worker tick re-dispatches a profile left in rebuild_pending (API enqueue is best effort)
    const u3 = await user();
    const g3 = await message(u3, says("REV8 Есть Газель", [van("REV8")]));
    await message(u3, says("REV8 Собираю мебель", [assembly("REV8")]));
    await revoke(u3, g3.sourceInputId);
    const dispatched: string[] = [];
    await dispatchProfileRebuilds(async (userId) => { dispatched.push(userId); });
    expect(dispatched).toContain(u3);
  });

  it("a pending draft built on the revoked profile is invalidated and its message re-extracted on the rebuilt one", async () => {
    const u = await user();
    const gazel = await message(u, says("REV9 Есть Газель", [van("REV9")]));
    const pending = await message(u, says("REV9 Собираю мебель", [assembly("REV9")]), false);
    expect((await snapshot(pending.profileId)).sourceText).toContain("Газель");
    await revoke(u, gazel.sourceInputId);
    const enqueued: string[] = [];
    const result = await handleProfileRebuild({ id: randomUUID(), data: { userId: u } } as never,
      async (_u, sourceInputId) => { enqueued.push(sourceInputId); });
    expect(result).toMatchObject({ action: "cleared", reextracted: 1 });
    expect(enqueued).toEqual([pending.sourceInputId]);
    expect((await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, pending.profileId) }))?.status).toBe("invalidated");
    const redo = await extract(u, pending.sourceInputId);
    expect(redo.profileId).not.toBe(pending.profileId);
    const s = await snapshot(redo.profileId);
    expect(s).toMatchObject({ sourceText: "REV9 Собираю мебель", resources: [], capabilities: ["assembly"] });
    // re-running the job does not duplicate the re-extraction
    expect(await handleProfileRebuild({ id: randomUUID(), data: { userId: u } } as never, async () => undefined))
      .toMatchObject({ action: "noop", reextracted: 0 });
  });

  it("baseline: a user without revoked messages is untouched (no rebuild, no AI call, same cumulative source)", async () => {
    const u = await user();
    await message(u, says("REV10 Есть Газель", [van("REV10")]));
    const second = await message(u, says("REV10 Собираю мебель", [assembly("REV10")]));
    const calls = vi.mocked(mockProviders.extraction.extractCapabilityProfile).mock.calls.length;
    expect(await rebuildProfileIfNeeded(u)).toEqual({ action: "noop" });
    expect(await handleProfileRebuild({ id: randomUUID(), data: { userId: u } } as never, async () => undefined))
      .toMatchObject({ action: "noop", reextracted: 0 });
    expect(vi.mocked(mockProviders.extraction.extractCapabilityProfile).mock.calls.length).toBe(calls);
    expect((await applied(u))?.id).toBe(second.profileId);
    const s = await snapshot(second.profileId);
    expect(s.sourceText).toBe(["REV10 Есть Газель", "REV10 Собираю мебель"].join("\nПоследнее изменение пользователя:\n"));
    expect(s.resources).toEqual(["van"]);
    const dispatched: string[] = [];
    await dispatchProfileRebuilds(async (userId) => { dispatched.push(userId); });
    expect(dispatched).not.toContain(u);
  });
});
