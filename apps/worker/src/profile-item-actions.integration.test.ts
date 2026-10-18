import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, PROFILE_SOURCE_SEPARATOR as SEP, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { evaluateSemantic, isUserRemovedMarker, itemKey, liftRestrictionFacts, restoreProfileItem, revokeProfileItem, type ProfileItemIdentity } from "@ustal/matching";
import { prepareDocument, prepareProfileFromMessages, type PreparedDocument } from "./semantic.js";
import { reviewProfileText } from "./profile-restrictions.js";
import { applyDecision, loadDecisions, scheduleDecisions } from "./profile-decisions.js";
assertLocalTestDatabase();
afterAll(async () => { await getSql().end(); });

/**
 * Прямое удаление/восстановление пунктов профиля кнопкой (2026-10-17): решение пользователя без AI, затем
 * обычные AI-обновления через настоящий prepareDocument (ответ нормализации подставлен, в т.ч. враждебный).
 */
const fact = (o: Record<string, unknown>) => ({
  kind: "capability", subjectType: "unspecified", canonicalKeys: [], confidence: 0.95, mandatory: false, constraintType: "none",
  constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null, ...o,
});
const mock = (facts: Record<string, unknown>[]) => vi.spyOn(mockProviders.extraction, "normalizeMatching").mockResolvedValue({
  data: { facts: facts.map(fact) }, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 } as never);
async function first(text: string, facts: Record<string, unknown>[]) {
  const spy = mock(facts);
  try { return await prepareDocument("profile", text, {}, randomUUID()); } finally { spy.mockRestore(); }
}
async function update(prior: { sourceText: string; facts: PreparedDocument["facts"] }, text: string, facts: Record<string, unknown>[]) {
  const spy = mock(facts);
  try { return await prepareDocument("profile", text, {}, randomUUID(), prior); } finally { spy.mockRestore(); }
}
const keys = async (ids: string[]) => ids.length ? (await getDb().select({ k: schema.ontologyNodes.canonicalKey }).from(schema.ontologyNodes).where(inArray(schema.ontologyNodes.id, ids))).map((r) => r.k) : [];
const live = (facts: PreparedDocument["facts"]) => facts.filter((f) => (f.kind as string) !== "superseded");
const skills = async (facts: PreparedDocument["facts"]) => (await Promise.all(live(facts).filter((f) => f.kind === "capability").map((f) => keys(f.nodeIds)))).flat().sort();
const resources = (facts: PreparedDocument["facts"]) => live(facts).filter((f) => f.kind === "resource" && f.resourceRole === "available").map((f) => f.phrase).sort();
const identityOf = (facts: PreparedDocument["facts"], family: "capability" | "resource", phrase: string): ProfileItemIdentity => {
  const f = live(facts).find((x) => x.phrase === phrase)!;
  return { family, nodeIds: f.nodeIds, key: itemKey(f.label || f.phrase) };
};
/** Кнопка «Убрать»: та же чистая функция, что вызывает API, — без AI. */
const revoke = (doc: PreparedDocument, family: "capability" | "resource", phrase: string) => {
  const r = revokeProfileItem(doc.facts, identityOf(doc.facts, family, phrase));
  expect(r.removed.length).toBeGreaterThan(0);
  return { state: { sourceText: doc.sourceText, facts: r.facts }, removed: r.removed, identity: identityOf(doc.facts, family, phrase) };
};
async function decide(facts: PreparedDocument["facts"], order: string, key: string, hour: number | null = null, documentSimilarity = 0.9) {
  const spy = mock([{ phrase: order, evidence: order, canonicalKeys: [key] },
    ...(hour == null ? [] : [{ kind: "availability", phrase: order, evidence: order, constraintType: "availability", startHour: hour, endHour: hour }])]);
  let req; try { req = (await prepareDocument("order", order, {}, randomUUID())).facts; } finally { spy.mockRestore(); }
  return evaluateSemantic({ capabilities: facts, requirements: req, relations: [], documentSimilarity, riskLevel: 0, regulated: false });
}

