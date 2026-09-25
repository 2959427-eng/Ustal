import { describe, expect, it } from "vitest";
import { isUserAssetResource, narrowRefusalNodeIds, planNegativeOverrides, resolveProfileNegatives, supersededNodeIds, type ProfileFactLike } from "./profile-negatives.js";

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
      f("exclude", "больше не работаю таксистом", "больше не работаю таксистом", [], 2, { constraintType: "exclusion" }),
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
      f("exclude", "больше не работаю таксистом", "y", [], 2, { constraintType: "exclusion" }),
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
    const current = [f("exclude", "работа таксистом", "y", [], 2, { constraintType: "exclusion" })];
    const plan = planNegativeOverrides(current, prior);
    expect(plan.excludedNodeIds.has("driving")).toBe(false);
    expect(plan.relabel.get("driving")).toBe("вождение");
    expect(plan.supersededLabels.has("подрабатываю таксистом")).toBe(true);
  });
  it("a node supported only by the cancelled phrase is excluded", () => {
    const prior = [f("capability", "подрабатываю таксистом", "x", ["driving"], 2)];
    const current = [f("exclude", "работа таксистом", "y", [], 2, { constraintType: "exclusion" })];
    expect(planNegativeOverrides(current, prior).excludedNodeIds.has("driving")).toBe(true);
  });
});
