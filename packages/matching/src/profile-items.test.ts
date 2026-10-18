import { describe, expect, it } from "vitest";
import {
  evaluateSemantic, isUserRemovedMarker, itemKey, liftedMarkerSignature, liftRestrictionFacts, markerSignatureOf, restrictionSignature, restoreProfileItem, restoreRestrictionFacts, revokeProfileItem,
  userRemovedFamily, type ItemFact,
} from "./index.js";

// Direct revoke/restore пунктов профиля без AI (2026-10-17): чистая логика маркеров.
const DRILL = "11111111-1111-1111-1111-111111111111", PAINT = "22222222-2222-2222-2222-222222222222", TOOL = "33333333-3333-3333-3333-333333333333";
const f = (o: Partial<ItemFact>): ItemFact => ({ kind: "capability", phrase: "", evidence: "", nodeIds: [], embedding: [1, 0], mandatory: false, confidence: 0.95,
  constraintType: "none", constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, ...o });
const drill = f({ phrase: "сверление бетона", evidence: "Сверлю бетон и крашу стены", nodeIds: [DRILL] });
const paint = f({ phrase: "покраска стен", evidence: "Сверлю бетон и крашу стены", nodeIds: [PAINT], embedding: [0, 1] });
const tool = f({ kind: "resource", phrase: "дрель", evidence: "Есть дрель", nodeIds: [TOOL], resourceRole: "available" });
const unknown = f({ phrase: "нейромассаж", label: "Нейромассаж", evidence: "Делаю нейромассаж" });
const evening = f({ kind: "availability", phrase: "не работаю вечером", evidence: "Не работаю после 18", constraintType: "availability", endHour: 18 });
const skillHours = f({ phrase: "доставка", evidence: "Доставка до 22:00", nodeIds: [PAINT], endHour: 22 });

describe("revokeProfileItem / restoreProfileItem", () => {
  it("revoke by ontology node: the item becomes a neutral inert marker — not a refusal, not a restriction", () => {
    const r = revokeProfileItem([drill, paint, tool], { family: "capability", nodeIds: [DRILL], key: "сверление бетона" });
    expect(r.removed).toEqual([drill]);
    const marker = r.facts.find(isUserRemovedMarker)!;
    expect(marker).toMatchObject({ kind: "superseded", constraintType: "none", phrase: "сверление бетона", nodeIds: [DRILL] });
    expect(userRemovedFamily(marker)).toBe("capability");
    expect(r.facts).toContain(paint);
    expect(r.facts.some((x) => x.kind === "exclude" || x.constraintType === "exclusion")).toBe(false);
    // Matching: the marker neither supports nor blocks a drilling order.
    const order = f({ phrase: "просверлить стену", nodeIds: [DRILL] });
    const after = evaluateSemantic({ capabilities: r.facts, requirements: [order], relations: [], documentSimilarity: 0, riskLevel: 0, regulated: false });
    expect(after.matchType).toBeNull();
    expect(after.reason).not.toMatch(/exclu|refus/);
    const before = evaluateSemantic({ capabilities: [drill, paint], requirements: [order], relations: [], documentSimilarity: 0, riskLevel: 0, regulated: false });
    expect(before.matchType).not.toBeNull();
  });
  it("revoke is idempotent: an already removed item has nothing to remove", () => {
    const once = revokeProfileItem([drill, paint], { family: "capability", nodeIds: [DRILL], key: "" });
    const twice = revokeProfileItem(once.facts, { family: "capability", nodeIds: [DRILL], key: "" });
    expect(twice.removed).toEqual([]);
    expect(twice.facts).toEqual(once.facts);
  });
  it("a fact on several nodes keeps its other nodes; restore returns the original fact without duplicates", () => {
    const both = f({ phrase: "ремонт", evidence: "Ремонт: сверление и покраска", nodeIds: [DRILL, PAINT] });
    const r = revokeProfileItem([both], { family: "capability", nodeIds: [DRILL], key: "" });
    expect(r.facts.filter((x) => x.kind === "capability").map((x) => x.nodeIds)).toEqual([[PAINT]]);
    const back = restoreProfileItem(r.facts, { family: "capability", nodeIds: [DRILL], key: "" }, r.removed);
    expect(back.facts).toEqual([both]);
  });
  it("unknown item (no node) by normalized label; resources; restore when re-added by a message → no duplicate", () => {
    const r = revokeProfileItem([unknown, tool], { family: "capability", nodeIds: [], key: "нейромассаж" });
    expect(r.removed).toEqual([unknown]);
    const res = revokeProfileItem([tool], { family: "resource", nodeIds: [TOOL], key: "" });
    expect(res.facts.every((x) => x.kind === "superseded")).toBe(true);
    const readded = f({ kind: "resource", phrase: "дрель", evidence: "Купил новую дрель", nodeIds: [TOOL], resourceRole: "available" });
    const restored = restoreProfileItem([...res.facts, readded], { family: "resource", nodeIds: [TOOL], key: "" }, res.removed);
    expect(restored.facts).toEqual([readded]);
  });
});