const START = "Могу копать и ремонтирую бытовую технику. Есть машина.";
const startFacts = [
  { phrase: "копать", evidence: START, canonicalKeys: ["digging"] },
  { phrase: "ремонт бытовой техники", evidence: START, canonicalKeys: ["appliance_repair"] },
  { kind: "resource", subjectType: "physical_resource", resourceRole: "available", phrase: "машина", evidence: START, canonicalKeys: ["car"] },
];

describe("direct revoke/restore: resurrection guard", () => {
  it("A. capability revoked by button → unrelated message + hostile AI echo: stays removed, the new skill is added", async () => {
    const p1 = await first(START, startFacts);
    const { state } = revoke(p1, "capability", "копать");
    expect(await skills(state.facts)).toEqual(["appliance_repair"]);
    const msg = "Умею красить стены.";
    const p2 = await update(state, msg, [
      { phrase: "покраска стен", evidence: msg, canonicalKeys: ["wall_painting"] },
      // Hostile/sloppy model: brings the removed skill back on the new message (old evidence is already rejected
      // by the existing evidence guard: "unsupported source evidence").
      { phrase: "копать", evidence: msg, canonicalKeys: ["digging"] },
    ]);
    expect(await skills(p2.facts)).not.toContain("digging");
    expect(live(p2.facts).filter((f) => f.kind === "capability").map((f) => f.phrase).sort()).toEqual(["покраска стен", "ремонт бытовой техники"]);
    expect(p2.facts.filter(isUserRemovedMarker)).toHaveLength(1);
  });

  it("A2. an explicit new message restores the removed skill (no duplicate)", async () => {
    const p1 = await first(START, startFacts);
    const { state } = revoke(p1, "capability", "копать");
    const msg = "Снова могу копать.";
    const p2 = await update(state, msg, [{ phrase: "копать", evidence: msg, canonicalKeys: ["digging"] }]);
    expect((await skills(p2.facts)).filter((k) => k === "digging")).toHaveLength(1);
    expect((await decide(p2.facts, "Нужно выкопать яму", "digging")).matchType).not.toBeNull();
  });

  it("B. resource revoked → unrelated message + AI echo of the same resource: not back; «Купил новую машину» → back once", async () => {
    const p1 = await first(START, startFacts);
    const { state } = revoke(p1, "resource", "машина");
    const msg = "Умею красить стены.";
    const p2 = await update(state, msg, [
      { phrase: "покраска стен", evidence: msg, canonicalKeys: ["wall_painting"] },
      { kind: "resource", subjectType: "physical_resource", resourceRole: "available", phrase: "машина", evidence: msg, canonicalKeys: ["car"] },
    ]);
    expect(resources(p2.facts)).toEqual([]);
    const buy = "Купил новую машину.";
    const p3 = await update({ sourceText: p2.sourceText, facts: p2.facts }, buy,
      [{ kind: "resource", subjectType: "physical_resource", resourceRole: "available", phrase: "машина", evidence: buy, canonicalKeys: ["car"] }]);
    expect(resources(p3.facts)).toEqual(["машина"]);
  });

  it("C. restriction lifted by button → unrelated AI echo of the old restriction: it does not come back", async () => {
    const WIN = "Не работаю после 18:00.";
    const p1 = await first([START, WIN].join(SEP), [...startFacts,
      { kind: "availability", phrase: "не работаю после 18:00", evidence: WIN, constraintType: "availability", endHour: 18 }]);
    const lifted = liftRestrictionFacts(p1.facts, (f) => f.kind === "availability");
    expect((await decide(lifted.facts, "Выкопать яму в 20:00", "digging", 20)).reason).not.toBe("outside_availability");
    const msg = "Умею красить стены.";
    const p2 = await update({ sourceText: p1.sourceText, facts: lifted.facts }, msg, [
      { phrase: "покраска стен", evidence: msg, canonicalKeys: ["wall_painting"] },
      { kind: "availability", phrase: "не работаю после 18:00", evidence: msg, constraintType: "availability", endHour: 18 },
    ]);
    expect(live(p2.facts).filter((f) => f.kind === "availability")).toEqual([]);
    expect((await decide(p2.facts, "Выкопать яму в 20:00", "digging", 20)).reason).not.toBe("outside_availability");
    const again = "Теперь снова не работаю после 18:00.";
    const p3 = await update({ sourceText: p2.sourceText, facts: p2.facts }, again,
      [{ kind: "availability", phrase: "не работаю после 18:00", evidence: again, constraintType: "availability", endHour: 18 }]);
    expect((await decide(p3.facts, "Выкопать яму в 20:00", "digging", 20)).reason).toBe("outside_availability");
  });

  it("D. restore by button returns the same item, no duplicate; matching effect comes back", async () => {
    const p1 = await first(START, startFacts);
    const { state, removed, identity } = revoke(p1, "capability", "копать");
    // Document similarity 0: the refreshed embedding no longer carries the removed skill (job profile_embedding_refresh).
    expect((await decide(p1.facts, "Нужно выкопать яму", "digging", null, 0)).matchType).not.toBeNull();
    const after = await decide(state.facts, "Нужно выкопать яму", "digging", null, 0);
    expect(after.matchType).toBeNull();
    expect(after.reason).not.toBe("explicit_exclusion");
    const back = restoreProfileItem(state.facts, identity, removed);
    const byPhrase = (a: { phrase: string }, b: { phrase: string }) => a.phrase.localeCompare(b.phrase);
    expect([...back.facts].sort(byPhrase)).toEqual([...p1.facts].sort(byPhrase));
    expect((await decide(back.facts, "Нужно выкопать яму", "digging", null, 0)).matchType).not.toBeNull();
  });
});

