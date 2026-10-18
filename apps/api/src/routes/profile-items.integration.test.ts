import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { JOB_TYPES } from "@ustal/queue";

/**
 * POST /profile/items/:kind/:id/:action (2026-10-17): прямое «Убрать / Снять ограничение / Восстановить» без AI.
 * Очередь подменена (проверяем, что ставится только пересчёт вектора навыков, никакой extraction).
 */
const sent: { name: string; data: unknown }[] = [];
let queueDown = false;
vi.mock("@ustal/queue", async (orig) => ({ ...(await orig<typeof import("@ustal/queue")>()),
  getBoss: vi.fn(async () => ({ send: vi.fn(async (name: string, data: unknown) => {
    if (queueDown) throw new Error("queue down");
    sent.push({ name, data }); return "job"; }) })) }));
process.env.NODE_ENV = "test"; // loadEnv() без кеша: лимит действий переключается в тесте
const profileRoutes = (await import("./profile.js")).default;

assertLocalTestDatabase();
const db = getDb();
const users: string[] = [];
afterAll(async () => {
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await getSql().end();
});
beforeEach(() => { sent.length = 0; queueDown = false; delete process.env.PROFILE_ITEM_ACTIONS_PER_HOUR; });

const SRC = "Ремонтирую автомобили и делаю нейромассаж. Есть гараж. Не работаю после 18:00.";
const base = { constraintType: "none", constraintScope: "whole_task", resourceRole: "none", evidence: SRC, confidence: "0.950", mandatory: false } as const;
async function fixture(opts: { status?: "applied" | "rebuild_pending" } = {}) {
  const [user] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  users.push(user!.id);
  const [profile] = await db.insert(schema.capabilityProfiles).values({ userId: user!.id, summary: "Ремонт авто, гараж", profileVersion: 1,
    extractionVersion: "test", status: opts.status ?? "applied" }).returning();
  const CAR = randomUUID(), GARAGE = randomUUID();
  const [doc] = await db.insert(schema.matchingDocuments).values({ profileId: profile!.id, processingVersion: "test", sourceHash: randomUUID().replace(/-/g, ""),
    sourceText: SRC, embeddingModel: "test" }).returning();
  await db.insert(schema.matchingFacts).values([
    { ...base, documentId: doc!.id, kind: "capability", phrase: "ремонт автомобилей", label: "Ремонт автомобилей", nodeIds: [CAR] },
    { ...base, documentId: doc!.id, kind: "capability", phrase: "нейромассаж", label: "Нейромассаж", nodeIds: [] },
    { ...base, documentId: doc!.id, kind: "resource", phrase: "гараж", label: "Гараж", nodeIds: [GARAGE], resourceRole: "available" },
    { ...base, documentId: doc!.id, kind: "availability", phrase: "не работаю после 18:00", constraintType: "availability", endHour: 18 },
  ]);
  await db.insert(schema.userCapabilities).values({ capabilityProfileId: profile!.id, ontologyNodeId: CAR, label: "Ремонт автомобилей", evidenceType: "explicit", confidence: "0.95" });
  await db.insert(schema.userResources).values({ capabilityProfileId: profile!.id, ontologyNodeId: GARAGE, label: "Гараж", resourceType: "property", evidenceType: "explicit", confidence: "0.95" });
  const app = Fastify();
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => { request.userId = user!.id; });
  await app.register(profileRoutes);
  await app.ready();
  return { app, userId: user!.id, profile: profile! };
}
type View = { profile: { id: string; profileVersion: number }; capabilities: { id: string; label: string }[]; resources: { id: string; label: string }[];
  unmapped: { id: string; phrase: string; kind: string }[]; restrictions: { id: string; text: string }[]; removed: { id: string; kind: string; label: string }[] };
const view = async (app: Awaited<ReturnType<typeof fixture>>["app"]) => (await app.inject({ method: "GET", url: "/profile" })).json() as View;
const post = (app: Awaited<ReturnType<typeof fixture>>["app"], kind: string, id: string, action: string) =>
  app.inject({ method: "POST", url: `/profile/items/${kind}/${id}/${action}`, payload: {} });
const versions = (userId: string) => db.select().from(schema.capabilityProfiles).where(eq(schema.capabilityProfiles.userId, userId)).orderBy(desc(schema.capabilityProfiles.profileVersion));

