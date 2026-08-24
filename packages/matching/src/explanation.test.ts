import { describe, expect, it } from "vitest";
import { buildExplanation } from "./explanation.js";

describe("buildExplanation", () => {
  it("never leaks technical details (no numbers, vectors, or scores in output)", () => {
    const text = buildExplanation({
      matchType: "probable",
      hasSimilarCompletedWork: false,
      matchedCapabilityLabels: ["вождение авто"],
      matchedResourceLabels: [],
    });
    expect(text).not.toMatch(/\d/);
    expect(text.toLowerCase()).not.toContain("vector");
    expect(text.toLowerCase()).not.toContain("embedding");
  });

  it("prioritizes similar completed work for exact matches", () => {
    const text = buildExplanation({
      matchType: "exact",
      hasSimilarCompletedWork: true,
      matchedCapabilityLabels: ["вождение авто"],
      matchedResourceLabels: [],
    });
    expect(text).toContain("уже выполняли похожую работу");
  });

  it("new_opportunity always returns the generic accessible-to-everyone message", () => {
    const text = buildExplanation({
      matchType: "new_opportunity",
      hasSimilarCompletedWork: false,
      matchedCapabilityLabels: [],
      matchedResourceLabels: [],
    });
    expect(text).toContain("доступна каждому");
  });
});
