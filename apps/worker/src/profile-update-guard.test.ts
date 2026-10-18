import { describe, expect, it } from "vitest";
import { guardProfileUpdate, hoursGrounded, isNoiseMessage, namedIn, type Fact, type ItemType } from "./profile-update-guard.js";

/** Юнит-тесты серверной проверки операций AI (QA 2026-10-14, №4/№5): каждое правило — свой случай. */
const f = (o: Partial<Fact>): Fact => ({ kind: "capability", phrase: "", evidence: "", canonicalKeys: [], confidence: 0.9, mandatory: false,
  constraintType: "none", constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null, subjectType: "unspecified", nodeIds: [], embedding: [], ...o } as Fact);
const dig = f({ phrase: "копать", nodeIds: ["n-dig"] });
const repair = f({ phrase: "ремонт бытовой техники", nodeIds: ["n-rep"] });
const fridgeRefusal = f({ kind: "exclude", constraintType: "exclusion", phrase: "ремонт холодильников", nodeIds: ["n-fridge"], refusalIntent: "restriction" });
const run = (message: string, prior: Fact[], types: ItemType[], added: Fact[], removes: string[]) => {
  const items = prior.map((p, i) => ({ id: `item_${i + 1}`, type: types[i]! }));
  const byId = new Map(prior.map((p, i) => [`item_${i + 1}`, p]));
  return guardProfileUpdate({ message, prior, items, byId, added, removes, nodeNames: () => [] });
};

describe("profile update guard", () => {
  it("noise message: even a backed, selective revoke is not applied", () => {
    const r = run("🙂", [dig, repair], ["skill", "skill"], [f({ kind: "exclude", constraintType: "exclusion", phrase: "копать", nodeIds: ["n-dig"], refusalIntent: "revoke" })], ["item_1"]);
    expect(r.added).toEqual([]);
    expect(r.dropped.size).toBe(0);
    expect(r.rejected.map((x) => x.reason)).toEqual(["message has no content", "message has no content"]);
  });

  it("restating an active item is a no-op, not a second copy", () => {
    const r = run("Могу копать", [dig], ["skill"], [f({ phrase: "копать", nodeIds: ["n-dig"] })], []);
    expect(r.added).toEqual([]);
    expect(r.rejected[0]!.reason).toBe("already in profile in the same state");
  });

  it("a narrower refusal never removes the broader skill, even when the message names it", () => {
    const r = run("Холодильники больше не ремонтирую, бытовую технику ремонтирую", [repair], ["skill"], [fridgeRefusal], ["item_1"]);
    expect(r.dropped.size).toBe(0);
    expect(r.added).toEqual([fridgeRefusal]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["refusal in this message is about another item"]);
  });

  it("explicit removal named in the message: skill revoked as a decision state, resource marked missing", () => {
    const van = f({ kind: "resource", resourceRole: "available", phrase: "газель", nodeIds: ["n-van"] });
    const r = run("Газель продал, больше не копаю", [dig, van], ["skill", "resource"], [], ["item_1", "item_2"]);
    expect([...r.dropped]).toEqual([dig, van]);
    expect(r.added.map((a) => [a.kind, a.phrase, a.resourceRole, a.resourceCapacity.kind])).toEqual([
      ["exclude", "копать", "none", "revoked"], ["resource", "газель", "missing", null]]);
  });

  it("time: hours must be stated in the message; «9 вечера» = 21", () => {
    expect(hoursGrounded({ startHour: null, endHour: 21, daysOfWeek: null }, "Теперь работаю до 21:00")).toBe(true);
    expect(hoursGrounded({ startHour: null, endHour: 22, daysOfWeek: null }, "Теперь работаю до 21:00")).toBe(false);
    expect(hoursGrounded({ startHour: null, endHour: 21, daysOfWeek: null }, "работаю до 9 вечера")).toBe(true);
    expect(hoursGrounded({ startHour: null, endHour: 21, daysOfWeek: null }, "Есть самолёт")).toBe(false);
    expect(hoursGrounded({ startHour: 18, endHour: 23, daysOfWeek: null }, "работаю по вечерам")).toBe(true);
  });

  it("helpers: noise and mention detection", () => {
    expect(isNoiseMessage("🙂 Спасибо!")).toBe(true);
    expect(isNoiseMessage("Хорошо, спасибо за помощь")).toBe(true);
    expect(isNoiseMessage("Спасибо, газель продал")).toBe(false);
    expect(namedIn("Снова беру заказы на копку", "копать")).toBe(true);
    expect(namedIn("Холодильники больше не ремонтирую", "ремонт бытовой техники")).toBe(false);
    expect(namedIn("Есть самолет", "самолёт")).toBe(true);
  });
});

describe("profile update guard: time replacement", () => {
  it("a new window in the same area backs the removal of the old one (no false «not lifted» diagnostic)", () => {
    const old = f({ kind: "availability", constraintType: "availability", phrase: "работаю до 22:00", endHour: 22 });
    const nw = f({ kind: "availability", constraintType: "availability", phrase: "работаю до 21:00", endHour: 21 });
    const r = run("Теперь работаю до 21:00", [old], ["time_limit"], [nw], ["item_1"]);
    expect(r.rejected).toEqual([]);
    expect(r.added).toEqual([nw]);
  });
});