describe("effective review text (compound phrase)", () => {
  it("«Сверлю бетон и крашу стены» → remove drilling: raw history unchanged, review text has only the active item", async () => {
    const MSG = "Сверлю бетон и крашу стены.";
    const p1 = await first(MSG, [
      { phrase: "сверление бетона", evidence: MSG, canonicalKeys: [] },
      { phrase: "покраска стен", evidence: MSG, canonicalKeys: ["wall_painting"] },
    ]);
    const r = revokeProfileItem(p1.facts, { family: "capability", nodeIds: [], key: itemKey("сверление бетона") });
    expect(p1.sourceText).toBe(MSG);
    const review = reviewProfileText(p1.sourceText, r.facts);
    expect(review).not.toMatch(/Сверл|сверлен/);
    expect(review).toMatch(/покраска стен/);
    // Untouched profile → the text is byte-identical (cache HIT stays possible after restore).
    expect(reviewProfileText(p1.sourceText, p1.facts)).toBe(p1.sourceText);
  });
  it("a removed item with its own message disappears from the review text, other messages stay", async () => {
    const A = "Могу копать.", B = "Умею красить стены.";
    const p1 = await first([A, B].join(SEP), [
      { phrase: "копать", evidence: A, canonicalKeys: ["digging"] },
      { phrase: "покраска стен", evidence: B, canonicalKeys: ["wall_painting"] },
    ]);
    const r = revokeProfileItem(p1.facts, identityOf(p1.facts, "capability", "копать"));
    const review = reviewProfileText(p1.sourceText, r.facts);
    expect(review).not.toContain(A);
    expect(review).toContain(B);
  });
});

