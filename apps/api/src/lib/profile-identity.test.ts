import { expect, it } from "vitest";
import { diffUnmapped, pickUnmappedFacts } from "./profile-diff.js";
const f = (phrase: string) => ({ kind: "resource", phrase, nodeIds: [], resourceRole: "available" });
it("legacy duplicate facts yield one displayed item, preserving literal display", () => {
  expect(pickUnmappedFacts([f("самолёт"), f("Самолет."), f("самоле\u0308т")])).toEqual([{ kind: "resource", phrase: "самолёт" }]);
});
it("unknown duplicate of a mapped label is hidden", () => {
  expect(pickUnmappedFacts([f("Самолет.")], ["самолёт"])).toEqual([]);
});
it("machine and coffee machine are both displayed", () => {
  expect(pickUnmappedFacts([f("машина"), f("кофемашина")])).toHaveLength(2);
});
it("draft diff compares normalized identity, not spelling", () => {
  expect(diffUnmapped([{ kind: "resource", phrase: "самолёт" }], [{ kind: "resource", phrase: "САМОЛЕТ." }])).toEqual([]);
});
