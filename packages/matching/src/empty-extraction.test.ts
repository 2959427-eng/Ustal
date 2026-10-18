import { expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "./semantic.js";

const f = (kind: string, id: string, extra: Partial<Fact> = {}): Fact => ({ kind, phrase: id, nodeIds: [id], confidence: 1, mandatory: false, embedding: [1, 0], ...extra });
const run = (caps: Fact[], reqs: Fact[], semanticReview?: Parameters<typeof evaluateSemantic>[0]["semanticReview"]) =>
  evaluateSemantic({ capabilities: caps, requirements: reqs, relations: [], documentSimilarity: 0.27, riskLevel: 0, regulated: false, semanticReview });
const relevant = { compatible: true, confidence: 0.9, reason: "Смежная деятельность", hardConflict: null };

it("empty order extraction without a review is not an automatic match", () => {
  expect(run([f("capability", "hunter")], [])).toMatchObject({ matchType: null, reason: "insufficient_capability_evidence" });
});
it("empty order extraction resolved by a positive source review becomes a candidate", () => {
  expect(run([f("capability", "hunter")], [], relevant).matchType).not.toBeNull();
});
it("empty order extraction with a grounded source conflict is rejected", () => {
  expect(run([f("capability", "hunter")], [], { ...relevant, compatible: false, hardConflict: { kind: "domain", profileEvidence: "охотник", orderEvidence: "бухгалтерия" } }).reason).toBe("domain_mismatch");
});
it.each([["pilot, commercial aviation", "drones"], ["oil painter", "digital graphic design"]])("adjacent field %s -> %s stays a candidate after a positive review", (profile, order) => {
  expect(run([f("capability", profile, { embedding: [0, 1] })], [f("capability", order)], relevant).matchType).not.toBeNull();
});