describe("liftRestrictionFacts / restoreRestrictionFacts", () => {
  it("lift: the same lifted:<area> history marker as a lift by message; restore puts the original back", () => {
    const r = liftRestrictionFacts([drill, evening], (x) => x === evening);
    expect(r.removed).toEqual([evening]);
    expect(r.facts.find((x) => x.kind === "superseded")?.resourceCapacity?.kind).toBe("lifted:time_global");
    const order = f({ phrase: "просверлить стену", nodeIds: [DRILL], startHour: 20, constraintScope: "whole_task" });
    const lifted = evaluateSemantic({ capabilities: r.facts, requirements: [order], relations: [], documentSimilarity: 0, riskLevel: 0, regulated: false });
    expect(lifted.reason).not.toBe("outside_availability");
    const blocked = evaluateSemantic({ capabilities: [drill, evening], requirements: [order], relations: [], documentSimilarity: 0, riskLevel: 0, regulated: false });
    expect(blocked.reason).toBe("outside_availability");
    const back = restoreRestrictionFacts(r.facts, r.removed);
    expect(back.facts).toEqual([drill, evening]);
    expect(restoreRestrictionFacts(back.facts, r.removed).changed).toBe(false);
  });
  it("hours on a skill: the hours are lifted, the skill stays", () => {
    const r = liftRestrictionFacts([skillHours], (x) => x === skillHours);
    // No label and no ontology names available here: the skill stays active but its phrase is not used as current
    // review text (fail-safe marker; audit №3). With a label or node names it gets a clean canonical name instead.
    expect(r.facts.filter((x) => x.kind === "capability")).toEqual([{ ...skillHours, endHour: null, startHour: null, daysOfWeek: null,
      attributes: [{ key: "effective_text_unavailable", value: "1", unit: null }] }]);
    expect(restoreRestrictionFacts(r.facts, r.removed).facts).toEqual([skillHours]);
  });
});

// ---- Аудит Codex (2026-10-17): regression tests ----
const CAR = "44444444-4444-4444-4444-444444444444", D = "55555555-5555-5555-5555-555555555555", P = "66666666-6666-6666-6666-666666666666";
const res = (label: string, nodeIds: string[], evidence = "Есть легковая и грузовая машина") =>
  f({ kind: "resource", phrase: label.toLowerCase(), label, evidence, nodeIds, resourceRole: "available" });
const active = (facts: ItemFact[]) => facts.filter((x) => x.kind !== "superseded");
const sortNodes = (facts: ItemFact[]) => active(facts).map((x) => `${x.kind}:${x.label ?? x.phrase}:${[...x.nodeIds].sort().join("+")}`).sort();

