import { describe, expect, it } from "vitest";
import { matchRequirements } from "./requirements.js";

const CAP_A = "11111111-1111-1111-1111-111111111111";
const CAP_B = "22222222-2222-2222-2222-222222222222";
const RES_A = "33333333-3333-3333-3333-333333333333";

describe("matchRequirements", () => {
  it("hard-filters on a missing mandatory required_capability", () => {
    const result = matchRequirements(
      [{ ontologyNodeId: CAP_A, requirementType: "required_capability", isMandatory: true }],
      [],
      [],
    );
    expect(result.missingMandatoryRequirement).toBe(true);
    expect(result.explicitCapabilityMatch).toBe(0);
  });

  it("explicit evidence counts as exact, inferred does not", () => {
    const explicit = matchRequirements(
      [{ ontologyNodeId: CAP_A, requirementType: "required_capability", isMandatory: true }],
      [{ ontologyNodeId: CAP_A, label: "вождение авто", evidenceType: "explicit" }],
      [],
    );
    expect(explicit.hasExactCapability).toBe(true);
    expect(explicit.missingMandatoryRequirement).toBe(false);
    expect(explicit.explicitCapabilityMatch).toBe(1);

    const inferred = matchRequirements(
      [{ ontologyNodeId: CAP_A, requirementType: "required_capability", isMandatory: true }],
      [{ ontologyNodeId: CAP_A, label: "вождение авто", evidenceType: "inferred" }],
      [],
    );
    expect(inferred.hasExactCapability).toBe(false);
    expect(inferred.hasProbableFit).toBe(true);
    expect(inferred.inferredCapabilityMatch).toBe(1);
  });

  it("resource-only match with no capability requirements yields probable, not exact", () => {
    const result = matchRequirements(
      [{ ontologyNodeId: RES_A, requirementType: "required_resource", isMandatory: true }],
      [],
      [{ ontologyNodeId: RES_A, label: "грузовая Газель" }],
    );
    expect(result.resourceMatch).toBe(1);
    expect(result.hasExactCapability).toBe(false);
    expect(result.hasProbableFit).toBe(true);
    expect(result.missingMandatoryRequirement).toBe(false);
  });

  it("no requirements at all -> zero components, no hard filter, not probable", () => {
    const result = matchRequirements([], [], []);
    expect(result.explicitCapabilityMatch).toBe(0);
    expect(result.resourceMatch).toBe(0);
    expect(result.missingMandatoryRequirement).toBe(false);
    expect(result.hasProbableFit).toBe(false);
  });

  it("desired (non-mandatory) requirement missing does not hard-filter", () => {
    const result = matchRequirements(
      [{ ontologyNodeId: CAP_B, requirementType: "desired_capability", isMandatory: false }],
      [],
      [],
    );
    expect(result.missingMandatoryRequirement).toBe(false);
  });
});