describe("rebuild/reprocess replay keeps the button decisions", () => {
  const A = "Могу копать. Есть машина.", B = "Умею красить стены.", C = "Снова могу копать.";
  const extracted = { segments: [] };
  const run = async (texts: string[], decisions: Parameters<typeof prepareProfileFromMessages>[3]) => {
    const spy = vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (input) => {
      const t = input.text;
      const facts = t.includes(C) ? [{ phrase: "копать", evidence: C, canonicalKeys: ["digging"] }]
        : t.includes(B) ? [{ phrase: "покраска стен", evidence: B, canonicalKeys: ["wall_painting"] }, { phrase: "копать", evidence: B, canonicalKeys: ["digging"] }]
          : [{ phrase: "копать", evidence: A, canonicalKeys: ["digging"] }, { kind: "resource", subjectType: "physical_resource", resourceRole: "available", phrase: "машина", evidence: A, canonicalKeys: ["car"] }];
      return { data: { facts: facts.map(fact) }, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 } as never;
    });
    try { return await prepareProfileFromMessages(texts, extracted, randomUUID(), decisions); } finally { spy.mockRestore(); }
  };
  const t = (m: number) => new Date(Date.UTC(2026, 9, 17, 10, m));
  it("scheduleDecisions: decision placed between messages by time; unknown times → after all", () => {
    const d = { decidedAt: t(5) } as never;
    expect(scheduleDecisions([d], [t(0), t(10)])[0]!.beforeIndex).toBe(1);
    expect(scheduleDecisions([d], [t(0), null])[0]!.beforeIndex).toBe(2);
  });
  it("revoke between A and B survives the replay; a later explicit message C restores", async () => {
    const base = await run([A], []);
    const identity = identityOf(base.facts, "capability", "копать");
    const decision = { action: "revoke", family: "capability", identity, snapshot: { facts: [] } } as const;
    const replay = await run([A, B], [{ beforeIndex: 1, decision: decision as never }]);
    expect(await skills(replay.facts)).not.toContain("digging");
    expect(resources(replay.facts)).toEqual(["машина"]);
    const restored = await run([A, B, C], [{ beforeIndex: 1, decision: decision as never }]);
    expect((await skills(restored.facts)).filter((k) => k === "digging")).toHaveLength(1);
  });
  it("applyDecision restore uses replay memory (no duplicate)", async () => {
    const base = await run([A], []);
    const identity = identityOf(base.facts, "resource", "машина");
    const memory = new Map();
    const gone = applyDecision(base.facts, { action: "revoke", family: "resource", identity, snapshot: { facts: [] } } as never, memory);
    expect(resources(gone)).toEqual([]);
    const back = applyDecision(gone, { action: "restore", family: "resource", identity, snapshot: { facts: [] } } as never, memory);
    expect(back).toEqual(base.facts);
  });
});

// ---- Аудит Codex (2026-10-17): regression tests ----
const D = "55555555-5555-5555-5555-555555555555", P = "66666666-6666-6666-6666-666666666666";
const pf = (o: Record<string, unknown>) => ({ ...fact({ evidence: "", nodeIds: [], embedding: [1, 0], label: null }), ...o }) as unknown as PreparedDocument["facts"][number];

describe("effective review text is built from the active structured state", () => {
  const nodeLabel = (id: string) => (id === P ? "Покраска стен" : id === D ? "Сверление бетона" : null);
  it("T1. composite capability phrase: the removed component's meaning is gone, the active one stays", () => {
    const MSG = "Сверлю бетон и крашу стены.";
    const facts = [pf({ phrase: "сверлю бетон и крашу стены", evidence: MSG, nodeIds: [D, P] })];
    const r = revokeProfileItem(facts, { family: "capability", nodeIds: [D], key: "" }, { nodeLabel });
    const review = reviewProfileText(MSG, r.facts);
    expect(review).not.toMatch(/сверл/i);
    expect(review).toMatch(/Покраска стен/);
  });
  it("T2. shared evidence capability + restriction: a lifted restriction is not in the review text", () => {
    const MSG = "Ремонтирую бытовую технику, не работаю после 18:00.";
    const facts = [pf({ phrase: "ремонт бытовой техники", evidence: MSG, nodeIds: [D] }),
      pf({ kind: "availability", phrase: "не работаю после 18:00", evidence: MSG, constraintType: "availability", endHour: 18 })];
    const lifted = liftRestrictionFacts(facts, (x) => x.kind === "availability");
    const review = reviewProfileText(MSG, lifted.facts);
    expect(review).not.toMatch(/18/);
    expect(review).toMatch(/ремонт бытовой техники/);
  });
  it("T3. resource + capability in one sentence: removing the resource keeps only the capability", () => {
    const MSG = "Есть газель, вожу грузы.";
    const facts = [pf({ kind: "resource", phrase: "газель", label: "Газель", evidence: MSG, nodeIds: [P], resourceRole: "available" }),
      pf({ phrase: "перевозка грузов", evidence: MSG, nodeIds: [D] })];
    const r = revokeProfileItem(facts, { family: "resource", nodeIds: [P], key: itemKey("Газель") });
    const review = reviewProfileText(MSG, r.facts);
    expect(review).not.toMatch(/газел/i);
    expect(review).toMatch(/перевозка грузов/);
  });
  it("T4. nothing removed: the raw text is kept byte for byte", () => {
    const MSG = "Есть газель, вожу грузы.";
    const facts = [pf({ kind: "resource", phrase: "газель", evidence: MSG, nodeIds: [P], resourceRole: "available" }), pf({ phrase: "перевозка грузов", evidence: MSG, nodeIds: [D] })];
    expect(reviewProfileText(MSG, facts)).toBe(MSG);
  });
  it("T5. everything in a message removed: no residue of it, other messages stay", () => {
    const A = "Есть газель, вожу грузы.", B = "Умею красить стены.";
    const facts = [pf({ kind: "resource", phrase: "газель", label: "Газель", evidence: A, nodeIds: [P], resourceRole: "available" }),
      pf({ phrase: "перевозка грузов", evidence: A, nodeIds: [D] }), pf({ phrase: "покраска стен", evidence: B, nodeIds: [] })];
    let state = revokeProfileItem(facts, { family: "resource", nodeIds: [P], key: itemKey("Газель") }).facts;
    state = revokeProfileItem(state, { family: "capability", nodeIds: [D], key: itemKey("перевозка грузов") }).facts;
    const review = reviewProfileText([A, B].join(SEP), state);
    expect(review).not.toMatch(/газел|груз/i);
    expect(review).toContain(B);
  });
});