describe("R. resource identity: a shared ontology node is not the identity of a resource", () => {
  it("R1. two resources on one node: revoke A keeps B; restore A leaves B untouched", () => {
    const a = res("Легковая машина", [CAR]), b = res("Грузовая машина", [CAR]);
    const r = revokeProfileItem([a, b], { family: "resource", nodeIds: [CAR], key: itemKey("Легковая машина") });
    expect(r.removed).toEqual([a]);
    expect(active(r.facts)).toEqual([b]);
    const back = restoreProfileItem(r.facts, { family: "resource", nodeIds: [CAR], key: itemKey("Легковая машина") }, r.removed);
    expect(sortNodes(back.facts)).toEqual(sortNodes([a, b]));
    expect(active(back.facts).filter((x) => x.label === "Грузовая машина")).toEqual([b]);
  });
  it("R2. unknown resources (no node) are independent by their own identity", () => {
    const a = res("Бетономешалка", []), b = res("Виброплита", []);
    const r = revokeProfileItem([a, b], { family: "resource", nodeIds: [], key: itemKey("Бетономешалка") });
    expect(active(r.facts)).toEqual([b]);
    expect(restoreProfileItem(r.facts, { family: "resource", nodeIds: [], key: itemKey("Бетономешалка") }, r.removed).facts.filter((x) => x.kind !== "superseded")).toHaveLength(2);
  });
});

describe("C. composite fact: restore brings back only the selected component", () => {
  const both = () => f({ phrase: "сверление и покраска", evidence: "Сверлю бетон и крашу стены", nodeIds: [D, P] });
  const idD = { family: "capability" as const, nodeIds: [D], key: "" }, idP = { family: "capability" as const, nodeIds: [P], key: "" };
  it("C1. [D,P] → revoke D → revoke P → restore D: only D active", () => {
    const r1 = revokeProfileItem([both()], idD);
    const r2 = revokeProfileItem(r1.facts, idP);
    expect(active(r2.facts)).toEqual([]);
    const back = restoreProfileItem(r2.facts, idD, r1.removed);
    expect(active(back.facts).flatMap((x) => x.nodeIds)).toEqual([D]);
  });
  it("C2. then restore P: D and P active once, no duplicates; C3. repeated restore D is a no-op", () => {
    const r1 = revokeProfileItem([both()], idD);
    const r2 = revokeProfileItem(r1.facts, idP);
    const d = restoreProfileItem(r2.facts, idD, r1.removed);
    const p = restoreProfileItem(d.facts, idP, r2.removed);
    // Each component active exactly once (no duplicate of D or P).
    expect(active(p.facts).flatMap((x) => x.nodeIds).sort()).toEqual([D, P].sort());
    const again = restoreProfileItem(p.facts, idD, r1.removed);
    expect(again.changed).toBe(false);
    expect(again.facts).toEqual(p.facts);
  });
  it("C5. revoke D → restore D: the original composite fact comes back exactly (one fact, its own vector)", () => {
    const o = both();
    const r = revokeProfileItem([o], idD, { nodeLabel: (n) => (n === P ? "Покраска стен" : "Сверление бетона") });
    expect(active(r.facts)).toMatchObject([{ nodeIds: [P], label: "Покраска стен", embedding: null }]);
    const back = restoreProfileItem(r.facts, idD, r.removed);
    expect(back.facts).toEqual([o]);
  });
  it("C4. the same for a composite resource", () => {
    const pair = f({ kind: "resource", phrase: "дрель и перфоратор", evidence: "Есть дрель и перфоратор", nodeIds: [D, P], resourceRole: "available" });
    const r1 = revokeProfileItem([pair], { ...idD, family: "resource" });
    const r2 = revokeProfileItem(r1.facts, { ...idP, family: "resource" });
    const back = restoreProfileItem(r2.facts, { ...idD, family: "resource" }, r1.removed);
    expect(active(back.facts).flatMap((x) => x.nodeIds)).toEqual([D]);
  });
});

