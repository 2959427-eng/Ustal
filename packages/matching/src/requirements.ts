/**
 * Сопоставление требований заказа (order_requirements) со способностями и
 * ресурсами кандидата (user_capabilities/user_resources) — чистые функции,
 * без обращения к БД (сама выборка — на стороне worker'а, см.
 * apps/worker/src/handlers/matching-run.ts). Раздел 13.1-13.2 matching.md.
 */
export type RequirementType = "required_capability" | "desired_capability" | "required_resource" | "desired_resource";

export interface OrderRequirement {
  ontologyNodeId: string;
  requirementType: RequirementType;
  isMandatory: boolean;
}

export interface CandidateCapability {
  ontologyNodeId: string;
  label: string;
  evidenceType: string; // 'explicit' считается явным; всё остальное — inferred-бакет
}

export interface CandidateResource {
  ontologyNodeId: string;
  label: string;
}

export interface RequirementMatchResult {
  explicitCapabilityMatch: number; // 0..1
  inferredCapabilityMatch: number; // 0..1
  resourceMatch: number; // 0..1
  /** Не пройден обязательный (is_mandatory) required_* — hard filter, а не штраф (13.1). */
  missingMandatoryRequirement: boolean;
  hasExactCapability: boolean;
  hasProbableFit: boolean;
  matchedCapabilityLabels: string[];
  matchedResourceLabels: string[];
}

export function matchRequirements(
  requirements: OrderRequirement[],
  candidateCapabilities: CandidateCapability[],
  candidateResources: CandidateResource[],
): RequirementMatchResult {
  const capabilityByNode = new Map(candidateCapabilities.map((c) => [c.ontologyNodeId, c]));
  const resourceByNode = new Map(candidateResources.map((r) => [r.ontologyNodeId, r]));

  const capabilityReqs = requirements.filter(
    (r) => r.requirementType === "required_capability" || r.requirementType === "desired_capability",
  );
  const resourceReqs = requirements.filter(
    (r) => r.requirementType === "required_resource" || r.requirementType === "desired_resource",
  );

  let explicitHits = 0;
  let inferredHits = 0;
  let missingMandatoryRequirement = false;
  const matchedCapabilityLabels: string[] = [];

  for (const req of capabilityReqs) {
    const match = capabilityByNode.get(req.ontologyNodeId);
    if (match) {
      if (match.evidenceType === "explicit") explicitHits += 1;
      else inferredHits += 1;
      matchedCapabilityLabels.push(match.label);
    } else if (req.isMandatory) {
      missingMandatoryRequirement = true;
    }
  }

  let resourceHits = 0;
  const matchedResourceLabels: string[] = [];
  for (const req of resourceReqs) {
    const match = resourceByNode.get(req.ontologyNodeId);
    if (match) {
      resourceHits += 1;
      matchedResourceLabels.push(match.label);
    } else if (req.isMandatory) {
      missingMandatoryRequirement = true;
    }
  }

  const explicitCapabilityMatch = capabilityReqs.length > 0 ? explicitHits / capabilityReqs.length : 0;
  const inferredCapabilityMatch = capabilityReqs.length > 0 ? inferredHits / capabilityReqs.length : 0;
  const resourceMatch = resourceReqs.length > 0 ? resourceHits / resourceReqs.length : 0;

  const requiredCapabilityReqs = capabilityReqs.filter((r) => r.requirementType === "required_capability");
  const hasExactCapability =
    requiredCapabilityReqs.length > 0 &&
    requiredCapabilityReqs.every((r) => capabilityByNode.get(r.ontologyNodeId)?.evidenceType === "explicit");
  const hasProbableFit = explicitHits + inferredHits + resourceHits > 0 && !hasExactCapability;

  return {
    explicitCapabilityMatch,
    inferredCapabilityMatch,
    resourceMatch,
    missingMandatoryRequirement,
    hasExactCapability,
    hasProbableFit,
    matchedCapabilityLabels,
    matchedResourceLabels,
  };
}