describe("restriction decision identity is structural, not the AI wording", () => {
  const original = pf({ kind: "availability", phrase: "не работаю после 18:00", evidence: "Не работаю после 18:00.", constraintType: "availability", endHour: 18 });
  const decision = { action: "revoke", family: "restriction", identity: { kind: "restriction", facts: [{ phrase: original.phrase, evidence: original.evidence }] },
    snapshot: { facts: [original] } } as never;
  const live = (facts: PreparedDocument["facts"]) => facts.filter((x) => (x.kind as string) !== "superseded" && (x.kind === "availability" || x.endHour != null));
  it("RSTR1. replay rephrases it («вечером не работаю», endHour 18): it stays lifted", () => {
    const replay = [pf({ kind: "availability", phrase: "вечером не работаю", evidence: "Не работаю после 18:00.", constraintType: "availability", endHour: 18 })];
    expect(live(applyDecision(replay, decision, new Map()))).toEqual([]);
  });
  it("RSTR2. a different window (endHour 20) is not the same restriction", () => {
    const replay = [pf({ kind: "availability", phrase: "после 20 не работаю", evidence: "После 20 не работаю.", constraintType: "availability", endHour: 20 })];
    expect(live(applyDecision(replay, decision, new Map()))).toHaveLength(1);
  });
  it("RSTR3. same hours on a scoped activity is a different restriction", () => {
    const replay = [pf({ kind: "availability", phrase: "вечером не работаю", evidence: "Не работаю после 18:00.", constraintType: "availability", endHour: 18 }),
      pf({ phrase: "доставка", evidence: "Доставка до 18:00.", nodeIds: [D], endHour: 18 })];
    const after = applyDecision(replay, decision, new Map());
    expect(live(after).map((x) => x.phrase)).toEqual(["доставка"]);
  });
  it("RSTR4. an explicit new message restores only the intended restriction", async () => {
    const W18 = "Не работаю после 18:00.", W20 = "По выходным не работаю после 20:00.";
    const p1 = await first([START, W18, W20].join(SEP), [...startFacts,
      { kind: "availability", phrase: "не работаю после 18:00", evidence: W18, constraintType: "availability", endHour: 18 },
      { kind: "availability", phrase: "по выходным не работаю после 20:00", evidence: W20, constraintType: "availability", endHour: 20, daysOfWeek: [5, 6] }]);
    let facts = applyDecision(p1.facts, decision, new Map());
    facts = applyDecision(facts, { ...(decision as object), snapshot: { facts: [p1.facts.find((x) => x.endHour === 20)] } } as never, new Map());
    expect(live(facts)).toEqual([]);
    const again = "Снова не работаю после 18:00.";
    const p2 = await update({ sourceText: p1.sourceText, facts }, again,
      [{ kind: "availability", phrase: "снова не работаю после 18:00", evidence: again, constraintType: "availability", endHour: 18 }]);
    expect(live(p2.facts).map((x) => x.endHour)).toEqual([18]);
  });
});