describe("RSTR. restriction identity is structural", () => {
  const avail = (o: Partial<ItemFact>) => f({ kind: "availability", constraintType: "availability", ...o });
  it("same window, different wording → same identity; other hours, days or scope → different", () => {
    const a = restrictionSignature(avail({ phrase: "не работаю после 18:00", evidence: "Не работаю после 18:00", endHour: 18 }));
    expect(restrictionSignature(avail({ phrase: "вечером не работаю", evidence: "Вечером не работаю", endHour: 18 }))).toBe(a);
    expect(restrictionSignature(avail({ phrase: "после 20 не работаю", endHour: 20 }))).not.toBe(a);
    expect(restrictionSignature(avail({ phrase: "по выходным до 18", endHour: 18, daysOfWeek: [5, 6] }))).not.toBe(a);
    expect(restrictionSignature(f({ phrase: "доставка", nodeIds: [D], endHour: 18 }))).not.toBe(a);
    expect(restrictionSignature(f({ phrase: "доставка", nodeIds: [D], endHour: 18 }))).not.toBe(restrictionSignature(f({ phrase: "покраска", nodeIds: [P], endHour: 18 })));
    expect(restrictionSignature(f({ phrase: "покраска", nodeIds: [P] }))).toBeNull();
  });
  it("a lifted marker finds its original by structure, not wording", () => {
    const o = avail({ phrase: "не работаю после 18:00", endHour: 18 });
    const lifted = liftRestrictionFacts([avail({ phrase: "вечером не работаю", endHour: 18 })], () => true).facts[0]!;
    expect(liftedMarkerSignature(lifted)).toBe(markerSignatureOf(o));
    expect(liftedMarkerSignature(lifted)).not.toBe(markerSignatureOf(avail({ phrase: "x", endHour: 20 })));
  });
});

// ---- Аудит Codex №2 (2026-10-17) ----
const vec = (...xs: number[]) => xs;
describe("AMB. vector fallback for a reworded item is fail-safe (unique match only)", () => {
  const A = (e: number[]) => res("Легковая машина", [CAR]), B = (e: number[]) => res("Грузовая машина", [CAR]);
  const withVec = (x: ItemFact, e: number[]) => ({ ...x, embedding: e });
  const reworded = (e: number[], nodeIds = [CAR]) => ({ family: "resource" as const, nodeIds, key: itemKey("Легковой автомобиль"), embedding: e });
  it("R1. same node, different labels, equal vectors → no candidate", () => {
    const facts = [withVec(A([]), vec(1, 0)), withVec(B([]), vec(1, 0))];
    expect(revokeProfileItem(facts, reworded(vec(1, 0))).removed).toEqual([]);
  });
  it("R2. very close vectors → ambiguous → no action", () => {
    const facts = [withVec(A([]), vec(1, 0.05)), withVec(B([]), vec(1, 0.12))];
    expect(revokeProfileItem(facts, reworded(vec(1, 0))).removed).toEqual([]);
  });
  it("R3. a clear unique best match is selected", () => {
    const a = withVec(A([]), vec(1, 0.1)), b = withVec(B([]), vec(0, 1));
    expect(revokeProfileItem([a, b], reworded(vec(1, 0))).removed).toEqual([a]);
  });
  it("R4. an exact label match wins over the vector fallback", () => {
    const a = withVec(A([]), vec(1, 0)), b = withVec(B([]), vec(0, 1));
    expect(revokeProfileItem([a, b], { family: "resource", nodeIds: [CAR], key: itemKey("Грузовая машина"), embedding: vec(1, 0) }).removed).toEqual([b]);
  });
  it("R5. unknown (no-node) resources are fail-safe too", () => {
    const facts = [withVec(res("Бетономешалка", []), vec(1, 0)), withVec(res("Растворомешалка", []), vec(1, 0.02))];
    expect(revokeProfileItem(facts, reworded(vec(1, 0), [])).removed).toEqual([]);
  });
  it("ambiguity is reported (controlled), not silently resolved", () => {
    const seen: number[] = [];
    revokeProfileItem([withVec(A([]), vec(1, 0)), withVec(B([]), vec(1, 0))], reworded(vec(1, 0)), { onAmbiguous: (n) => seen.push(n) });
    expect(seen).toEqual([2]);
  });
});

