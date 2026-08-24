import { describe, expect, it } from "vitest";
import { classifyMatchType, computeScore } from "./scoring.js";
import { getRuntimeConfig } from "@ustal/config";

describe("computeScore", () => {
  it("never exceeds 100 and never depends on payment fields (type-level guarantee)", () => {
    const weights = getRuntimeConfig().matching.weights;
    const result = computeScore(
      {
        explicitCapabilityMatch: 1,
        inferredCapabilityMatch: 1,
        resourceMatch: 1,
        semanticSimilarity: 1,
        similarCompletedWork: 1,
        behavioralPreference: 1,
        missingRequirement: false,
        negativePreference: false,
        riskFlag: false,
      },
      weights,
    );
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThan(0);
  });

  it("penalizes missing mandatory requirement", () => {
    const weights = getRuntimeConfig().matching.weights;
    const withMissing = computeScore(
      {
        explicitCapabilityMatch: 1,
        inferredCapabilityMatch: 0,
        resourceMatch: 0,
        semanticSimilarity: 0,
        similarCompletedWork: 0,
        behavioralPreference: 0,
        missingRequirement: true,
        negativePreference: false,
        riskFlag: false,
      },
      weights,
    );
    const withoutMissing = computeScore(
      {
        explicitCapabilityMatch: 1,
        inferredCapabilityMatch: 0,
        resourceMatch: 0,
        semanticSimilarity: 0,
        similarCompletedWork: 0,
        behavioralPreference: 0,
        missingRequirement: false,
        negativePreference: false,
        riskFlag: false,
      },
      weights,
    );
    expect(withMissing.score).toBeLessThan(withoutMissing.score);
  });

  it("never returns NaN, even with a NaN component (e.g. pgvector cosine distance of two zero vectors)", () => {
    const weights = getRuntimeConfig().matching.weights;
    const result = computeScore(
      {
        explicitCapabilityMatch: 1,
        inferredCapabilityMatch: 0,
        resourceMatch: 0,
        semanticSimilarity: NaN,
        similarCompletedWork: 0,
        behavioralPreference: 0,
        missingRequirement: false,
        negativePreference: false,
        riskFlag: false,
      },
      weights,
    );
    expect(Number.isFinite(result.score)).toBe(true);
  });
});

describe("classifyMatchType", () => {
  it("never returns probable/new_opportunity for unverified regulated tasks", () => {
    const result = classifyMatchType({
      hasExactCapability: true,
      hasSimilarCompletedWork: true,
      hasProbableFit: true,
      isSimpleLowRiskUnregulated: true,
      isRegulatedAndUnverified: true,
    });
    expect(result).toBeNull();
  });
});
