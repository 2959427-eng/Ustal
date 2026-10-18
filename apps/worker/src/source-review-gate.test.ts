import { expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: vi.fn() }));
const { shouldRunSourceReview } = await import("./handlers/matching-run.js");

it("empty order extraction with both source texts runs the source review", () => {
  expect(shouldRunSourceReview({ needsSourceReview: true, structuredEvidence: false, sourceTextsAvailable: true })).toBe(true);
});
it("without structured facts or source texts no review runs (candidate stays rejected)", () => {
  expect(shouldRunSourceReview({ needsSourceReview: true, structuredEvidence: false, sourceTextsAvailable: false })).toBe(false);
});
it("structured evidence keeps the existing review path", () => {
  expect(shouldRunSourceReview({ needsSourceReview: true, structuredEvidence: true, sourceTextsAvailable: false })).toBe(true);
});
it("no review when the decision does not need one", () => {
  expect(shouldRunSourceReview({ needsSourceReview: false, structuredEvidence: true, sourceTextsAvailable: true })).toBe(false);
});
