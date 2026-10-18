import { describe, expect, it } from "vitest";
import { isUserAssetResource, isRevokedCapability, narrowRefusalNodeIds, sameResourceItem, unmappedResourcesToCarry, planNegativeOverrides, resolveProfileNegatives, scopeRefusalsOfPriorSkills, supersededNodeIds, type ProfileFactLike, dropCareerContext } from "./profile-negatives.js";

const v = (axis: number) => Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : 0));
const f = (kind: string, phrase: string, evidence: string, nodeIds: string[], axis: number, extra: Partial<ProfileFactLike> = {}): ProfileFactLike =>
  ({ kind, phrase, evidence, nodeIds, embedding: v(axis), resourceRole: "none", constraintType: "none", ...extra });

describe("resolveProfileNegatives", () => {
  const text = "Есть машина. Подрабатываю таксистом.\nПоследнее изменение пользователя:\nПродал машину, больше не работаю таксистом.";
  it("newer 'missing' resource removes the older positive resource on the same node", () => {
    const out = resolveProfileNegatives([
      f("resource", "есть машина", "Есть машина", ["car"], 0, { resourceRole: "available" }),
      f("resource", "продал машину", "Продал машину", ["car"], 1, { resourceRole: "missing" }),
    ], text);
    expect(out.map((x) => x.phrase)).toEqual(["продал машину"]);
  });
  it("newer refusal removes an older skill without ontology node by meaning (embedding)", () => {
    const out = resolveProfileNegatives([
      f("capability", "подрабатываю таксистом", "Подрабатываю таксистом", [], 2),
      f("exclude", "больше не работаю таксистом", "больше не работаю таксистом", [], 2, { constraintType: "exclusion", refusalIntent: "revoke" }),
    ], text);
    expect(out.map((x) => x.phrase)).toEqual(["больше не работаю таксистом"]);
  });
  it("a newer positive statement wins over an older negative one ('купил машину снова')", () => {
    const t = "Продал машину.\nПоследнее изменение пользователя:\nКупил машину снова.";
    const out = resolveProfileNegatives([
      f("resource", "продал машину", "Продал машину", ["car"], 1, { resourceRole: "missing" }),
      f("resource", "купил машину", "Купил машину снова", ["car"], 0, { resourceRole: "available" }),
    ], t);
    expect(out.map((x) => x.phrase)).toEqual(["купил машину"]);
  });
  it("unrelated facts are untouched; refusal does not remove resources and 'missing' does not remove skills", () => {
    const facts = [
      f("capability", "делаю сайты", "x", ["web"], 3),
      f("resource", "есть газонокосилка", "x", ["mower"], 4, { resourceRole: "available" }),
      f("exclude", "не работаю ночью", "x", [], 5, { constraintType: "exclusion" }),
      f("resource", "нет перфоратора", "x", ["drill"], 6, { resourceRole: "missing" }),
    ];
    expect(resolveProfileNegatives(facts, "x")).toHaveLength(4);
  });
});

describe("supersededNodeIds (carry-forward of the previous applied profile)", () => {
  it("excludes prior nodes cancelled by current negatives by node and by meaning", () => {
    const prior = [
      f("resource", "есть машина", "x", ["car"], 0, { resourceRole: "available" }),
      f("capability", "подрабатываю таксистом", "x", ["driving"], 2),
      f("capability", "делаю сайты", "x", ["web"], 3),
    ];
    const current = [
      f("resource", "продал машину", "y", ["car"], 1, { resourceRole: "missing" }),
      f("exclude", "больше не работаю таксистом", "y", [], 2, { constraintType: "exclusion", refusalIntent: "revoke" }),
    ];
    expect([...supersededNodeIds(current, prior)].sort()).toEqual(["car", "driving"]);
  });
});

describe("isUserAssetResource", () => {
  it("only real executor assets become user resources", () => {
    for (const role of ["missing", "provided_by_customer", "compatibility"]) expect(isUserAssetResource({ kind: "resource", resourceRole: role })).toBe(false);
    for (const role of ["available", "none", null]) expect(isUserAssetResource({ kind: "resource", resourceRole: role })).toBe(true);
    expect(isUserAssetResource({ kind: "capability", resourceRole: "none" })).toBe(false);
  });
});

describe("narrowRefusalNodeIds: a narrow refusal never binds to a broad skill node", () => {
  const nodes: Record<string, { nodeType: string; hasChildren: boolean }> = {
    driving: { nodeType: "capability", hasChildren: true },
    freight: { nodeType: "capability", hasChildren: false },
    taxi_ride: { nodeType: "action", hasChildren: false },
    repair: { nodeType: "action", hasChildren: true },
  };
  const node = (id: string) => nodes[id];
  it("'работа таксистом' mapped by the model to driving/freight -> dropped (matched by meaning only)", () => {
    expect(narrowRefusalNodeIds(undefined, ["driving", "freight"], node)).toEqual([]);
  });
  it("a refusal that names the node itself is kept ('вождение' -> driving)", () => {
    expect(narrowRefusalNodeIds("driving", ["driving"], node)).toEqual(["driving"]);
  });
  it("a narrow leaf activity node is kept; a broad parent activity is not", () => {
    expect(narrowRefusalNodeIds(undefined, ["taxi_ride", "repair"], node)).toEqual(["taxi_ride"]);
  });
});