describe("S. one full canonical restriction identity everywhere (marker included)", () => {
  const win = (o: Partial<ItemFact>) => f({ kind: "availability", constraintType: "availability", ...o });
  const markerOf = (x: ItemFact) => liftRestrictionFacts([x], () => true).facts.find((m) => m.kind === "superseded")!;
  const weekdays = win({ phrase: "будни 09–18", startHour: 9, endHour: 18, daysOfWeek: [4, 0, 1, 2, 3] });
  const weekends = win({ phrase: "выходные 12–18", startHour: 12, endHour: 18, daysOfWeek: [6, 5] });
  it("S1–S4. different windows/days/scope never share a marker identity", () => {
    expect(liftedMarkerSignature(markerOf(weekdays))).not.toBe(markerSignatureOf(weekends));
    expect(liftedMarkerSignature(markerOf(win({ startHour: 9, endHour: 18 })))).not.toBe(markerSignatureOf(win({ startHour: 12, endHour: 18 })));
    expect(liftedMarkerSignature(markerOf(win({ endHour: 18, daysOfWeek: [0] })))).not.toBe(markerSignatureOf(win({ endHour: 18, daysOfWeek: [1] })));
    expect(liftedMarkerSignature(markerOf(f({ phrase: "доставка", nodeIds: [D], endHour: 18 })))).not.toBe(markerSignatureOf(f({ phrase: "покраска", nodeIds: [P], endHour: 18 })));
    expect(restrictionSignature(win({ endHour: 18 }))).not.toBe(restrictionSignature(win({ endHour: 18, startHour: 0 })));
  });
  it("S5. same restriction, other wording and day order → same identity", () => {
    expect(liftedMarkerSignature(markerOf(weekdays))).toBe(markerSignatureOf(win({ phrase: "по будням с 9 до 18", startHour: 9, endHour: 18, daysOfWeek: [0, 1, 2, 3, 4] })));
  });
  it("S6. restoring one lifted window leaves the other lifted", () => {
    const lifted = liftRestrictionFacts([weekends, weekdays], () => true);
    const back = restoreRestrictionFacts(lifted.facts, [weekdays]);
    expect(back.facts.filter((x) => x.kind !== "superseded")).toEqual([weekdays]);
    expect(back.facts.filter((x) => x.kind === "superseded")).toHaveLength(1);
    expect(liftedMarkerSignature(back.facts.find((x) => x.kind === "superseded")!)).toBe(markerSignatureOf(weekends));
  });
});

describe("S (audit №3). the restriction signature covers every matching-relevant field", () => {
  const ex = (o: Partial<ItemFact>) => f({ kind: "exclude", constraintType: "exclusion", phrase: "копать", nodeIds: [D], ...o });
  const win = (o: Partial<ItemFact>) => f({ kind: "availability", constraintType: "availability", ...o });
  it("S1. constraintScope whole_task vs optional_component vs fact → different", () => {
    const sigs = ["whole_task", "optional_component", "fact"].map((s) => restrictionSignature(ex({ constraintScope: s as never })));
    expect(new Set(sigs).size).toBe(3);
  });
  it("S2–S4. hours, days, target → different", () => {
    expect(restrictionSignature(win({ startHour: 9, endHour: 18 }))).not.toBe(restrictionSignature(win({ startHour: 10, endHour: 18 })));
    expect(restrictionSignature(win({ endHour: 18, daysOfWeek: [0] }))).not.toBe(restrictionSignature(win({ endHour: 18, daysOfWeek: [6] })));
    expect(restrictionSignature(ex({}))).not.toBe(restrictionSignature(ex({ nodeIds: [P] })));
    expect(restrictionSignature(ex({ nodeIds: [], phrase: "копать" }))).not.toBe(restrictionSignature(ex({ nodeIds: [], phrase: "красить" })));
  });
  it("kind/constraintType are part of identity (refusal vs «only» vs window)", () => {
    expect(restrictionSignature(ex({}))).not.toBe(restrictionSignature(f({ phrase: "копать", nodeIds: [D], constraintType: "scope" })));
  });
  it("S5. same structure, different phrase/evidence → same", () => {
    expect(restrictionSignature(ex({ phrase: "не копаю", evidence: "Не копаю." }))).toBe(restrictionSignature(ex({ phrase: "копку не беру", evidence: "Копку не беру." })));
  });
  it("S6. absent vs empty per matching semantics: no scope ≡ whole_task (refusals), days null ≡ [] ; day order irrelevant", () => {
    expect(restrictionSignature(ex({ constraintScope: undefined }))).toBe(restrictionSignature(ex({ constraintScope: "whole_task" })));
    expect(restrictionSignature(win({ endHour: 18, daysOfWeek: null }))).toBe(restrictionSignature(win({ endHour: 18, daysOfWeek: [] })));
    expect(restrictionSignature(win({ endHour: 18, daysOfWeek: [3, 1] }))).toBe(restrictionSignature(win({ endHour: 18, daysOfWeek: [1, 3] })));
    expect(restrictionSignature(win({ endHour: 18 }))).not.toBe(restrictionSignature(win({ endHour: 18, startHour: 0 })));
  });
  it("S7. restoring one restriction leaves another with the same data but another scope lifted", () => {
    const a = ex({ constraintScope: "whole_task" }), b = ex({ constraintScope: "optional_component", evidence: "x" });
    const lifted = liftRestrictionFacts([b, a], () => true);
    const back = restoreRestrictionFacts(lifted.facts, [a]);
    expect(back.facts.filter((x) => x.kind !== "superseded")).toEqual([a]);
    expect(liftedMarkerSignature(back.facts.find((x) => x.kind === "superseded")!)).toBe(markerSignatureOf(b));
  });
});

