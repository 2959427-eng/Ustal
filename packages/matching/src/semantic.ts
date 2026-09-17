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
}
export interface Relation {
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
}
export const SEMANTIC_POLICY = {
  version: "semantic-score-v2.9",
  shortlist: 150,
  semanticMin: 0.78,
  exclusionMin: 0.8,
  mandatoryMin: 0.9,
  reviewAdmission: "unresolved-ordinary-actions-with-source",
  reviewConfidence: 0.9,
  weakOverlapReviewMaxSimilarity: 0.6,
  reviewLimit: 20,
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
  similarCompletedWork?: boolean;
  semanticReview?: { compatible: boolean; confidence: number; reason: string };
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
  };
  const reject = (reason: string) => ({
    score: 0,
    classification: "reject" as const,
    matchType: null,
    reason,
    trace: { ...trace, reason },
  });
  trace.regulated_unverified = input.regulated;
  for (const exclusion of input.capabilities.filter(
    (f) =>
      (f.kind === "exclude" || f.constraintType === "exclusion") &&
      f.constraintScope !== "optional_component",
  )) {
    if (
      reqs.some(
        (r) =>
          intersects(exclusion.nodeIds, r.nodeIds) ||
          related(r.nodeIds, exclusion.nodeIds, input.relations, true) ||
          cosine(exclusion.embedding, r.embedding) >=
            SEMANTIC_POLICY.exclusionMin,
      )
    )
      return reject("explicit_exclusion");
  }
  if (input.regulated) return reject("regulated_unverified");
  const windows = input.capabilities.filter(
    (f) => f.kind === "availability" || f.constraintType === "availability",
  );
  if (windows.length) {
    const known = windows.filter(
      (f) => f.startHour != null && f.endHour != null,
    );
    trace.availability = "needs_confirmation";
    if (input.localHour != null && known.length) {
      const hour = input.localHour;
      const available = known.some((f) =>
        f.startHour! < f.endHour!
          ? hour >= f.startHour! && hour < f.endHour!
          : hour >= f.startHour! || hour < f.endHour!,
      );
      if (!available) return reject("outside_availability");
      trace.availability = "compatible";
    } else if (known.length) {
      const requested = input.requirements.filter(
        (f) =>
          (f.kind === "availability" || f.constraintType === "availability") &&
          f.startHour != null &&
          f.endHour != null,
      );
      if (requested.length) {
        const contains = (f: Fact, hour: number) =>
          f.startHour! < f.endHour!
            ? hour >= f.startHour! && hour < f.endHour!
            : hour >= f.startHour! || hour < f.endHour!;
        const overlap = Array.from({ length: 24 }, (_, hour) => hour).some(
          (hour) => known.some((f) => contains(f, hour)) && requested.some((f) => contains(f, hour)),
        );
        if (!overlap) return reject("outside_availability");
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
  let physicalReviewRequired = false;
  for (const req of resourceReqs) {
    if (req.resourceRole === "compatibility") {
      // This is suitability of execution, not proof the executor owns an asset. Workload
      // and access cannot be compared as asset capacities (e.g. floor vs metres).
      if (req.constraintScope !== "optional_component") physicalReviewRequired = true;
      continue;
    }
    // Resources are concrete assets: whole-profile similarity can never prove ownership.
    const required = req.mandatory || req.resourceRole === "required";
    const provided = req.resourceRole === "provided_by_customer";
    const hit = resources.some((r) => {
      const sameResource =
        intersects(r.nodeIds, req.nodeIds) ||
        related(r.nodeIds, req.nodeIds, input.relations);
      if (!sameResource) return false;
      const requiredCapacity = req.resourceCapacity;
      const availableCapacity = r.resourceCapacity;
      // A stated subtype/kind (e.g. required "perforator" vs available "drill") is a
      // mismatch on its own, independent of whether either side also carries a numeric
      // value — this must not be skipped just because there is no quantity to compare.
      if (
        requiredCapacity?.kind &&
        availableCapacity?.kind &&
        requiredCapacity.kind !== availableCapacity.kind
      )
        return false;
      if (!requiredCapacity?.value || requiredCapacity.value <= 0) return true;
      return (
        availableCapacity?.value != null &&
        availableCapacity.value >= requiredCapacity.value &&
        availableCapacity.unit === requiredCapacity.unit
      );
    });
    if (!hit && required && !provided) return reject("missing_mandatory_resource");
    if (hit) resourceHits++;
  }
  const exactCoverage = reqs.length ? exact / reqs.length : 0;
  const relatedCoverage = reqs.length ? relatedHits / reqs.length : 0;
  // Missing phrase vectors may use the positive-only document, but never override hard gates.
  const semantic = Math.max(
    reqs.length ? semanticSum / reqs.length : 0,
    caps.length ? input.documentSimilarity : 0,
  );
  Object.assign(trace, {
    exact_capability: exactCoverage,
    related_capability: relatedCoverage,
    semantic_similarity: semantic,
    resource_match: resourceHits,
    missing_mandatory_capability: missingMandatoryCapability,
    semantic_review: input.semanticReview ?? null,
    physical_review_required: physicalReviewRequired,
    safety_review_required: Boolean(input.reviewRequired || input.riskLevel > 0),
  });
  if ((physicalReviewRequired || input.reviewRequired || input.riskLevel > 0) &&
      (!input.semanticReview?.compatible || input.semanticReview.confidence < SEMANTIC_POLICY.reviewConfidence)) {
    return reject(physicalReviewRequired ? "physical_compatibility_unverified" : "safety_review_required");
  }
  const weakOverlap =
    input.documentSimilarity < SEMANTIC_POLICY.weakOverlapReviewMaxSimilarity &&
    exactCoverage < 1 &&
    (exactCoverage > 0 || relatedCoverage > 0);
  if (
    input.reviewRequired &&
    (!input.semanticReview?.compatible ||
      input.semanticReview.confidence < SEMANTIC_POLICY.reviewConfidence)
  )
    return reject("insufficient_capability_evidence");
  if (
    weakOverlap &&
    (!input.semanticReview ||
      !input.semanticReview.compatible ||
      input.semanticReview.confidence < SEMANTIC_POLICY.reviewConfidence)
  )
    return reject("insufficient_capability_evidence");
  let classification: "exact" | "strong" | "probable" | "semantic-only";
  if (exactCoverage === 1) classification = "exact";
  else if (exactCoverage + relatedCoverage >= 0.5) classification = "strong";
  else if (exactCoverage > 0 || relatedCoverage > 0)
    classification = "probable";
  else if (
    (semantic >= SEMANTIC_POLICY.semanticMin ||
      (input.semanticReview?.compatible &&
        input.semanticReview.confidence >= SEMANTIC_POLICY.reviewConfidence)) &&
    caps.length
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
          (input.negativePreference ? 20 : 0),
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
