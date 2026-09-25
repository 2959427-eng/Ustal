export interface Fact {
  kind: string;
  phrase: string;
  nodeIds: string[];
  embedding?: number[] | null;
  mandatory: boolean;
  confidence: number;
  startHour?: number | null;
  endHour?: number | null;
  // ISO weekday numbering local to the order's city: 0=Mon..6=Sun. Null/absent = unspecified.
  daysOfWeek?: number[] | null;
  constraintType?: "none" | "availability" | "exclusion" | "scope";
  constraintScope?: "whole_task" | "fact" | "optional_component";
  resourceRole?: "none" | "available" | "required" | "provided_by_customer" | "missing" | "compatibility";
  resourceCapacity?: { value: number | null; unit: string | null; kind: string | null };
  resourceType?: 'vehicle' | 'tool' | 'equipment' | 'material' | 'property' | 'space' | 'audience' | 'digital_asset' | 'other' | null;
}
export interface Relation {
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
}
export const SEMANTIC_POLICY = {
  version: "semantic-score-v2.12",
  shortlist: 150,
  semanticMin: 0.78,
  exclusionMin: 0.8,
  mandatoryMin: 0.9,
  reviewAdmission: "unresolved-ordinary-actions-with-source",
  reviewConfidence: 0.9,
  weakOverlapReviewMaxSimilarity: 0.6,
  reviewLimit: 100,
};
export function cosine(a?: number[] | null, b?: number[] | null) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  const value = dot / Math.sqrt(aa * bb);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
const intersects = (a: string[], b: string[]) => a.some((id) => b.includes(id));
function related(
  candidate: string[],
  required: string[],
  relations: Relation[],
  allowReverse = false,
) {
  return relations.some(
    (r) =>
      ["supports", "is_a", "related"].includes(r.relationType) &&
      ((candidate.includes(r.fromNodeId) && required.includes(r.toNodeId)) ||
        (allowReverse &&
          r.relationType !== "supports" &&
          candidate.includes(r.toNodeId) &&
          required.includes(r.fromNodeId))),
  );
}
export interface SemanticDecision {
  score: number;
  classification: "exact" | "strong" | "probable" | "semantic-only" | "reject";
  matchType: "exact" | "probable" | null;
  reason: string;
  trace: Record<string, unknown>;
}

// Generic classification functions for resource types
// Based on semantic signals in nodeIds, not hardcoded values


