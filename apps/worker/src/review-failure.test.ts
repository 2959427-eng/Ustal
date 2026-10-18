import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

vi.mock("dotenv", () => ({ config: vi.fn() }));
const { runSourceReview, decideAfterReview } = await import("./handlers/matching-run.js");
// Same shape as packages/ai EvidenceValidationError (not exported by @ustal/ai): the diagnostic carries source quotes.
class EvidenceValidationError extends Error {
  readonly code = "EVIDENCE_VALIDATION_ERROR";
  constructor(readonly diagnostic: { field: string; evidence: string; sources: string[] }) {
    super("Evidence is not grounded in a source span");
    this.name = "EvidenceValidationError";
  }
}
import type { Fact } from "@ustal/matching";

/**
 * Bug 3 (2026-09-27): one candidate's reviewSemantic error (timeout, provider error, malformed JSON, schema or
 * evidence validation, exhausted retries) used to propagate out of handleMatchingRun and abort the whole order.
 * Safe behaviour: review success + proven conflict -> reject; review success + no conflict -> keep;
 * review technical failure -> keep per the pre-review deterministic decision, unless an independent hard rule
 * already rejected. Never recorded as an AI-confirmed match.
 */
const f = (kind: string, id: string, extra: Partial<Fact> = {}): Fact =>
  ({ kind, phrase: id, nodeIds: id ? [id] : [], confidence: 1, mandatory: false, embedding: [1, 0], ...extra });
// Pre-review: relevant capability + a physical compatibility check that only the review can resolve.
const evaluation = {
  capabilities: [f("capability", "moving"), f("resource", "van", { resourceRole: "available" })],
  requirements: [f("capability", "moving"), f("resource", "", { resourceRole: "compatibility" })],
  relations: [], documentSimilarity: 0.4, riskLevel: 0, regulated: false,
};
const ok = (data: object) => async () => ({ data, provider: "t", model: "m", tokensInput: 1, tokensOutput: 1, latencyMs: 1 }) as never;
const failures: [string, () => Promise<never>][] = [
  ["provider exception", async () => { throw Object.assign(new Error("503 upstream unavailable"), { status: 503 }); }],
  ["timeout", async () => { throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }); }],
  ["malformed JSON", async () => { JSON.parse("{not json"); throw new Error("unreachable"); }],
  ["schema-validation failure", async () => { throw new ZodError([{ code: "custom", path: ["compatible"], message: "Required" }]); }],
  ["evidence-validation failure", async () => { throw new EvidenceValidationError({ field: "profileEvidence", evidence: "invented", sources: ["src"] }); }],
  ["retries exhausted", async () => { throw new Error("Structured validation attempts exhausted"); }],
];

describe("runSourceReview never throws", () => {
  it.each(failures)("%s -> failed outcome with diagnostic, candidate kept (fail-open, not AI-confirmed)", async (_label, call) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await runSourceReview(call, { orderId: "o", userId: "u" });
    expect(outcome.status).toBe("failed");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("semantic_review_failed"));
    log.mockRestore();
    const decision = decideAfterReview(evaluation, outcome);
    expect(decision.matchType).not.toBeNull();
    expect(decision.trace.review_unverified).toBe(true);
    expect(decision.trace.semantic_review).toBeNull(); // no AI verdict is recorded as confirmation
  });
  it("the diagnostic never carries source text from evidence errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await runSourceReview(async () => { throw new EvidenceValidationError({ field: "profileEvidence", evidence: "ЛИЧНЫЙ ТЕКСТ ПРОФИЛЯ", sources: ["ЛИЧНЫЙ ТЕКСТ ПРОФИЛЯ"] }); }, { orderId: "o", userId: "u" });
    expect(JSON.stringify(outcome.status === "failed" ? outcome.error : outcome)).not.toContain("ЛИЧНЫЙ ТЕКСТ");
    expect(log.mock.calls.flat().join(" ")).not.toContain("ЛИЧНЫЙ ТЕКСТ");
    log.mockRestore();
  });
});

describe("decisions after review", () => {
  it("review success + proven conflict -> reject", async () => {
    const outcome = await runSourceReview(ok({ compatible: false, confidence: 0.9, reason: "x", hardConflict: { kind: "resource", profileEvidence: "a", orderEvidence: "b" } }), { orderId: "o", userId: "u" });
    expect(decideAfterReview(evaluation, outcome).matchType).toBeNull();
  });
  it("review success + no conflict -> keep (AI-reviewed)", async () => {
    const outcome = await runSourceReview(ok({ compatible: true, confidence: 0.9, reason: "ok", hardConflict: null }), { orderId: "o", userId: "u" });
    const d = decideAfterReview(evaluation, outcome);
    expect(d.matchType).not.toBeNull();
    expect(d.trace.review_unverified).toBeUndefined();
  });
  it("a failed review never cancels an existing proven hard conflict", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await runSourceReview(failures[0]![1], { orderId: "o", userId: "u" });
    log.mockRestore();
    const refused = { ...evaluation, capabilities: [...evaluation.capabilities, f("exclude", "moving", { constraintScope: "whole_task" })] };
    expect(decideAfterReview(refused, outcome).reason).toBe("explicit_exclusion");
  });
  it("first candidate's review fails, the rest are still reviewed and decided", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = [failures[1]![1], ok({ compatible: true, confidence: 0.9, reason: "ok", hardConflict: null }),
      ok({ compatible: false, confidence: 0.9, reason: "x", hardConflict: { kind: "domain", profileEvidence: "a", orderEvidence: "b" } })];
    const decisions = [];
    for (const [i, call] of calls.entries()) decisions.push(decideAfterReview(evaluation, await runSourceReview(call, { orderId: "o", userId: `u${i}` })));
    log.mockRestore();
    expect(decisions.map((d) => d.matchType !== null)).toEqual([true, true, false]);
  });
});
