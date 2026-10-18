import { describe, expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "./semantic.js";

/**
 * Final acceptance (2026-10-18): a technical AI-review failure (reviewUnavailable → trace.review_unverified)
 * is a high-recall fallback only. It waives review-only gates, but every deterministic hard gate still
 * rejects for every positive classification path (exact / probable / semantic-only):
 * explicit refusal, global hours, allowed days, activity-scoped window, proven resource incompatibility
 * (explicit "нет", known kind mismatch, one-trip capacity shortfall). Revoked/removed facts never count.
 * (City / status / author / blocks are filtered in SQL before any candidate reaches review.)
 */
const f = (kind: string, id: string, extra: Partial<Fact> = {}): Fact =>
  ({ kind, phrase: id, nodeIds: id ? [id] : [], confidence: 1, mandatory: false, embedding: [1, 0], ...extra });
type Opts = Partial<Parameters<typeof evaluateSemantic>[0]>;
const run = (caps: Fact[], reqs: Fact[], extra: Opts = {}) =>
  evaluateSemantic({ capabilities: caps, requirements: reqs, relations: [], documentSimilarity: 0.3, riskLevel: 0,
    regulated: false, localHour: 20, localWeekday: 5, reviewUnavailable: true, ...extra });

const bases: Record<string, { caps: Fact[]; reqs: Fact[]; extra?: Opts; task: string }> = {
  exact: { caps: [f("capability", "paint")], reqs: [f("capability", "paint")], task: "paint" },
  probable: { caps: [f("capability", "paint")],
    reqs: [f("capability", "paint"), f("capability", "plaster", { embedding: [0, 1] }), f("capability", "tile", { embedding: [0, 1] })],
    extra: { documentSimilarity: 0.1 }, task: "paint" },
  "semantic-only": { caps: [f("capability", "decor", { embedding: [1, 0] })],
    reqs: [f("capability", "paint", { embedding: [0.8, 0.6] })], extra: { documentSimilarity: 0.85 }, task: "paint" },
};
const vehicleReq = (extra: Partial<Fact> = {}) =>
  f("resource", "van", { resourceRole: "required", mandatory: true, constraintScope: "whole_task", embedding: [0, 1], ...extra });

describe.each(Object.entries(bases))("review technical failure keeps hard gates — %s", (expected, b) => {
  const go = (caps: Fact[] = [], reqs: Fact[] = [], extra: Opts = {}) =>
    run([...b.caps, ...caps], [...b.reqs, ...reqs], { ...b.extra, ...extra });

  it("baseline: delivered as review_unverified, never as AI-confirmed", () => {
    const r = go();
    expect(r.classification).toBe(expected);
    expect(r.matchType).not.toBeNull();
    expect(r.trace.review_unverified).toBe(true);
    expect(r.trace.semantic_review).toBeNull();
  });
  it("explicit whole-task refusal rejects", () =>
    expect(go([f("exclude", b.task, { constraintScope: "whole_task" })]).reason).toBe("explicit_exclusion"));
  it("global hours reject", () =>
    expect(go([f("availability", "", { nodeIds: [], startHour: 9, endHour: 18 })]).reason).toBe("outside_availability"));
  it("allowed days reject (Sat order, Mon–Fri allowed)", () =>
    expect(go([f("availability", "", { nodeIds: [], daysOfWeek: [0, 1, 2, 3, 4] })]).reason).toBe("outside_availability"));
  it("activity-scoped window of this activity rejects", () =>
    expect(go([f("availability", b.task, { constraintScope: "fact", endHour: 18 })]).reason).toBe("outside_availability"));
  it("explicit missing resource rejects", () =>
    expect(go([f("resource", "van", { resourceRole: "missing", embedding: [0, 1] })], [vehicleReq()]).reason).toBe("missing_mandatory_resource"));
  it("known physical kind mismatch rejects", () =>
    expect(go([f("resource", "drill", { resourceRole: "available", embedding: [0, 1], resourceCapacity: { value: null, unit: null, kind: "дрель" } })],
      [f("resource", "drill", { resourceRole: "required", mandatory: true, resourceType: "tool", embedding: [0, 1], resourceCapacity: { value: null, unit: null, kind: "перфоратор" } })]).reason)
      .toBe("missing_mandatory_resource"));
  it("one-trip capacity shortfall rejects", () =>
    expect(go([f("resource", "van", { resourceRole: "available", embedding: [0, 1], resourceCapacity: { value: 2, unit: "m3", kind: null } })],
      [vehicleReq({ resourceCapacity: { value: 5, unit: "m3", kind: null } })]).reason).toBe("missing_mandatory_resource"));
});

describe("review technical failure never resurrects revoked/removed facts", () => {
  it("a revoked capability (superseded marker) is not evidence: no match", () => {
    const r = run([f("superseded", "paint", { resourceCapacity: { value: null, unit: null, kind: "removed_by_user:capability" } })],
      [f("capability", "paint")], { documentSimilarity: 0.1 });
    expect(r.matchType).toBeNull();
  });
  it("a lifted restriction marker does not block", () => {
    const r = run([f("capability", "paint"),
      f("superseded", "", { nodeIds: [], resourceCapacity: { value: 18, unit: null, kind: "lifted:time_global" } })], [f("capability", "paint")]);
    expect(r.matchType).toBe("exact");
  });
});
