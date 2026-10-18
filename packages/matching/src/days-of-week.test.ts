import { describe, expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "./index.js";

/**
 * Дни недели (2026-10-17): контракт matching — daysOfWeek = РАЗРЕШЁННЫЕ дни (0=пн..6=вс). Нормализация уже приводит
 * «не работаю по воскресеньям» к [0..5] (resolveDaysOfWeek, @ustal/ai). Глобальное окно ограничивает всю работу,
 * окно деятельности (availability/fact или отказ с днями) — только эту деятельность.
 */
const DIG = "11111111-1111-1111-1111-111111111111", PAINT = "22222222-2222-2222-2222-222222222222";
const f = (o: Partial<Fact>): Fact => ({ kind: "capability", phrase: "", nodeIds: [], embedding: null, mandatory: false, confidence: 0.95,
  constraintType: "none", constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, ...o } as Fact);
const dig = f({ phrase: "копка", nodeIds: [DIG] }), paint = f({ phrase: "покраска", nodeIds: [PAINT] });
const decide = (profile: Fact[], node: string, day: number) =>
  evaluateSemantic({ capabilities: profile, requirements: [f({ phrase: "заказ", nodeIds: [node] })], relations: [], documentSimilarity: 0, riskLevel: 0, regulated: false, localWeekday: day }).reason;
const BLOCK = "outside_availability";

describe("day-of-week restrictions in matching (allowed days)", () => {
  it("global: «Не работаю по воскресеньям» → [0..5]: Sunday blocked, Monday–Saturday open", () => {
    const profile = [dig, f({ kind: "availability", constraintType: "availability", phrase: "Не работаю по воскресеньям", daysOfWeek: [0, 1, 2, 3, 4, 5] })];
    expect(decide(profile, DIG, 6)).toBe(BLOCK);
    for (const d of [0, 1, 2, 3, 4, 5]) expect(decide(profile, DIG, d)).not.toBe(BLOCK);
  });
  it("scoped availability: «Не копаю по воскресеньям» → [0..5] limits only digging", () => {
    const profile = [dig, paint, f({ kind: "availability", constraintType: "availability", constraintScope: "fact", phrase: "копка", nodeIds: [DIG], daysOfWeek: [0, 1, 2, 3, 4, 5] })];
    expect(decide(profile, DIG, 6)).toBe(BLOCK);
    expect(decide(profile, DIG, 2)).not.toBe(BLOCK);
    expect(decide(profile, PAINT, 6)).not.toBe(BLOCK);
  });
  it("a refusal with days (kind=exclude) is an activity window, not a total refusal and not a global calendar", () => {
    const profile = [dig, paint, f({ kind: "exclude", constraintType: "exclusion", phrase: "копка", nodeIds: [DIG], daysOfWeek: [0, 1, 2, 3, 4, 5] })];
    expect(decide(profile, DIG, 6)).toBe(BLOCK);
    expect(decide(profile, DIG, 1)).not.toBe("explicit_exclusion");
    expect(decide(profile, DIG, 1)).not.toBe(BLOCK);
    expect(decide(profile, PAINT, 6)).not.toBe(BLOCK);
  });
  it("no day restriction (null) never blocks", () => {
    expect(decide([dig, f({ kind: "availability", constraintType: "availability", phrase: "Могу работать по воскресеньям", daysOfWeek: null })], DIG, 1)).not.toBe(BLOCK);
  });
});