// ---- Live E2E (2026-10-17): навык с часами в реальной форме нормализации ----
describe("lift: a skill with its own hours (real shape: capability + constraintType=availability + scope=fact)", () => {
  const SK = "77777777-7777-7777-7777-777777777777";
  const skill = (o: Partial<ItemFact>) => f({ phrase: "настройка умных колонок", label: "Настройка умных колонок", evidence: "Настраиваю умные колонки до 22:00.",
    nodeIds: [SK], constraintType: "availability", constraintScope: "fact", ...o });
  const lift = (x: ItemFact) => liftRestrictionFacts([x], () => true, { nodeLabel: () => "Настройка умных колонок" });
  const activeSkills = (facts: ItemFact[]) => facts.filter((x) => x.kind === "capability");
  const markers = (facts: ItemFact[]) => facts.filter((x) => x.kind === "superseded");
  for (const [name, o] of [["A endHour", { endHour: 22 }], ["B start+end", { startHour: 9, endHour: 22 }], ["C days", { daysOfWeek: [0, 1, 2, 3, 4] }],
    ["D hours+days", { startHour: 9, endHour: 18, daysOfWeek: [5, 6] }]] as [string, Partial<ItemFact>][]) {
    it(`${name}: the skill stays, only the constraint is lifted (plain skill, one marker, no duplicate)`, () => {
      const r = lift(skill(o));
      expect(activeSkills(r.facts)).toHaveLength(1);
      expect(activeSkills(r.facts)[0]).toMatchObject({ label: "Настройка умных колонок", nodeIds: [SK], constraintType: "none", startHour: null, endHour: null, daysOfWeek: null });
      expect(restrictionSignature(activeSkills(r.facts)[0]!)).toBeNull(); // no longer a restriction
      expect(markers(r.facts)).toHaveLength(1);
      expect(liftedMarkerSignature(markers(r.facts)[0]!)).toBe(markerSignatureOf(skill(o)));
    });
  }
  it("E. scoped availability window (kind=availability, scope=fact) → only the constraint, no skill is invented", () => {
    const r = lift(f({ kind: "availability", constraintType: "availability", constraintScope: "fact", phrase: "доставка до 22", nodeIds: [SK], endHour: 22 }));
    expect(activeSkills(r.facts)).toEqual([]);
    expect(markers(r.facts)).toHaveLength(1);
  });
  it("F. pure refusal never becomes a skill", () => {
    const r = lift(f({ kind: "exclude", constraintType: "exclusion", phrase: "копать", nodeIds: [SK] }));
    expect(activeSkills(r.facts)).toEqual([]);
  });
  it("G. «only …» keeps its existing semantics (the lifted «only» is not a skill)", () => {
    const r = lift(f({ phrase: "только iOS", nodeIds: [SK], constraintType: "scope" }));
    expect(activeSkills(r.facts)).toEqual([]);
    expect(markers(r.facts)).toHaveLength(1);
  });
  it("H. restore returns the constraint to the same skill without a duplicate", () => {
    const o = skill({ endHour: 22 });
    const r = lift(o);
    const back = restoreRestrictionFacts(r.facts, r.removed);
    expect(back.facts).toEqual([o]);
  });
});