export function evaluateSemantic(input: {
  capabilities: Fact[];
  requirements: Fact[];
  relations: Relation[];
  documentSimilarity: number;
  riskLevel: number;
  regulated: boolean;
  localHour?: number;
  // ISO weekday numbering local to the order's city: 0=Mon..6=Sun.
  localWeekday?: number;
  negativePreference?: boolean;
  reviewRequired?: boolean;
  // Reserved future signal (+5): matching-run.ts intentionally does NOT pass it yet.
  // Wiring it from completed order_assignments changes ranking -> requires holdout re-run.
  similarCompletedWork?: boolean;
  semanticReview?: { compatible: boolean; confidence: number; reason: string;
    hardConflict?: { kind: string; profileEvidence: string; orderEvidence: string } | null };
}): SemanticDecision {
  const caps = input.capabilities.filter(
    (f) => f.kind === "capability" && f.confidence >= 0.5,
  );
  const reqs = input.requirements.filter((f) => f.kind === "capability");
  // A resource fact tagged "missing" is an explicit negative signal (e.g. "no perforator,
  // only a drill") and must never satisfy a resource requirement, exactly like an exclusion.
  const resources = input.capabilities.filter(
    (f) => f.kind === "resource" &&
      f.resourceRole !== "missing" &&
      f.resourceRole !== "provided_by_customer" &&
      f.resourceRole !== "compatibility",
  );
  const resourceReqs = input.requirements.filter((f) => f.kind === "resource");
  const trace: Record<string, unknown> = {
    policy: SEMANTIC_POLICY.version,
    city_pass: true,
    semantic_similarity: input.documentSimilarity,
    availability: "unspecified",
    semantic_review: input.semanticReview ?? null,
  };
  const reject = (reason: string) => ({
    score: 0,
    classification: "reject" as const,
    matchType: null,
    reason,
    trace: { ...trace, reason },
  });
  // Source-grounded constraints are independent of the semantic relevance verdict.
  if (input.semanticReview?.hardConflict)
    return reject(`${input.semanticReview.hardConflict.kind}_mismatch`);
  const reviewedRelevant = input.semanticReview?.compatible === true;
  for (const exclusion of input.capabilities.filter(
    (f) =>
      (f.kind === "exclude" || f.constraintType === "exclusion") &&
      f.constraintScope !== "optional_component",
  )) {
    // Only hard-reject whole_task exclusions, not fact-scoped ones
    // Fact-scoped exclusions are soft signals (executor decides)
    const isWholeTaskExclusion = exclusion.constraintScope === "whole_task" || !exclusion.constraintScope;
    const matches = [...reqs, ...resourceReqs].some(
      (r) =>
        intersects(exclusion.nodeIds, r.nodeIds) ||
        related(r.nodeIds, exclusion.nodeIds, input.relations, true) ||
        cosine(exclusion.embedding, r.embedding) >=
          SEMANTIC_POLICY.exclusionMin,
    );
    
    if (matches && isWholeTaskExclusion) {
      return reject("explicit_exclusion");
    }
    
    if (matches && exclusion.constraintScope === "fact") {
      // Fact-scoped exclusion with semantic review override
      if (!input.semanticReview?.compatible || input.semanticReview.confidence < 0.8) {
        // Low confidence match: don't force rejection on fact-scoped exclusion
        // Treat as soft signal instead
      }
    }
  }
  const windows = input.capabilities.filter(
    (f) => f.kind === "availability" || f.constraintType === "availability" ||
      f.startHour != null || f.endHour != null,
  );
  if (windows.length) {
    const known = windows.filter(
      (f) => f.startHour != null || f.endHour != null,
    );
    const contains = (f: Fact, hour: number) => {
      const start = f.startHour ?? 0, end = f.endHour ?? 24;
      return start < end ? hour >= start && hour < end : hour >= start || hour < end;
    };
    trace.availability = "needs_confirmation";
    if (input.localHour != null && known.length) {
      const hour = input.localHour;
      const available = known.some((f) => contains(f, hour));
      if (!available) return reject("outside_availability");
      trace.availability = "compatible";
    } else if (known.length) {
      const requested = input.requirements.filter(
        (f) => f.startHour != null || f.endHour != null,
      );
      if (requested.length) {
        const hours = Array.from({ length: 24 }, (_, hour) => hour);
        const compatible = requested.every((r) => {
          const requestedHours = hours.filter((hour) => contains(r, hour));
          const available = (hour: number) => known.some((f) => contains(f, hour));
          return r.constraintScope === "whole_task"
            ? requestedHours.every(available)
            : requestedHours.some(available);
        });
        if (!compatible) return reject("outside_availability");
        trace.availability = "compatible";
      }
    }
  }
  // Day-of-week constraint (e.g. "only weekdays", "not on weekends"). Independent of the
  // hour-window gate above: both apply when both are stated. Priority over similarity, like
  // every other constraint in this function — evaluated before any scoring below.
  const dayWindows = input.capabilities.filter(
    (f) =>
      (f.kind === "availability" || f.constraintType === "availability") &&
      f.daysOfWeek != null &&
      f.daysOfWeek.length > 0,
  );
  if (dayWindows.length) {
    trace.availability_day = "needs_confirmation";
    if (input.localWeekday != null) {
      const available = dayWindows.some((f) => f.daysOfWeek!.includes(input.localWeekday!));
      if (!available) return reject("outside_availability");
      trace.availability_day = "compatible";
    } else {
      const requestedDays = input.requirements.filter(
        (f) =>
          (f.kind === "availability" || f.constraintType === "availability") &&
          f.daysOfWeek != null &&
          f.daysOfWeek.length > 0,
      );
      if (requestedDays.length) {
        const overlap = dayWindows.some((f) =>
          requestedDays.some((r) => r.daysOfWeek!.some((d) => f.daysOfWeek!.includes(d))),
        );
        if (!overlap) return reject("outside_availability");
        trace.availability_day = "compatible";
      }
    }
  }
  let exact = 0,
    relatedHits = 0,
    semanticSum = 0,
    missingMandatoryCapability = false;
  for (const req of reqs) {
    const direct = caps.some((c) => intersects(c.nodeIds, req.nodeIds));
    const near = caps.some((c) =>
      related(c.nodeIds, req.nodeIds, input.relations, true),
    );
    const semantic = Math.max(
      0,
      ...caps.map((c) => cosine(c.embedding, req.embedding)),
    );
    if (req.mandatory && !direct && !near) missingMandatoryCapability = true;
    if (direct) exact++;
    else if (near) relatedHits++;
    semanticSum += semantic;
  }
  let resourceHits = 0;
  let kindMismatches = 0;
  let capacityMismatches = 0;
  let physicalReviewRequired = false;
  let unknownResourceSemanticHits = 0;
  let unknownResourceUnverified = 0;
  for (const req of resourceReqs) {
    if (req.resourceRole === "compatibility") {
      // This is suitability of execution, not proof the executor owns an asset. Workload
      // and access cannot be compared as asset capacities (e.g. floor vs metres).
      if (req.constraintScope !== "optional_component") physicalReviewRequired = true;
      continue;
    }
    // Resource unknown to the ontology (no canonical node): absence of a node is not an
    // objective incompatibility, so it can never cause missing_mandatory_resource by itself.
    // Compare phrase embeddings instead: a confident match counts as a resource hit; an
    // explicit, equally confident "missing" fact is an objective incompatibility; anything
    // else is a soft, unverified signal and the executor decides.
    if (!req.nodeIds.length && req.resourceRole !== "provided_by_customer") {
      const similarity = (facts: Fact[]) =>
        Math.max(0, ...facts.map((r) => cosine(r.embedding, req.embedding)));
      const explicitlyMissing = input.capabilities.filter(
        (f) => f.kind === "resource" && f.resourceRole === "missing",
      );
      const required = req.mandatory || req.resourceRole === "required";
      if (required && similarity(explicitlyMissing) >= SEMANTIC_POLICY.semanticMin)
        return reject("missing_mandatory_resource");
      if (similarity(resources) >= SEMANTIC_POLICY.semanticMin) {
        unknownResourceSemanticHits++;
        resourceHits++;
      } else unknownResourceUnverified++;
      continue;
    }
    // Resources are concrete assets: whole-profile similarity can never prove ownership.
    const required = req.mandatory || req.resourceRole === "required";
    const provided = req.resourceRole === "provided_by_customer";
    
    // CLASSIFICATION: Determine if this is physical resource or method/capability
    // Physical resources (hard reject on specific kind mismatch):
    //   vehicle, transport, tool, equipment, capacity, access, building, etc.
    // Method/capability types (soft signal on specific kind mismatch):
    //   Explicit methods: welding-method, testing-method, programming-language,
    //   specialization, approach, technique, expertise, etc.
    // Determine if this is a physical or method/capability resource using resourceType
    // Physical resources (hard reject on specific kind mismatch): vehicle, tool, equipment, property, space
    // Non-physical types (soft signal): audience, digital_asset, material, other
    const physicalResourceTypes = ['vehicle', 'tool', 'equipment', 'property', 'space'];
    const isPhysical = req.resourceType ? physicalResourceTypes.includes(req.resourceType) : false;
    // Methods/capabilities are kind="capability", not kind="resource", so isExplicitMethod is always false here
    const isExplicitMethod = false;
    
    const requiredCapacity = req.resourceCapacity;
    const requiresSpecificKind = requiredCapacity?.kind != null;

    
    const hit = resources.some((r) => {
      const sameResource =
        intersects(r.nodeIds, req.nodeIds) ||
        related(r.nodeIds, req.nodeIds, input.relations);
      if (!sameResource) return false;
      
      const availableCapacity = r.resourceCapacity;
      
      // Exact match: same kind and capacity
      const kindMatches = !requiredCapacity?.kind || !availableCapacity?.kind ||
        requiredCapacity.kind === availableCapacity.kind;
      
      // Check capacity matching (if specified)
      let capacityMatches = true;
      if (requiredCapacity?.value && requiredCapacity.value > 0) {
        capacityMatches =
          availableCapacity?.value != null &&
          availableCapacity.value >= requiredCapacity.value &&
          availableCapacity.unit === requiredCapacity.unit;
      }
      
      // Objective incompatibility of a known physical resource (e.g. motorcycle vs
      // required automobile, drill vs required perforator) is decided on kind alone and
      // must not be masked by a capacity mismatch evaluated in the same comparison.
      if (!kindMatches && required && requiresSpecificKind && isPhysical && !isExplicitMethod) {
        return false;  // Hard reject: physical resource specific kind requirement not met
      }
      
      // Capacity mismatch: soft signal by default (executor can make multiple trips,
      // negotiate unit, use different equipment, etc. -- MVP policy favors MATCH over
      // rejection, and absence of an explicit constraint is never treated as a prohibition).
      // The one objective exception (product policy: hard reject only for an explicit
      // constraint or an objective resource incompatibility) is an explicit one-trip/
      // whole-task requirement that insufficient capacity cannot satisfy at all -- reusing
      // constraintScope="whole_task" (already used the same way for exclusions above: "this
      // applies to the whole task, not just a narrow/partial part of it") rather than
      // inventing a new field. A missing/other constraintScope never triggers this branch.
      if (!capacityMatches) {
        if (required && req.constraintScope === "whole_task") {
          return false; // hard: this resource cannot satisfy a one-trip/whole-task requirement
        }
        capacityMismatches++;
      }
      
      // SOFT SIGNAL: kind mismatch of a method/non-physical/optional resource
      // (e.g. OS Linux vs Windows, welding method TIG vs MMA): executor decides.
      if (!kindMatches) kindMismatches++;
      return true;
    });
    
    if (!hit && required && !provided) {
      return reject("missing_mandatory_resource");
    }
    if (hit) resourceHits++;
  }
  const exactCoverage = reqs.length ? exact / reqs.length : 0;
  const relatedCoverage = reqs.length ? relatedHits / reqs.length : 0;
  // Missing phrase vectors may use the positive-only document, but never override hard gates.
  const semantic = Math.max(
    reqs.length ? semanticSum / reqs.length : 0,
    caps.length ? input.documentSimilarity : 0,
    // A confirmed resource-only match does not need capability evidence.
    !reqs.length && !caps.length && resourceHits > 0 ? 1 : 0,
  );
  Object.assign(trace, {
    exact_capability: exactCoverage,
    related_capability: relatedCoverage,
    semantic_similarity: semantic,
    resource_match: resourceHits,
    resource_kind_mismatches: kindMismatches,
    resource_capacity_mismatches: capacityMismatches,
    unknown_resource_semantic_hits: unknownResourceSemanticHits,
    unknown_resource_unverified: unknownResourceUnverified,
    missing_mandatory_capability: missingMandatoryCapability,
    semantic_review: input.semanticReview ?? null,
    physical_review_required: physicalReviewRequired,
    safety_review_required: Boolean(input.reviewRequired || input.riskLevel > 0),
  });
  if ((physicalReviewRequired || input.reviewRequired || input.riskLevel > 0) &&
      !reviewedRelevant) {
    return reject(physicalReviewRequired ? "physical_compatibility_unverified" : "safety_review_required");
  }
  // Source review can discover an explicit scope/refusal lost by broad ontology mapping.
  // A confident negative judgment must beat even an exact canonical match.
  if (input.semanticReview?.compatible === false &&
      input.semanticReview.confidence >= SEMANTIC_POLICY.reviewConfidence)
    return reject("source_incompatibility");
  const weakOverlap =
    input.documentSimilarity < SEMANTIC_POLICY.weakOverlapReviewMaxSimilarity &&
    exactCoverage < 1 &&
    (exactCoverage > 0 || relatedCoverage > 0);
  if (
    input.reviewRequired &&
    !reviewedRelevant
  )
    return reject("insufficient_capability_evidence");
  if (
    weakOverlap &&
    !reviewedRelevant
  )
    return reject("insufficient_capability_evidence");
  let classification: "exact" | "strong" | "probable" | "semantic-only";
  if (exactCoverage === 1) classification = "exact";
  else if (exactCoverage + relatedCoverage >= 0.5) classification = "strong";
  else if (exactCoverage > 0 || relatedCoverage > 0)
    classification = "probable";
  else if (
    (semantic >= SEMANTIC_POLICY.semanticMin ||
      reviewedRelevant) &&
    // A profile with zero capability facts can still qualify here when its suitability was
    // established purely through a confirmed resource requirement (e.g. "есть газель с
    // гидробортом" with no separate capability sentence) -- caps.length alone must not be
    // the only door in, or a resource-only profile can never reach a positive classification.
    // The common real shape is a "compatibility" resource requirement (physicalReviewRequired),
    // not a "required" one, so it never increments resourceHits at all: if physicalReviewRequired
    // was true, reaching this point already proves semanticReview passed the earlier hard gate
    // above, so it is a safe, equally-narrow door in alongside resourceHits.
    (caps.length || resourceHits > 0 || physicalReviewRequired || input.requirements.some(r => r.kind === "resource"))
  )
    classification = "semantic-only";
  else return reject("insufficient_capability_evidence");
  const score = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        Math.max(
          80 * exactCoverage + 60 * relatedCoverage,
          classification === "semantic-only" || semantic >= SEMANTIC_POLICY.semanticMin ? semantic * 60 : 0,
        ) +
          Math.min(10, resourceHits * 10) +
          (trace.availability === "compatible" ? 5 : 0) +
          (input.similarCompletedWork ? 5 : 0) -
          (input.negativePreference ? 20 : 0) -
          (kindMismatches > 0 ? 5 : 0),  // Soft penalty only for soft signal mismatches
      ),
    ),
  );
  return {
    score,
    classification,
    matchType:
      classification === "exact" ? ("exact" as const) : ("probable" as const),
    reason: classification,
    trace: { ...trace, final_score: score, match_type: classification },
  };
}