// ---- Аудит Codex №2 (2026-10-17) ----
describe("effective text after a restriction is lifted reflects the current structured state", () => {
  const nodeLabel = (id: string) => (id === D ? "Доставка посылок" : id === P ? "Покраска стен" : null);
  it("T1. «доставка посылок до 22:00» → lift the hours: review text has no 22:00, the skill stays", () => {
    const MSG = "Доставка посылок до 22:00.";
    const facts = [pf({ phrase: "доставка посылок до 22:00", evidence: MSG, nodeIds: [D], endHour: 22 })];
    const lifted = liftRestrictionFacts(facts, () => true, { nodeLabel });
    const review = reviewProfileText(MSG, lifted.facts);
    expect(review).not.toMatch(/22/);
    expect(review).toMatch(/доставка посылок/i);
    expect(lifted.facts.find((x) => x.kind === "capability")).toMatchObject({ evidence: MSG, endHour: null });
  });
  it("T2. «работаю только по будням» → lift the days: review text has no «по будням»", () => {
    const MSG = "Работаю только по будням.";
    const facts = [pf({ kind: "availability", phrase: "работаю только по будням", evidence: MSG, constraintType: "availability", daysOfWeek: [0, 1, 2, 3, 4] })];
    expect(reviewProfileText(MSG, liftRestrictionFacts(facts, () => true, { nodeLabel }).facts)).not.toMatch(/будн/);
  });
  it("T3. capability + scoped restriction in one phrase: restriction lifted, capability remains without it", () => {
    const MSG = "Крашу стены только по выходным.";
    const facts = [pf({ phrase: "покраска стен только по выходным", evidence: MSG, nodeIds: [P], daysOfWeek: [5, 6] })];
    const lifted = liftRestrictionFacts(facts, () => true, { nodeLabel });
    const review = reviewProfileText(MSG, lifted.facts);
    expect(review).not.toMatch(/выходн/);
    expect(review).toMatch(/Покраска стен/);
    expect(lifted.facts.filter((x) => x.kind === "capability")).toHaveLength(1);
  });
  it("T4/T5. unchanged item keeps its representation; raw history and evidence are untouched", () => {
    const MSG = "Доставка посылок до 22:00. Крашу стены.";
    const keep = pf({ phrase: "покраска стен", evidence: "Крашу стены.", nodeIds: [P] });
    const facts = [pf({ phrase: "доставка посылок до 22:00", evidence: "Доставка посылок до 22:00.", nodeIds: [D], endHour: 22 }), keep];
    const lifted = liftRestrictionFacts(facts, (x) => x.endHour === 22, { nodeLabel });
    expect(lifted.facts).toContain(keep);
    expect(reviewProfileText(MSG, facts)).toBe(MSG);
    expect(lifted.facts.every((x) => x.evidence === "Доставка посылок до 22:00." || x === keep)).toBe(true);
  });
});

describe("journal replay order is a deterministic total order", () => {
  it("same item, same timestamp: revoke → restore → the last event wins regardless of physical row order", async () => {
    const db = getDb();
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
    try {
      const at = new Date("2026-10-17T00:00:00Z");
      const identity = { family: "resource", nodeIds: [P], key: itemKey("Газель") };
      // Physical insertion order is the opposite of the event order (seq): the replay must follow seq.
      await db.insert(schema.profileItemDecisions).values({ userId: u!.id, action: "restore", family: "resource", identity, snapshot: { facts: [] }, profileVersion: 3, decidedAt: at, seq: 1_000_000_002 });
      await db.insert(schema.profileItemDecisions).values({ userId: u!.id, action: "revoke", family: "resource", identity, snapshot: { facts: [] }, profileVersion: 2, decidedAt: at, seq: 1_000_000_001 });
      const order = (await loadDecisions(db, u!.id)).map((d) => d.action);
      expect(order).toEqual(["revoke", "restore"]);
    } finally { await db.delete(schema.users).where(eq(schema.users.id, u!.id)); }
  });
});