describe("direct profile item actions", () => {
  it("GET /profile exposes item ids and an empty removed list", async () => {
    const { app } = await fixture();
    try {
      const v = await view(app);
      expect(v.capabilities[0]).toMatchObject({ id: expect.any(String), label: "Ремонт автомобилей" });
      expect(v.resources[0]).toMatchObject({ id: expect.any(String), label: "Гараж" });
      expect(v.unmapped).toMatchObject([{ id: expect.any(String), kind: "capability", phrase: "Нейромассаж" }]);
      expect(v.restrictions).toMatchObject([{ id: expect.any(String) }]);
      expect(v.removed).toEqual([]);
    } finally { await app.close(); }
  });

  it("capability: revoke → new applied version without it (raw text kept), embedding job + rematch; repeat idempotent; restore → back once", async () => {
    const { app, userId, profile } = await fixture();
    try {
      const cap = (await view(app)).capabilities[0]!;
      const r = await post(app, "capability", cap.id, "revoke");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: "revoked", changed: true, profileVersion: 2 });
      const v = await view(app);
      expect(v.profile.profileVersion).toBe(2);
      expect(v.capabilities).toEqual([]);
      expect(v.removed).toMatchObject([{ kind: "capability", label: "Ремонт автомобилей" }]);
      expect(v.resources.map((x) => x.label)).toEqual(["Гараж"]);
      const [cur, old] = await versions(userId);
      expect([cur!.status, old!.status]).toEqual(["applied", "superseded"]);
      expect(old!.id).toBe(profile.id);
      const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, cur!.id) });
      expect(doc!.sourceText).toBe(SRC);
      expect(sent).toEqual([{ name: JOB_TYPES.PROFILE_EMBEDDING_REFRESH, data: { userId } }]);
      expect(cur!.embeddingStale).toBe(true);
      expect(await db.query.rematchRequests.findFirst({ where: eq(schema.rematchRequests.userId, userId) })).toBeTruthy();
      const decisions = await db.select().from(schema.profileItemDecisions).where(eq(schema.profileItemDecisions.userId, userId));
      expect(decisions).toMatchObject([{ action: "revoke", family: "capability", profileVersion: 2 }]);

      // Same decision again (old id or a double tap): 200 changed:false, no new version, no job, no rematch spend.
      sent.length = 0;
      await db.delete(schema.rematchRequests).where(eq(schema.rematchRequests.userId, userId));
      expect((await post(app, "capability", cap.id, "revoke")).json()).toMatchObject({ changed: false, profileVersion: 2 });
      expect(sent).toEqual([]);
      expect(await db.query.rematchRequests.findFirst({ where: eq(schema.rematchRequests.userId, userId) })).toBeUndefined();
      expect((await versions(userId)).length).toBe(2);

      const back = await post(app, "capability", v.removed[0]!.id, "restore");
      expect(back.json()).toEqual({ status: "restored", changed: true, profileVersion: 3 });
      const after = await view(app);
      expect(after.capabilities.map((c) => c.label)).toEqual(["Ремонт автомобилей"]);
      expect(after.removed).toEqual([]);
      expect((await post(app, "capability", v.removed[0]!.id, "restore")).json()).toMatchObject({ changed: false });
    } finally { await app.close(); }
  });

  it("resource and unknown (no ontology node) items: revoke/restore, no embedding job for a resource", async () => {
    const { app } = await fixture();
    try {
      const v = await view(app);
      expect((await post(app, "resource", v.resources[0]!.id, "revoke")).statusCode).toBe(200);
      expect(sent).toEqual([]);
      // Every action creates a new version: the client re-reads the profile (ids are per version, lookup only).
      expect((await post(app, "capability", (await view(app)).unmapped[0]!.id, "revoke")).statusCode).toBe(200);
      const after = await view(app);
      expect(after.resources).toEqual([]);
      expect(after.unmapped).toEqual([]);
      expect(after.removed.map((x) => x.label).sort()).toEqual(["Гараж", "Нейромассаж"]);
      for (const label of ["Гараж", "Нейромассаж"]) {
        const item = (await view(app)).removed.find((x) => x.label === label)!;
        expect((await post(app, item.kind, item.id, "restore")).statusCode).toBe(200);
      }
      const back = await view(app);
      expect(back.resources.map((x) => x.label)).toEqual(["Гараж"]);
      expect(back.unmapped.map((x) => x.phrase)).toEqual(["Нейромассаж"]);
    } finally { await app.close(); }
  });

  it("restriction: «Снять ограничение» → gone from restrictions, listed as removed; restore → back", async () => {
    const { app } = await fixture();
    try {
      const v = await view(app);
      const r = await post(app, "restriction", v.restrictions[0]!.id, "revoke");
      expect(r.statusCode).toBe(200);
      const after = await view(app);
      expect(after.restrictions).toEqual([]);
      expect(after.removed).toMatchObject([{ kind: "restriction" }]);
      expect((await post(app, "restriction", after.removed[0]!.id, "restore")).statusCode).toBe(200);
      expect((await view(app)).restrictions.map((x) => x.text)).toEqual(v.restrictions.map((x) => x.text));
    } finally { await app.close(); }
  });

  it("errors are controlled: invalid kind/action/uuid, unknown and foreign ids → 404; stale id with another decision → 409", async () => {
    const a = await fixture(), b = await fixture();
    try {
      const v = await view(a.app);
      expect((await post(a.app, "skill", v.capabilities[0]!.id, "revoke")).statusCode).toBe(404);
      expect((await post(a.app, "capability", v.capabilities[0]!.id, "delete")).statusCode).toBe(404);
      expect((await post(a.app, "capability", "not-a-uuid", "revoke")).statusCode).toBe(404);
      expect((await post(a.app, "capability", randomUUID(), "revoke")).statusCode).toBe(404);
      // Item of another user.
      const foreign = (await view(b.app)).capabilities[0]!.id;
      expect((await post(a.app, "capability", foreign, "revoke")).statusCode).toBe(404);
      expect((await view(b.app)).capabilities).toHaveLength(1);
      // Wrong kind for the id.
      expect((await post(a.app, "resource", v.capabilities[0]!.id, "revoke")).statusCode).toBe(404);
      // Restore of an active item: already in that state → idempotent 200 changed:false, nothing changes.
      expect((await post(a.app, "capability", v.capabilities[0]!.id, "restore")).json()).toMatchObject({ changed: false, profileVersion: 1 });
      await post(a.app, "capability", v.capabilities[0]!.id, "revoke");
      const stale = await post(a.app, "capability", v.capabilities[0]!.id, "restore");
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe("stale_item");
    } finally { await a.app.close(); await b.app.close(); }
  });

  it("pending draft → 409 profile_draft_pending; rebuild in progress → 409 profile_rebuilding; no profile → 404", async () => {
    const a = await fixture();
    const r = await fixture({ status: "rebuild_pending" });
    try {
      const v = await view(a.app);
      await db.insert(schema.capabilityProfiles).values({ userId: a.userId, summary: "draft", profileVersion: 2, extractionVersion: "test", status: "draft" });
      const d = await post(a.app, "capability", v.capabilities[0]!.id, "revoke");
      expect(d.statusCode).toBe(409);
      expect(d.json().error.code).toBe("profile_draft_pending");
      const cap = await db.query.userCapabilities.findFirst({ where: eq(schema.userCapabilities.capabilityProfileId, r.profile.id) });
      const rb = await post(r.app, "capability", cap!.id, "revoke");
      expect(rb.statusCode).toBe(409);
      expect(rb.json().error.code).toBe("profile_rebuilding");
    } finally { await a.app.close(); await r.app.close(); }
  });

  it("an old draft cannot be applied over the version created by the button (409 stale_draft)", async () => {
    const { app, userId } = await fixture();
    try {
      // Legacy/stale draft row at the version the button will overtake (created before; e.g. by a stale job).
      const v = await view(app);
      expect((await post(app, "capability", v.capabilities[0]!.id, "revoke")).statusCode).toBe(200);
      const [old] = await db.update(schema.capabilityProfiles).set({ status: "draft" })
        .where(and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.profileVersion, 1))).returning();
      const res = await app.inject({ method: "POST", url: `/profile/draft/${old!.id}/apply`, payload: {} });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("stale_draft");
      expect((await view(app)).capabilities).toEqual([]);
    } finally { await app.close(); }
  });

  it("works with the AI-message limit exhausted (does not spend it); own limit → 429 only for changing actions", async () => {
    const { app, userId } = await fixture();
    try {
      await db.insert(schema.profileSourceInputs).values(Array.from({ length: 12 }, (_, i) => ({ userId, inputType: "text", rawText: `msg ${i}`, status: "confirmed" })));
      const before = (await db.select().from(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.userId, userId))).length;
      process.env.PROFILE_ITEM_ACTIONS_PER_HOUR = "2";
      const v = await view(app);
      expect((await post(app, "capability", v.capabilities[0]!.id, "revoke")).statusCode).toBe(200);
      expect((await post(app, "resource", (await view(app)).resources[0]!.id, "revoke")).statusCode).toBe(200);
      // Idempotent repeat is not counted and still answers 200.
      expect((await post(app, "resource", v.resources[0]!.id, "revoke")).statusCode).toBe(200);
      const limited = await post(app, "capability", (await view(app)).unmapped[0]!.id, "revoke");
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("rate_limited");
      expect((await db.select().from(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.userId, userId))).length).toBe(before);
    } finally { await app.close(); }
  });

  // ---- Аудит Codex (2026-10-17) ----
  it("R1. two resources on one ontology node: revoke one keeps the other; restore leaves it untouched", async () => {
    const { app, profile } = await fixture();
    try {
      const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profile.id) });
      const garage = (await db.query.userResources.findFirst({ where: eq(schema.userResources.capabilityProfileId, profile.id) }))!.ontologyNodeId;
      await db.insert(schema.matchingFacts).values({ ...base, documentId: doc!.id, kind: "resource", phrase: "гараж-бокс", label: "Гараж-бокс", nodeIds: [garage], resourceRole: "available" });
      await db.insert(schema.userResources).values({ capabilityProfileId: profile.id, ontologyNodeId: garage, label: "Гараж-бокс", resourceType: "property", evidenceType: "explicit", confidence: "0.95" });
      const v = await view(app);
      expect(v.resources.map((r) => r.label).sort()).toEqual(["Гараж", "Гараж-бокс"]);
      expect((await post(app, "resource", v.resources.find((r) => r.label === "Гараж")!.id, "revoke")).statusCode).toBe(200);
      const after = await view(app);
      expect(after.resources.map((r) => r.label)).toEqual(["Гараж-бокс"]);
      expect(after.removed.map((r) => r.label)).toEqual(["Гараж"]);
      expect((await post(app, "resource", after.removed[0]!.id, "restore")).statusCode).toBe(200);
      const back = await view(app);
      expect(back.resources.map((r) => r.label).sort()).toEqual(["Гараж", "Гараж-бокс"]);
    } finally { await app.close(); }
  });

  it("E7. queue down: the action still succeeds and the new version is stale (fail-safe) for the worker dispatcher", async () => {
    const { app, userId } = await fixture();
    try {
      queueDown = true;
      const v = await view(app);
      expect((await post(app, "capability", v.capabilities[0]!.id, "revoke")).statusCode).toBe(200);
      expect((await versions(userId))[0]!.embeddingStale).toBe(true);
    } finally { await app.close(); }
  });

  it("E4. resource-only action on a clean profile: stays clean, no job", async () => {
    const { app, userId } = await fixture();
    try {
      const v = await view(app);
      expect((await post(app, "resource", v.resources[0]!.id, "revoke")).statusCode).toBe(200);
      expect(sent).toEqual([]);
      expect((await versions(userId))[0]!.embeddingStale).toBe(false);
    } finally { await app.close(); }
  });

  it("C. composite fact on two ontology nodes: remove one part → the other stays under its own name; restore → original fact", async () => {
    const { app, profile } = await fixture();
    try {
      const nodes = await db.select().from(schema.ontologyNodes).limit(2);
      const [n1, n2] = nodes;
      const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profile.id) });
      const MSG = "Делаю это и то одним заходом";
      await db.insert(schema.matchingFacts).values({ ...base, documentId: doc!.id, kind: "capability", phrase: "делаю это и то", evidence: MSG, nodeIds: [n1!.id, n2!.id] });
      await db.insert(schema.userCapabilities).values([n1!, n2!].map((n) => ({ capabilityProfileId: profile.id, ontologyNodeId: n.id, label: "делаю это и то", evidenceType: "explicit", confidence: "0.95" })));
      const v = await view(app);
      const part = v.capabilities.find((c) => c.label === "делаю это и то")!;
      const cap1 = await db.query.userCapabilities.findFirst({ where: eq(schema.userCapabilities.id, part.id) });
      const removedNode = cap1!.ontologyNodeId, keptNode = removedNode === n1!.id ? n2! : n1!;
      expect((await post(app, "capability", part.id, "revoke")).statusCode).toBe(200);
      const after = await view(app);
      // The remaining part is shown and matched under its own ontology name, without the removed meaning.
      expect(after.capabilities.map((c) => c.label)).toContain(keptNode.nameRu);
      expect(after.capabilities.map((c) => c.label)).not.toContain("делаю это и то");
      const removed = after.removed.find((r) => r.kind === "capability")!;
      expect(removed).toBeTruthy();
      expect((await post(app, "capability", removed.id, "restore")).statusCode).toBe(200);
      const back = await view(app);
      expect(back.capabilities.filter((c) => c.label === "делаю это и то")).toHaveLength(2);
      const cur = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, back.profile.id) });
      const facts = await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, cur!.id));
      expect(facts.filter((f) => f.phrase === "делаю это и то" && f.kind === "capability")).toHaveLength(1);
    } finally { await app.close(); }
  });

  // ---- Аудит Codex №2 ----
  it("S6/T1. two lifted windows: restoring one leaves the other lifted; a skill's lifted hours leave its effective name clean", async () => {
    const { app, profile } = await fixture();
    try {
      const [node] = await db.select().from(schema.ontologyNodes).limit(1);
      const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profile.id) });
      await db.delete(schema.matchingFacts).where(and(eq(schema.matchingFacts.documentId, doc!.id), eq(schema.matchingFacts.kind, "availability")));
      await db.insert(schema.matchingFacts).values([
        { ...base, documentId: doc!.id, kind: "availability", phrase: "будни 09–18", evidence: "Будни 09–18.", constraintType: "availability", startHour: 9, endHour: 18, daysOfWeek: [0, 1, 2, 3, 4] },
        { ...base, documentId: doc!.id, kind: "availability", phrase: "выходные 12–18", evidence: "Выходные 12–18.", constraintType: "availability", startHour: 12, endHour: 18, daysOfWeek: [5, 6] },
        { ...base, documentId: doc!.id, kind: "capability", phrase: "услуга до 22:00", evidence: "Услуга до 22:00.", nodeIds: [node!.id], endHour: 22 },
      ]);
      await db.insert(schema.userCapabilities).values({ capabilityProfileId: profile.id, ontologyNodeId: node!.id, label: "услуга до 22:00", evidenceType: "explicit", confidence: "0.95" });
      for (const text of [/с 9:00 до 18:00/, /с 12:00 до 18:00/, /22:00/]) {
        const r = (await view(app)).restrictions.find((x) => text.test(x.text))!;
        expect((await post(app, "restriction", r.id, "revoke")).statusCode).toBe(200);
      }
      const lifted = await view(app);
      expect(lifted.restrictions).toEqual([]);
      expect(lifted.capabilities.map((c) => c.label)).toContain(node!.nameRu);
      expect(lifted.capabilities.map((c) => c.label)).not.toContain("услуга до 22:00");
      const weekdays = lifted.removed.find((x) => x.kind === "restriction" && /с 9:00/.test(x.label))!;
      expect((await post(app, "restriction", weekdays.id, "restore")).statusCode).toBe(200);
      const after = await view(app);
      expect(after.restrictions.map((x) => x.text).join(" | ")).toMatch(/с 9:00 до 18:00/);
      expect(after.restrictions.map((x) => x.text).join(" | ")).not.toMatch(/с 12:00/);
      expect(after.removed.filter((x) => x.kind === "restriction").map((x) => x.label).join(" | ")).toMatch(/с 12:00 до 18:00/);
    } finally { await app.close(); }
  });

  it("live E2E shape: «Снять ограничение» on a skill with its own hours keeps the skill; restore returns the hours without a duplicate", async () => {
    const { app, profile, userId } = await fixture();
    try {
      const [node] = await db.select().from(schema.ontologyNodes).limit(1);
      const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profile.id) });
      await db.insert(schema.matchingFacts).values({ ...base, documentId: doc!.id, kind: "capability", phrase: "настройка умных колонок", label: "Настройка умных колонок",
        evidence: "Настраиваю умные колонки до 22:00.", nodeIds: [node!.id], constraintType: "availability", constraintScope: "fact", endHour: 22 });
      await db.insert(schema.userCapabilities).values({ capabilityProfileId: profile.id, ontologyNodeId: node!.id, label: "Настройка умных колонок", evidenceType: "explicit", confidence: "0.95" });
      const v = await view(app);
      expect(v.capabilities.map((c) => c.label)).toContain("Настройка умных колонок");
      const r = v.restrictions.find((x) => /22:00/.test(x.text))!;
      expect((await post(app, "restriction", r.id, "revoke")).statusCode).toBe(200);
      const after = await view(app);
      expect(after.capabilities.map((c) => c.label)).toContain("Настройка умных колонок");
      expect(after.restrictions.some((x) => /22:00/.test(x.text))).toBe(false);
      expect(after.removed.map((x) => x.kind)).toEqual(["restriction"]);
      expect((await versions(userId))[0]!.embeddingStale).toBe(true);
      expect((await post(app, "restriction", after.removed[0]!.id, "restore")).statusCode).toBe(200);
      const back = await view(app);
      expect(back.capabilities.filter((c) => c.label === "Настройка умных колонок")).toHaveLength(1);
      expect(back.restrictions.some((x) => /22:00/.test(x.text))).toBe(true);
      expect(back.removed).toEqual([]);
      const cur = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, back.profile.id) });
      const facts = await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, cur!.id));
      expect(facts.filter((x) => x.kind === "capability" && x.label === "Настройка умных колонок")).toHaveLength(1);
    } finally { await app.close(); }
  });
});

