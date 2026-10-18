import { describe, expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "./semantic.js";

/**
 * Codex audit 2026-10-18 (FAIL): an active scope restriction («беру только IT-заказы») was enforced only by the
 * AI source review (exclusiveScope). A technical review failure (reviewUnavailable) waived it: painting was
 * delivered as exact 80 with review_unverified. A live scope restriction is a deterministic hard gate: an order
 * outside it is cleared only by a COMPLETED review, never by a technical failure. Generic (any scope), not IT.
 * Real stored shape (live 2026-10-18): kind=capability, constraintType=scope, constraintScope=fact, node of the scope.
 */
const f = (kind: string, id: string, extra: Partial<Fact> = {}): Fact =>
  ({ kind, phrase: id, nodeIds: id ? [id] : [], confidence: 1, mandatory: false, embedding: [1, 0, 0], ...extra });
type Opts = Partial<Parameters<typeof evaluateSemantic>[0]>;
const run = (caps: Fact[], reqs: Fact[], extra: Opts = {}) =>
  evaluateSemantic({ capabilities: caps, requirements: reqs, relations: [], documentSimilarity: 0.3, riskLevel: 0,
    regulated: false, ...extra });
const onlyIt = f("capability", "it", { phrase: "IT-заказы", constraintType: "scope", constraintScope: "fact", embedding: [0, 0, 1] });
const failed = { reviewUnavailable: true };

const bases: Record<string, { caps: Fact[]; reqs: Fact[]; extra?: Opts }> = {
  exact: { caps: [f("capability", "paint")], reqs: [f("capability", "paint")] },
  probable: { caps: [f("capability", "paint")],
    reqs: [f("capability", "paint"), f("capability", "plaster", { embedding: [0, 1, 0] }), f("capability", "tile", { embedding: [0, 1, 0] })],
    extra: { documentSimilarity: 0.1 } },
  "semantic-only": { caps: [f("capability", "decor")], reqs: [f("capability", "paint", { embedding: [0.8, 0.6, 0] })],
    extra: { documentSimilarity: 0.85 } },
};

describe.each(Object.entries(bases))("scope restriction is a hard gate — %s", (expected, b) => {
  it("control: without the scope restriction the review failure keeps the candidate (high recall)", () => {
    const r = run(b.caps, b.reqs, { ...b.extra, ...failed });
    expect(r.classification).toBe(expected);
    expect(r.trace.review_unverified).toBe(true);
  });
  it("technical review failure cannot bypass an active scope restriction", () => {
    const r = run([...b.caps, onlyIt], b.reqs, { ...b.extra, ...failed });
    expect(r.matchType).toBeNull();
    expect(r.reason).toBe("scope_unverified");
  });
  it("a completed review that proves the scope conflict rejects", () => {
    const r = run([...b.caps, onlyIt], b.reqs, { ...b.extra, semanticReview: { compatible: false, confidence: 0.95, reason: "outside scope",
      hardConflict: { kind: "scope", profileEvidence: "Беру только IT-заказы", orderEvidence: "покраска" } } });
    expect(r.matchType).toBeNull();
  });
});

describe("scope restriction: positive controls and lifecycle", () => {
  const itOrder = [f("capability", "it", { embedding: [0, 0, 1] })];
  it("an order inside the scope passes even when the review fails", () => {
    const r = run([f("capability", "paint"), onlyIt], itOrder, failed);
    expect(r.matchType).toBe("exact");
    expect(r.trace.review_unverified).toBe(true);
  });
  it("an order inside the scope passes with a normal successful review", () => {
    expect(run([f("capability", "paint"), onlyIt], itOrder, { semanticReview: { compatible: true, confidence: 0.9, reason: "IT" } }).matchType).toBe("exact");
  });
  it("same meaning by vector (no shared node) counts as inside the scope", () => {
    const r = run([onlyIt], [f("capability", "network", { embedding: [0, 0, 1] })], failed);
    expect(r.reason).not.toBe("scope_unverified");
  });
  it("a completed positive review keeps its verdict (successful-review path unchanged)", () => {
    expect(run([f("capability", "paint"), onlyIt], [f("capability", "paint")],
      { semanticReview: { compatible: true, confidence: 0.9, reason: "within scope" } }).matchType).toBe("exact");
  });
  it("a scope restriction the user lifted (superseded marker) no longer gates", () => {
    const lifted = { ...onlyIt, kind: "superseded", resourceCapacity: { value: null, unit: null, kind: "lifted:scope" } } as Fact;
    expect(run([f("capability", "paint"), lifted], [f("capability", "paint")], failed).matchType).toBe("exact");
  });
  it("an in-scope order the rules cannot place (no shared node, distant vector) waits for a completed review", () => {
    // Live 2026-10-18: «IT-заказы» (programming) vs «настроить компьютер» (computer_repair): no shared node/parent,
    // cosine 0.25. Technical failure → not delivered in this run (the run is never cached, the next run re-reviews);
    // a completed review then delivers it.
    const pc = [f("capability", "computer_repair", { embedding: [0, 0.97, 0.25] })];
    expect(run([f("capability", "computer_repair"), onlyIt], pc, failed).reason).toBe("scope_unverified");
    expect(run([f("capability", "computer_repair"), onlyIt], pc, { semanticReview: { compatible: true, confidence: 0.9, reason: "IT" } }).matchType).toBe("exact");
  });
  it("a scope restriction never widens: other hard gates still apply inside it", () => {
    const r = run([onlyIt, f("availability", "", { nodeIds: [], startHour: 9, endHour: 18 })], itOrder, { ...failed, localHour: 23 });
    expect(r.reason).toBe("outside_availability");
  });
});