describe("planNegativeOverrides: meaning-only refusal cancels the phrase, not a node confirmed elsewhere", () => {
  it("'больше не работаю таксистом' keeps driving confirmed by 'вождение' and relabels it", () => {
    const prior = [
      f("capability", "подрабатываю таксистом", "x", ["driving"], 2),
      f("capability", "вождение", "x", ["driving"], 3),
    ];
    const current = [f("exclude", "работа таксистом", "y", [], 2, { constraintType: "exclusion", refusalIntent: "revoke" })];
    const plan = planNegativeOverrides(current, prior);
    expect(plan.excludedNodeIds.has("driving")).toBe(false);
    expect(plan.relabel.get("driving")).toBe("вождение");
    expect(plan.supersededLabels.has("подрабатываю таксистом")).toBe(true);
  });
  it("a node supported only by the cancelled phrase is excluded", () => {
    const prior = [f("capability", "подрабатываю таксистом", "x", ["driving"], 2)];
    const current = [f("exclude", "работа таксистом", "y", [], 2, { constraintType: "exclusion", refusalIntent: "revoke" })];
    expect(planNegativeOverrides(current, prior).excludedNodeIds.has("driving")).toBe(true);
  });
});

// Stage 0 career context (claude/extended-ai-profile-architecture-2026-09-27.md, 2026-09-27).
describe("dropCareerContext", () => {
  const f = (kind: string, constraintType: string, subjectType?: string) => ({ kind, constraintType, subjectType, phrase: kind });
  it("drops a relocation refusal typed as career context, so it cannot reject moving orders", () => {
    const facts = [f("capability", "none"), f("exclude", "exclusion", "career_context")];
    expect(dropCareerContext("profile", facts)).toEqual([facts[0]]);
  });
  it("drops scope/availability constraints from job-search statements", () => {
    expect(dropCareerContext("profile", [f("capability", "scope", "career_context"), f("availability", "availability", "career_context")])).toEqual([]);
  });
  it("keeps positive career facts and every non-career constraint (explicit refusals still work)", () => {
    const facts = [f("capability", "none", "career_context"), f("exclude", "exclusion"), f("exclude", "exclusion", "unspecified"), f("availability", "availability")];
    expect(dropCareerContext("profile", facts)).toEqual(facts);
  });
  it("never touches order facts", () => {
    const facts = [f("exclude", "exclusion", "career_context")];
    expect(dropCareerContext("order", facts)).toEqual(facts);
  });
});

it("dropCareerContext keeps an explicit lift even when the model typed it as career context (2026-10-06)", () => {
  const lift = { kind: "capability", constraintType: "lift", subjectType: "career_context", phrase: "Теперь делаю и Android" };
  const scope = { kind: "capability", constraintType: "scope", subjectType: "career_context", phrase: "только iOS" };
  expect(dropCareerContext("profile", [lift, scope])).toEqual([lift]);
});

it("dropCareerContext keeps working hours even when the model typed them as career context (2026-10-06)", () => {
  const hours = { kind: "availability", constraintType: "availability", subjectType: "career_context", phrase: "не работаю после 22:00", endHour: 22 };
  const relocation = { kind: "exclude", constraintType: "exclusion", subjectType: "career_context", phrase: "переезд в другой город" };
  expect(dropCareerContext("profile", [hours, relocation])).toEqual([hours]);
});

describe("skill revoke vs restriction (refusalIntent, 2026-10-06)", () => {
  const text = "Могу копать.\nПоследнее изменение пользователя:\nНе хочу больше копать.";
  const skill = () => f("capability", "копать", "Могу копать.", ["dig"], 1);
  const refusal = (refusalIntent?: "revoke" | "restriction") =>
    f("exclude", "копать", "Не хочу больше копать.", ["dig"], 1, { constraintType: "exclusion", constraintScope: "fact", refusalIntent });

  it("an explicit revoke removes the older skill and marks the refusal as a revoked skill (whole task)", () => {
    const out = resolveProfileNegatives([skill(), refusal("revoke")], text);
    expect(out.map((x) => x.kind)).toEqual(["exclude"]);
    expect(out[0]).toMatchObject({ constraintScope: "whole_task" });
    expect(isRevokedCapability(out[0]!)).toBe(true);
  });

  it("a restriction or an ambiguous refusal keeps the skill; the refusal of that same activity covers whole orders", () => {
    for (const intent of ["restriction", undefined] as const) {
      const out = resolveProfileNegatives([skill(), refusal(intent)], text);
      expect(out.map((x) => x.kind)).toEqual(["capability", "exclude"]);
      expect(out[1]).toMatchObject({ constraintScope: "whole_task" });
      expect(isRevokedCapability(out[1]!)).toBe(false);
    }
  });

  it("a newer positive statement re-enables the skill and drops the older revoke", () => {
    const t = text + "\nПоследнее изменение пользователя:\nСнова беру заказы на копку.";
    const back = f("capability", "копка", "Снова беру заказы на копку.", ["dig"], 1);
    expect(resolveProfileNegatives([skill(), refusal("revoke"), back], t).map((x) => x.phrase)).toEqual(["копка"]);
  });

  it("carry-forward: only a revoke cancels a prior skill; a restriction keeps it and becomes a whole-task refusal", () => {
    expect(planNegativeOverrides([refusal("revoke")], [skill()]).excludedNodeIds.has("dig")).toBe(true);
    const r = refusal("restriction");
    expect(planNegativeOverrides([r], [skill()]).excludedNodeIds.size).toBe(0);
    scopeRefusalsOfPriorSkills([r], [skill()]);
    expect(r).toMatchObject({ kind: "exclude", constraintScope: "whole_task" });
    // A refusal of something that is not a skill of the profile keeps the scope the model gave it.
    const other = f("exclude", "работа на высоте", "x", ["height"], 2, { constraintType: "exclusion", constraintScope: "fact" });
    scopeRefusalsOfPriorSkills([other], [skill()]);
    expect(other.constraintScope).toBe("fact");
  });

  it("a missing resource still cancels an owned resource (unchanged)", () => {
    const t = "Есть машина.\nПоследнее изменение пользователя:\nПродал машину.";
    const car = f("resource", "машина", "Есть машина.", ["car"], 3, { resourceRole: "available" });
    const sold = f("resource", "машина", "Продал машину.", ["car"], 3, { resourceRole: "missing" });
    expect(resolveProfileNegatives([car, sold], t)).toEqual([sold]);
  });
});