// ---- Аудит Codex №3 (2026-10-17): навык без узла онтологии ----
describe("no-ontology capability: effective text after a lifted restriction", () => {
  const lift = (facts: PreparedDocument["facts"]) => liftRestrictionFacts(facts, () => true, { nodeLabel: () => null });
  it("N1. atomic label: «доставляю документы до 22:00» → hours lifted → review shows the label, not 22:00", () => {
    const MSG = "Доставляю документы до 22:00.";
    const r = lift([pf({ phrase: "доставляю документы до 22:00", label: "Доставка документов", evidence: MSG, endHour: 22 })]);
    const review = reviewProfileText(MSG, r.facts);
    expect(review).toBe("Могу выполнять: Доставка документов.");
  });
  it("N2. days lifted: no weekday meaning remains", () => {
    const MSG = "Доставляю документы по будням.";
    const r = lift([pf({ phrase: "доставляю документы по будням", label: "Доставка документов", evidence: MSG, daysOfWeek: [0, 1, 2, 3, 4] })]);
    expect(reviewProfileText(MSG, r.facts)).not.toMatch(/будн/);
    expect(reviewProfileText(MSG, r.facts)).toMatch(/Доставка документов/);
  });
  it("N3. scoped restriction on a no-node skill: the skill remains, the restriction meaning is gone", () => {
    const MSG = "Мою окна только утром.";
    const r = lift([pf({ phrase: "мою окна только утром", label: "Мытьё окон", evidence: MSG, startHour: 6, endHour: 12 })]);
    expect(r.facts.filter((x) => x.kind === "capability")).toHaveLength(1);
    expect(reviewProfileText(MSG, r.facts)).toBe("Могу выполнять: Мытьё окон.");
  });
  it("N4. composite sentence of atomic items: only the active components appear", () => {
    const MSG = "Доставляю документы до 22:00 и мою окна.";
    const r = liftRestrictionFacts([pf({ phrase: "доставляю документы до 22:00", label: "Доставка документов", evidence: MSG, endHour: 22 }),
      pf({ phrase: "мою окна", label: "Мытьё окон", evidence: MSG })], (x) => x.endHour === 22, { nodeLabel: () => null });
    expect(reviewProfileText(MSG, r.facts)).toBe("Могу выполнять: Доставка документов.\nМогу выполнять: Мытьё окон.");
  });
  it("N5. legacy no-node skill without a label: the stale phrase is omitted (fail-safe), never shown as current", () => {
    const MSG = "Доставляю документы до 22:00. Мою окна.";
    const r = lift([pf({ phrase: "доставляю документы до 22:00", evidence: "Доставляю документы до 22:00.", endHour: 22 })]);
    const review = reviewProfileText(MSG, [...r.facts, pf({ phrase: "мою окна", evidence: "Мою окна." })]);
    expect(review).not.toMatch(/22/);
    expect(r.facts.filter((x) => x.kind === "capability")).toHaveLength(1); // still an active skill for matching
  });
  it("N6. raw evidence is unchanged", () => {
    const MSG = "Доставляю документы до 22:00.";
    const r = lift([pf({ phrase: "доставляю документы до 22:00", label: "Доставка документов", evidence: MSG, endHour: 22 })]);
    expect(r.facts.every((x) => x.evidence === MSG)).toBe(true);
  });
});

// ---- Live E2E (2026-10-17): навык с часами в реальной форме (capability + availability/fact) ----
describe("lifting the hours of a skill in its real normalized shape", () => {
  it("the skill stays active, review text drops «до 22:00», raw evidence unchanged, vector reset for refresh", () => {
    const MSG = "Настраиваю умные колонки до 22:00.";
    const skill = pf({ phrase: "настройка умных колонок", label: "Настройка умных колонок", evidence: MSG, nodeIds: [D],
      constraintType: "availability", constraintScope: "fact", endHour: 22 });
    const r = liftRestrictionFacts([skill], () => true, { nodeLabel: () => "Настройка умных колонок" });
    const active = r.facts.filter((x) => x.kind === "capability");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ constraintType: "none", endHour: null, evidence: MSG, embedding: null });
    expect(reviewProfileText(MSG, r.facts)).toBe("Могу выполнять: Настройка умных колонок.");
  });
});
