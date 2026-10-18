import { describe, expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "./semantic.js";

/**
 * Bug 2 / bug 3 regression (2026-09-27). USTAL invariant: unknown or a technical failure ≠ incompatibility.
 * - A mandatory resource the profile is silent about, or a capacity that cannot be compared (unknown value/unit),
 *   is NOT proof the executor lacks it: no hard reject, the source review decides.
 * - Proven incompatibility stays a hard reject: explicit "нет X", known kind mismatch of a physical resource,
 *   known same-unit shortfall on a whole-task (one-trip) requirement.
 * - reviewUnavailable (technical review failure) waives review-only gates but is never counted as a positive
 *   review, and never cancels an independent hard rule.
 */
const f = (kind: string, id: string, extra: Partial<Fact> = {}): Fact =>
  ({ kind, phrase: id, nodeIds: id ? [id] : [], confidence: 1, mandatory: false, embedding: [1, 0], ...extra });
const cap = (id = "moving") => f("capability", id);
const van = (extra: Partial<Fact> = {}) => f("resource", "van", { resourceRole: "available", ...extra });
const needVan = (extra: Partial<Fact> = {}) => f("resource", "van", { resourceRole: "required", mandatory: true, constraintScope: "whole_task", ...extra });
const run = (caps: Fact[], reqs: Fact[], extra: Partial<Parameters<typeof evaluateSemantic>[0]> = {}) =>
  evaluateSemantic({ capabilities: caps, requirements: reqs, relations: [], documentSimilarity: 0.3, riskLevel: 0, regulated: false, ...extra });
const positive = { compatible: true, confidence: 0.9, reason: "Relevant" };

describe("missing data is not a missing resource", () => {
  it("P06: required 1 шт vs owned van with unknown unit is not a hard reject", () => {
    const r = run([cap(), van({ resourceCapacity: { value: 1, unit: null, kind: "грузовой фургон" } })],
      [cap(), needVan({ resourceCapacity: { value: 1, unit: "шт", kind: "газель" } })], { semanticReview: positive });
    expect(r.reason).not.toBe("missing_mandatory_resource");
    expect(r.matchType).not.toBeNull();
  });
  it("owned van with unknown capacity vs a required count is not a hard reject", () => {
    const r = run([cap(), van({ resourceCapacity: { value: null, unit: null, kind: "газель" } })],
      [cap(), needVan({ resourceCapacity: { value: 1, unit: null, kind: "грузовой фургон" } })], { semanticReview: positive });
    expect(r.matchType).not.toBeNull();
  });
  it("different known units are not comparable: soft, never a whole-task hard reject", () => {
    const r = run([cap(), van({ resourceCapacity: { value: 2, unit: "т", kind: null } })],
      [cap(), needVan({ resourceCapacity: { value: 10, unit: "м3", kind: null } })], { semanticReview: positive });
    expect(r.matchType).not.toBeNull();
  });
  it("P11: profile silent about the mandatory van -> review decides instead of missing_mandatory_resource", () => {
    const reqs = [cap(), needVan()];
    expect(run([cap()], reqs).reason).toBe("physical_compatibility_unverified");
    expect(run([cap()], reqs, { semanticReview: positive }).matchType).toBe("probable");
    expect(run([cap()], reqs, { semanticReview: { ...positive, compatible: false, hardConflict: { kind: "resource", profileEvidence: "нет машины", orderEvidence: "свой фургон" } } }).matchType).toBeNull();
  });
  it("an unverified mandatory resource is never labelled exact", () => {
    expect(run([cap()], [cap(), needVan()], { semanticReview: positive }).classification).not.toBe("exact");
  });
});

describe("proven resource conflicts stay hard", () => {
  it("explicit 'нет фургона' rejects a mandatory van", () => {
    expect(run([cap(), van({ resourceRole: "missing" })], [cap(), needVan()], { semanticReview: positive }).reason).toBe("missing_mandatory_resource");
  });
  it("explicit absence without an ontology node is matched by meaning", () => {
    expect(run([cap(), f("resource", "", { resourceRole: "missing", embedding: [1, 0] })], [cap(), needVan()], { semanticReview: positive }).reason).toBe("missing_mandatory_resource");
  });
  it("known same-unit shortfall on a whole-task requirement rejects", () => {
    expect(run([cap(), van({ resourceCapacity: { value: 2, unit: "м3", kind: null } })],
      [cap(), needVan({ resourceCapacity: { value: 5, unit: "м3", kind: null } })], { semanticReview: positive }).reason).toBe("missing_mandatory_resource");
  });
  it("known physical kind mismatch rejects", () => {
    expect(run([cap(), f("resource", "drill", { resourceRole: "available", resourceCapacity: { value: null, unit: null, kind: "дрель" } })],
      [cap(), f("resource", "drill", { resourceRole: "required", mandatory: true, resourceType: "tool", resourceCapacity: { value: null, unit: null, kind: "перфоратор" } })],
      { semanticReview: positive }).reason).toBe("missing_mandatory_resource");
  });
});

describe("review technical failure (reviewUnavailable) is fail-open, not an AI confirmation", () => {
  it("keeps a candidate whose only gate was the pending review", () => {
    const r = run([cap(), van()], [cap(), f("resource", "", { resourceRole: "compatibility" })], { reviewUnavailable: true });
    expect(r.matchType).not.toBeNull();
    expect(r.trace.review_unverified).toBe(true);
  });
  it("keeps a safety/qualification-gated candidate with deterministic relevance", () => {
    expect(run([cap("electric")], [cap("electric")], { riskLevel: 1, reviewRequired: true, reviewUnavailable: true }).matchType).toBe("exact");
  });
  it("does not invent relevance: no deterministic evidence stays rejected", () => {
    expect(run([f("capability", "nails", { embedding: [0, 1] })], [cap("moving")], { documentSimilarity: 0.1, reviewUnavailable: true }).matchType).toBeNull();
  });
  it("never cancels an independent hard rule (explicit exclusion, availability, explicit missing resource)", () => {
    expect(run([cap(), f("exclude", "moving", { constraintScope: "whole_task" })], [cap()], { reviewUnavailable: true }).reason).toBe("explicit_exclusion");
    expect(run([cap(), f("availability", "", { startHour: 9, endHour: 18 })], [cap()], { localHour: 23, reviewUnavailable: true }).reason).toBe("outside_availability");
    expect(run([cap(), van({ resourceRole: "missing" })], [cap(), needVan()], { reviewUnavailable: true }).reason).toBe("missing_mandatory_resource");
  });
});