it("a revoke of a skill that exists only in the prior applied profile is marked as a revoked skill", () => {
  const prior: ProfileFactLike = { kind: "capability", phrase: "могу копать", evidence: "Могу копать.", nodeIds: ["dig"], embedding: v(1), resourceRole: "none", constraintType: "none" };
  const r: ProfileFactLike = { kind: "exclude", phrase: "копать", evidence: "Не хочу больше копать.", nodeIds: ["dig"], embedding: v(1), resourceRole: "none", constraintType: "exclusion", constraintScope: "fact", refusalIntent: "revoke" };
  scopeRefusalsOfPriorSkills([r], [prior]);
  expect(isRevokedCapability(r)).toBe(true);
  expect(r.constraintScope).toBe("whole_task");
  // Without an existing skill a «revoke» is an ordinary refusal and stays visible.
  const lone: ProfileFactLike = { ...r, resourceCapacity: undefined, constraintScope: "fact" };
  scopeRefusalsOfPriorSkills([lone], []);
  expect(isRevokedCapability(lone)).toBe(false);
});

describe("removing a resource by name (2026-10-12)", () => {
  it("same item regardless of case, inflection and possession words; different items never match", () => {
    expect(sameResourceItem("кофемашина", "Есть Кофемашина")).toBe(true);
    expect(sameResourceItem("Убери кофемашину из ресурсов", "Есть кофемашина")).toBe(true);
    expect(sameResourceItem("Генератор я продал", "есть генератор")).toBe(true);
    expect(sameResourceItem("генератора", "у меня свой генератор")).toBe(true);
    expect(sameResourceItem("кофемашина", "Есть машина")).toBe(false);
    expect(sameResourceItem("машина", "Есть кофемашина")).toBe(false);
    expect(sameResourceItem("самолет", "Есть машина")).toBe(false);
    // A long sentence about one item never removes another item it merely mentions.
    expect(sameResourceItem("продал генератор, машина осталась у меня", "есть машина")).toBe(false);
  });

  it("«Генератор я продал» removes «Есть генератор» even when the embeddings are far apart", () => {
    const t = "Есть генератор и кофемашина.\nПоследнее изменение пользователя:\nГенератор я продал.";
    const gen = f("resource", "Есть генератор", "Есть генератор и кофемашина.", [], 1, { resourceRole: "available" });
    const coffee = f("resource", "Есть кофемашина", "Есть генератор и кофемашина.", [], 2, { resourceRole: "available" });
    const sold = f("resource", "генератор", "Генератор я продал.", [], 3, { resourceRole: "missing" });
    expect(resolveProfileNegatives([gen, coffee, sold], t).map((x) => x.phrase)).toEqual(["Есть кофемашина", "генератор"]);
  });

  it("unmapped resources the model did not repeat are carried, removed ones are not, present ones are not duplicated", () => {
    const prior = [
      f("resource", "Есть самолет", "x", [], 1, { resourceRole: "available" }),
      f("resource", "Есть кофемашина", "x", [], 2, { resourceRole: "available" }),
      f("resource", "Есть генератор", "x", [], 3, { resourceRole: "available" }),
      f("resource", "Есть машина", "x", ["car"], 4, { resourceRole: "available" }),
    ];
    const current = [
      f("resource", "кофемашина", "y", [], 5, { resourceRole: "missing" }),
      f("resource", "генератор", "y", [], 6, { resourceRole: "available" }),
    ];
    expect(unmappedResourcesToCarry(current, prior).map((x) => x.phrase)).toEqual(["Есть самолет"]);
  });
});
