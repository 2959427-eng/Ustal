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
import { dispatchEmbeddingRefreshes, handleProfileEmbeddingRefresh } from "./handlers/profile-embedding-refresh.js";
import { handleProfileTranscribe } from "./handlers/profile-transcribe.js";
import { runProfileExtractionJob } from "./handlers/profile-extraction.js";
import { skipDeletedAccount } from "./account-guard.js";

/**
 * Direct revoke/restore кнопкой (2026-10-17) end-to-end на настоящей PostgreSQL с fixture AI: действие API
 * (apps/api lib/profile-items.ts, без AI) → новая applied-версия → matching/review; гонка с уже идущим AI-обновлением;
 * переборка профиля после отзыва сообщения сохраняет решение; задача пересчёта вектора документа.
 */
// The API action itself (apps/api lib/profile-items.ts) — imported by path at runtime so the worker's tsc
// rootDir stays apps/worker/src; the API typechecks and tests it on its side.
const API_LIB = "../../api/src/lib/profile-items.js";
type ApiLib = {
  applyProfileItemAction: (db: unknown, input: { userId: string; kind: string; id: string; action: string }) => Promise<{ status: number; body: unknown; refreshEmbedding?: boolean }>;
  loadRemovedItems: (db: unknown, userId: string, facts: unknown[]) => Promise<{ id: string; kind: string; label: string }[]>;
};
const { applyProfileItemAction, loadRemovedItems } = (await import(/* @vite-ignore */ API_LIB)) as ApiLib;
const ACCOUNT_LIB = "../../api/src/lib/account-deletion.js";
const { deleteAccount } = (await import(/* @vite-ignore */ ACCOUNT_LIB)) as {
  deleteAccount: (db: unknown, userId: string) => Promise<{ status: string }>;
};
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
  await db.insert(schema.userProfiles).values({ userId: u!.id, name: "TEST item-action", cityId: city, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
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
  const [c] = await db.insert(schema.cities).values({ name: `TEST item-action ${randomUUID()}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
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

const resourceId = async (profileId: string) => (await db.query.userResources.findFirst({ where: eq(schema.userResources.capabilityProfileId, profileId) }))!.id;
const act = (userId: string, kind: "capability" | "resource" | "restriction", id: string, action: "revoke" | "restore") =>
  applyProfileItemAction(db as never, { userId, kind, id, action });
const lastReview = () => reviewCalls.at(-1)?.profile.join("\n") ?? "";

describe("direct revoke/restore end-to-end", () => {
  it("revoke resource → matching/review stop using it at once; restore → back; repeat is idempotent; no AI extraction", async () => {
    const u = await user();
    const m1 = await message(u, says("DIR1 Есть газель и собираю мебель", [van("DIR1"), assembly("DIR1")]));
    const oid = await vanOrder("DIR1");
    expect(await matched(oid, u)).toBe(true);
    const calls = vi.mocked(mockProviders.extraction.normalizeMatching).mock.calls.length;
    const id = await resourceId(m1.profileId);

    const r = await act(u, "resource", id, "revoke");
    expect(r).toMatchObject({ status: 200, body: { status: "revoked", changed: true } });
    expect(vi.mocked(mockProviders.extraction.normalizeMatching).mock.calls.length).toBe(calls);
    const cur = await applied(u);
    expect(cur!.id).not.toBe(m1.profileId);
    const snap = await snapshot(cur!.id);
    expect(snap.resources).toEqual([]);
    expect(snap.sourceText).toBe((await snapshot(m1.profileId)).sourceText); // raw history unchanged
    expect(await matched(oid, u)).toBe(false);
    if (reviewCalls.length) expect(lastReview()).not.toMatch(/газел/i);

    // Repeating the same decision with the old id: idempotent, no new version.
    expect(await act(u, "resource", id, "revoke")).toMatchObject({ status: 200, body: { changed: false } });
    expect((await applied(u))!.id).toBe(cur!.id);

    // The old id is only a lookup of the previous version: a different decision with it is stale (409), not a 500.
    expect(await act(u, "resource", id, "restore")).toMatchObject({ status: 409, body: { error: { code: "stale_item" } } });
    // «Восстановить» uses the id from the removed list of the current version (GET /profile → removed).
    const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, cur!.id), orderBy: desc(schema.matchingDocuments.processedAt) });
    const removed = await loadRemovedItems(db as never, u, await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc!.id)));
    expect(removed).toMatchObject([{ kind: "resource", label: expect.stringMatching(/газель/) }]);
    const back = await act(u, "resource", removed[0]!.id, "restore");
    expect(back).toMatchObject({ status: 200, body: { status: "restored", changed: true } });
    expect((await snapshot((await applied(u))!.id)).resources).toEqual(["van"]);
    expect(await matched(oid, u)).toBe(true);
    const decisions = await db.select().from(schema.profileItemDecisions).where(eq(schema.profileItemDecisions.userId, u));
    expect(decisions.map((d) => d.action).sort()).toEqual(["restore", "revoke"]);
  });

  it("in-flight AI update started on the old version is rebased: it cannot resurrect the revoked item", async () => {
    const u = await user();
    const m1 = await message(u, says("DIR2 Есть газель", [van("DIR2")]));
    const id = await resourceId(m1.profileId);
    const text = says("DIR2 Собираю мебель", [assembly("DIR2"), { ...van("DIR2"), evidence: "" }]);
    // The direct action lands while the extraction of the next message is already running (before its draft is saved).
    const spy = vi.mocked(mockProviders.extraction.normalizeMatching);
    const original = spy.getMockImplementation()!;
    let fired = false;
    spy.mockImplementation(async (input, meta) => {
      if (!fired && input.text.includes("DIR2 Собираю")) { fired = true; expect(await act(u, "resource", id, "revoke")).toMatchObject({ status: 200 }); }
      return original(input, meta);
    });
    try {
      const s = await send(u, text);
      const p = await extract(u, s.id);
      // Rebased on the version the button created (ProfileBaseChanged → retry), not on the stale one.
      const draft = await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, p.profileId) });
      expect(draft!.profileVersion).toBeGreaterThan((await applied(u))!.profileVersion);
      await apply(u, p.profileId);
    } finally { spy.mockImplementation(original); }
    expect(fired).toBe(true);
    const snap = await snapshot((await applied(u))!.id);
    expect(snap.capabilities).toEqual(["assembly"]);
    expect(snap.resources).toEqual([]);
  });

  it("a pending draft blocks the direct action (409), a rebuild in progress too", async () => {
    const u = await user();
    const m1 = await message(u, says("DIR3 Есть газель", [van("DIR3")]));
    const id = await resourceId(m1.profileId);
    const pending = await message(u, says("DIR3 Собираю мебель", [assembly("DIR3")]), false);
    expect(await act(u, "resource", id, "revoke")).toMatchObject({ status: 409, body: { error: { code: "profile_draft_pending" } } });
    await apply(u, pending.profileId);
    await revoke(u, pending.sourceInputId);
    expect(await act(u, "resource", id, "revoke")).toMatchObject({ status: 409 });
  });

  it("rebuild after a message revoke replays the button decision: the removed resource does not come back", async () => {
    const u = await user();
    const m1 = await message(u, says("DIR4 Есть газель", [van("DIR4")]));
    const m2 = await message(u, says("DIR4 Собираю мебель", [assembly("DIR4")]));
    expect(await act(u, "resource", await resourceId(m2.profileId), "revoke")).toMatchObject({ status: 200 });
    const m3 = await message(u, says("DIR4 Умею вешать полки", [fact("DIR4 полки", ["assembly"], 421, "capability")]));
    void m1;
    await revoke(u, m3.sourceInputId);
    const result = await handleProfileRebuild({ id: randomUUID(), data: { userId: u } } as never, async () => undefined);
    expect(result).toMatchObject({ action: "rebuilt" });
    const snap = await snapshot((await applied(u))!.id);
    expect(snap.resources).toEqual([]);
    expect(snap.capabilities).toEqual(["assembly"]);
  });

  it("capability revoke → embedding refresh job: 1 embedding call, positive text without the removed skill, rematch requested", async () => {
    const u = await user();
    const m1 = await message(u, says("DIR5 Собираю мебель", [assembly("DIR5"), fact("DIR5 покраска", [], 430, "capability")]));
    const cap = await db.query.userCapabilities.findFirst({ where: eq(schema.userCapabilities.capabilityProfileId, m1.profileId) });
    const r = await act(u, "capability", cap!.id, "revoke");
    expect(r).toMatchObject({ status: 200, refreshEmbedding: true });
    const profileId = (await applied(u))!.id;
    await db.delete(schema.rematchRequests).where(eq(schema.rematchRequests.userId, u));
    const embed = vi.mocked(mockProviders.embedding.embed);
    const before = embed.mock.calls.length;
    const normalize = vi.mocked(mockProviders.extraction.normalizeMatching).mock.calls.length;
    expect(await handleProfileEmbeddingRefresh({ id: randomUUID(), data: { userId: u } } as never)).toEqual({ refreshed: true });
    expect(embed.mock.calls.length - before).toBe(1);
    expect(embed.mock.calls.at(-1)![0]).toEqual(["DIR5 покраска"]);
    expect(vi.mocked(mockProviders.extraction.normalizeMatching).mock.calls.length).toBe(normalize);
    const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profileId) });
    expect((doc!.embedding as number[])[430]).toBe(1);
    expect(await db.query.rematchRequests.findFirst({ where: eq(schema.rematchRequests.userId, u) })).toBeTruthy();
    // Done: the request is cleared, a second run does nothing (no embedding call).
    expect(await handleProfileEmbeddingRefresh({ id: randomUUID(), data: { userId: u } } as never)).toEqual({ skipped: "clean" });
    expect(embed.mock.calls.length - before).toBe(1);
  });

  // ---- Аудит Codex (2026-10-17, №1 и №2): векторы — состояние stale на версии, matching его уважает ----
  // Unique per run: the AI review cache persists in the test DB between runs.
  const RUN = randomUUID().slice(0, 6);
  const refresh = (userId: string) => handleProfileEmbeddingRefresh({ id: randomUUID(), data: { userId } } as never);
  const current = async (u: string) => (await applied(u))!;
  const currentDocVector = async (u: string) => {
    const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, (await current(u)).id), orderBy: desc(schema.matchingDocuments.processedAt) });
    return doc!.embedding as number[];
  };
  const capId = async (u: string, label: RegExp) => (await db.query.userCapabilities.findMany({ where: eq(schema.userCapabilities.capabilityProfileId, (await current(u)).id) })).find((c) => label.test(c.label))!.id;
  async function assemblyOrder(tag: string) {
    const author = await user();
    const text = says(`${tag} заказ: собрать шкаф`, [fact(`${tag} сборка шкафа`, ["assembly"], 420, "capability")]);
    const [o] = await db.insert(schema.orders).values({ authorId: author, cityId: city, sourceText: text, status: "processing" }).returning();
    orders.push(o!.id);
    await handleOrderExtraction({ id: randomUUID(), data: { orderId: o!.id } } as never);
    await db.update(schema.orders).set({ status: "published" }).where(eq(schema.orders.id, o!.id));
    return o!.id;
  }

  it("E1/E2. revoked capability: the old vector is still stored but marked stale and NOT used — even when review fails technically", async () => {
    const u = await user();
    await message(u, says(`${RUN}EMB1 Собираю мебель, крашу стены`, [assembly(`${RUN}EMB1`), fact(`${RUN}EMB1 покраска`, ["digging"], 431, "capability")]));
    const before = await currentDocVector(u);
    expect(before[420]).toBe(1); // positive text starts with the assembly skill
    const oid = await assemblyOrder(`${RUN}EMB1`);
    const review = vi.mocked(mockProviders.extraction.reviewSemantic);
    const original = review.getMockImplementation()!;
    review.mockImplementation(async () => wrap({ compatible: true, confidence: 0.95, reason: "fixture: compatible" }) as never);
    try { expect(await matched(oid, u)).toBe(true); } finally { review.mockImplementation(original); }
    expect((await act(u, "capability", await capId(u, /сборка/), "revoke")).status).toBe(200);
    expect((await current(u)).embeddingStale).toBe(true);
    expect((await currentDocVector(u))[420]).toBe(1); // physically still there
    review.mockImplementation(async () => { throw new Error("review provider down"); });
    try { expect(await matched(oid, u)).toBe(false); } finally { review.mockImplementation(original); }
    // E3: after the refresh the new vector participates; stale is cleared atomically.
    expect(await refresh(u)).toMatchObject({ refreshed: true });
    expect((await current(u)).embeddingStale).toBe(false);
    expect((await currentDocVector(u))[431]).toBe(1);
  });

  it("E9. every item removed by the user: the empty effective profile is never sent to AI review and is not delivered (live E2E 2026-10-18)", async () => {
    const u = await user();
    await message(u, says(`${RUN}EMB9 Собираю мебель`, [assembly(`${RUN}EMB9`)]));
    const oid = await assemblyOrder(`${RUN}EMB9`);
    expect((await act(u, "capability", await capId(u, /сборка/), "revoke")).status).toBe(200);
    await refresh(u);
    const review = vi.mocked(mockProviders.extraction.reviewSemantic);
    const original = review.getMockImplementation()!;
    // Like the live model on an empty profile: «Профиль не содержит информации, исключающей…» → compatible.
    const seen: string[] = [];
    review.mockImplementation(async (input) => { seen.push((input as { profile: string[] }).profile.join("\n")); return wrap({ compatible: true, confidence: 0.9, reason: "nothing excludes it" }) as never; });
    const vid = await vanOrder(`${RUN}EMB9`);
    try {
      expect(await matched(oid, u)).toBe(false);
      expect(await matched(vid, u)).toBe(false); // no van ever stated, the only skill removed
    } finally { review.mockImplementation(original); }
    expect(seen.filter((t) => !t.trim())).toEqual([]);
  });

  it("E10. deleted account (DELETE /me): never matched again, its queued voice message is skipped without STT (2026-10-19)", async () => {
    const u = await user();
    await message(u, says(`${RUN}EMB10 Собираю мебель`, [assembly(`${RUN}EMB10`)]));
    const oid = await assemblyOrder(`${RUN}EMB10`);
    const review = vi.mocked(mockProviders.extraction.reviewSemantic);
    const original = review.getMockImplementation()!;
    review.mockImplementation(async () => wrap({ compatible: true, confidence: 0.95, reason: "fixture: compatible" }) as never);
    try {
      expect(await matched(oid, u)).toBe(true);
      const [voice] = await db.insert(schema.profileSourceInputs).values({ userId: u, inputType: "voice", status: "transcribing" }).returning();
      expect(await deleteAccount(db, u)).toMatchObject({ status: "deleted" });
      expect(await matched(oid, u)).toBe(false);
      const stt = vi.spyOn(mockProviders.stt, "transcribe");
      expect(await handleProfileTranscribe({ id: randomUUID(), data: { sourceInputId: voice!.id } } as never)).toMatchObject({ skipped: "source_deleted" });
      expect(stt).not.toHaveBeenCalled();
      expect(await applied(u)).toBeUndefined();
    } finally { review.mockImplementation(original); }
  });

  it("E11. extraction in flight while the account is deleted: no draft/profile/facts resurrect, the job is skipped (Codex 2026-10-19)", async () => {
    const u = await user();
    const text = says(`${RUN}EMB11 Собираю мебель`, [assembly(`${RUN}EMB11`)]);
    const s = await send(u, text);
    const normalize = vi.mocked(mockProviders.extraction.normalizeMatching);
    const original = normalize.getMockImplementation()!;
    let entered!: () => void, release!: () => void;
    const inAi = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { release = r; });
    normalize.mockImplementation(async (input, meta) => { if (input.text.includes(`${RUN}EMB11`)) { entered(); await gate; } return original(input, meta); });
    try {
      const job = skipDeletedAccount(runProfileExtractionJob)({ id: randomUUID(), data: { userId: u, sourceInputId: s.id } } as never);
      await inAi;
      expect(await deleteAccount(db, u)).toMatchObject({ status: "deleted" });
      release();
      expect(await job).toMatchObject({ skipped: "account_deleted" });
    } finally { normalize.mockImplementation(original); }
    expect(await db.query.capabilityProfiles.findMany({ where: eq(schema.capabilityProfiles.userId, u) })).toEqual([]);
    expect(await db.query.profileFacts.findMany({ where: eq(schema.profileFacts.userId, u) })).toEqual([]);
    // a queued job delivered later is skipped up front, without AI
    const calls = normalize.mock.calls.length;
    expect(await skipDeletedAccount(runProfileExtractionJob)({ id: randomUUID(), data: { userId: u, sourceInputId: s.id } } as never)).toMatchObject({ skipped: "account_deleted" });
    expect(normalize.mock.calls.length).toBe(calls);
  });

  it("E4. resource-only action on a clean profile stays clean, no embedding call", async () => {
    const u = await user();
    const m = await message(u, says(`${RUN}EMB4 Собираю мебель, есть газель`, [assembly(`${RUN}EMB4`), van(`${RUN}EMB4`)]));
    const calls = vi.mocked(mockProviders.embedding.embed).mock.calls.length;
    expect((await act(u, "resource", await resourceId(m.profileId), "revoke")).status).toBe(200);
    expect((await current(u)).embeddingStale).toBe(false);
    expect(await refresh(u)).toMatchObject({ skipped: "clean" });
    expect(vi.mocked(mockProviders.embedding.embed).mock.calls.length).toBe(calls);
  });

  it("E5. stale is carried to the next version (resource action before the job) until the latest state is embedded", async () => {
    const u = await user();
    await message(u, says(`${RUN}EMB5 Собираю мебель, крашу стены, есть газель`, [assembly(`${RUN}EMB5`), fact(`${RUN}EMB5 покраска`, ["digging"], 432, "capability"), van(`${RUN}EMB5`)]));
    await act(u, "capability", await capId(u, /сборка/), "revoke");
    await act(u, "resource", await resourceId((await current(u)).id), "revoke");
    expect((await current(u)).embeddingStale).toBe(true);
    expect(await refresh(u)).toMatchObject({ refreshed: true });
    expect((await current(u)).embeddingStale).toBe(false);
    expect((await currentDocVector(u))[432]).toBe(1);
  });

  it("E6. an old job (computed for an older version) cannot clear stale of the newer one", async () => {
    const u = await user();
    await message(u, says(`${RUN}EMB6 Собираю мебель, крашу стены`, [assembly(`${RUN}EMB6`), fact(`${RUN}EMB6 покраска`, ["digging"], 433, "capability")]));
    await act(u, "capability", await capId(u, /сборка/), "revoke");
    const embed = vi.mocked(mockProviders.embedding.embed);
    const original = embed.getMockImplementation()!;
    let raced = false;
    embed.mockImplementation(async (texts, meta) => {
      if (!raced) { raced = true; expect((await act(u, "capability", await capId(u, /покраска/), "revoke")).status).toBe(200); }
      return original(texts, meta);
    });
    try { expect(await refresh(u)).toMatchObject({ refreshed: true }); } finally { embed.mockImplementation(original); }
    expect(raced).toBe(true);
    // The latest state (no skills) was embedded, not the one computed for the older version.
    expect((await current(u)).embeddingStale).toBe(false);
    expect((await currentDocVector(u))[433]).toBe(0);
    expect((await currentDocVector(u))[100]).toBe(1);
  });

  it("E7. enqueue failure: the version stays stale (fail-safe) and the dispatcher finds it", async () => {
    const u = await user();
    await message(u, says(`${RUN}EMB7 Собираю мебель, крашу стены`, [assembly(`${RUN}EMB7`), fact(`${RUN}EMB7 покраска`, ["digging"], 434, "capability")]));
    await act(u, "capability", await capId(u, /сборка/), "revoke");
    expect((await current(u)).embeddingStale).toBe(true);
    const queued: string[] = [];
    await dispatchEmbeddingRefreshes(async (userId: string) => { queued.push(userId); });
    expect(queued).toContain(u);
  });

  it("E8. a new document written into the SAME version during the job (reprocess) → the job recomputes on the latest document", async () => {
    const u = await user();
    await message(u, says(`${RUN}EMB8 Собираю мебель, крашу стены`, [assembly(`${RUN}EMB8`), fact(`${RUN}EMB8 покраска`, ["digging"], 435, "capability")]));
    await act(u, "capability", await capId(u, /сборка/), "revoke");
    const p = await current(u);
    const embed = vi.mocked(mockProviders.embedding.embed);
    const original = embed.getMockImplementation()!;
    let raced = false;
    embed.mockImplementation(async (texts, meta) => {
      if (!raced) {
        raced = true;
        // Same profile version, newer document (what reprocess does through persistDocument), same facts.
        const d = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, p.id), orderBy: desc(schema.matchingDocuments.processedAt) });
        const { id: _id, processedAt: _at, ...rest } = d!; void _id; void _at;
        const [nd] = await db.insert(schema.matchingDocuments).values({ ...rest, sourceHash: randomUUID().replace(/-/g, "") }).returning();
        const fs = await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, d!.id));
        await db.insert(schema.matchingFacts).values(fs.map(({ id: _f, ...f }) => { void _f; return { ...f, documentId: nd!.id }; }));
      }
      return original(texts, meta);
    });
    try { expect(await refresh(u)).toMatchObject({ refreshed: true }); } finally { embed.mockImplementation(original); }
    expect(raced).toBe(true);
    expect((await current(u)).embeddingStale).toBe(false);
    expect((await currentDocVector(u))[435]).toBe(1); // the latest document of the version got the new vector
  });
});

