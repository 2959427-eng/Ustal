import { expect, it } from "vitest";
import { deduplicateProfileResourceFacts as dedup } from "./profile-resource-identity.js";
import type { ProfileFactLike } from "./profile-negatives.js";
const f = (phrase: string, extra: Partial<ProfileFactLike> = {}): ProfileFactLike => ({ kind: "resource", phrase, nodeIds: [], resourceRole: "available", constraintType: "none", ...extra });

it("keeps latest evidence and literal display without semantic similarity", () => {
  const a = f("самолёт", { evidence: "первый ввод", embedding: [1, 0] });
  const b = f("САМОЛЕТ.", { evidence: "новый ввод", embedding: [0, 1] });
  expect(dedup([a, b], "первый ввод; новый ввод")).toEqual([b]);
});
it("does not equate overlapping words or ontology aliases by identity alone", () => {
  expect(dedup([f("машина", { nodeIds: ["car"] }), f("кофемашина", { nodeIds: ["car"] })], "")).toHaveLength(2);
});
it("retains missing/customer/compatibility roles, capacities and time limits separately", () => {
  const facts = [f("прибор"), f("прибор.", { resourceRole: "missing" }), f("прибор", { resourceRole: "provided_by_customer" }),
    f("прибор", { resourceRole: "compatibility" }), f("прибор", { resourceCapacity: { value: 5, unit: "кВт", kind: null } }),
    f("прибор", { endHour: 18 })];
  expect(dedup(facts, "")).toEqual(facts);
  expect(dedup([f("прибор"), f("прибор.", { daysOfWeek: [] })], "")).toHaveLength(1);
});
it("does not merge conflicting established ontology bindings", () => {
  const facts = [f("прибор", { nodeIds: ["a"] }), f("прибор.", { nodeIds: ["b"] })];
  expect(dedup(facts, "")).toEqual(facts);
});
it("known/unmapped equivalent spellings share identity, keeping the established node", () => {
  const mapped = f("самолёт", { nodeIds: ["plane"], evidence: "раньше" });
  const unmapped = f("самолет.", { evidence: "позже" });
  expect(dedup([mapped, unmapped], "раньше; позже")).toEqual([{ ...unmapped, nodeIds: ["plane"] }]);
});
it("capability and resource with identical phrases remain separate facts", () => {
  const facts = [f("пилотирование", { kind: "capability" }), f("пилотирование")];
  expect(dedup(facts, "")).toEqual(facts);
});
