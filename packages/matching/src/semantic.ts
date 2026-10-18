export interface Fact {
  kind: string;
  phrase: string;
  evidence?: string;
  nodeIds: string[];
  embedding?: number[] | null;
  mandatory: boolean;
  confidence: number;
  startHour?: number | null;
  endHour?: number | null;
  // ISO weekday numbering local to the order's city: 0=Mon..6=Sun. Null/absent = unspecified.
  daysOfWeek?: number[] | null;
  constraintType?: "none" | "availability" | "exclusion" | "scope" | "lift";
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
/**
 * A refusal or limit bounded in time ("не занимаюсь доставкой после 22:00") is a time limit for
 * that activity, never a refusal of the activity at every hour (2026-10-06).
 */
export function isTimeLimited(f: { startHour?: number | null; endHour?: number | null; daysOfWeek?: number[] | null }): boolean {
  // Only an actual time window counts: constraintType alone is a model label and is also used for
  // non-time limits (e.g. «работа на высоте до 10 м» typed as availability).
  return f.startHour != null || f.endHour != null || !!f.daysOfWeek?.length;
}
/**
 * A profile time window applies to ALL work only when it is a person-level availability fact
 * (kind=availability, constraintScope other than "fact"). A window attached to an activity
 * (availability with constraintScope="fact", or a capability/refusal carrying hours) limits only
 * that activity. A time-bounded refusal is never widened to all work.
 */
export function isActivityScopedWindow(f: Fact): boolean {
  return f.kind !== "availability" || f.constraintScope === "fact";
}
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
  // The source review was required but failed technically (timeout, provider error, malformed or
  // ungrounded output). Unknown is not incompatible: review-only gates are waived (fail-open for
  // recall), but this is never counted as a positive review and never cancels an independent hard rule.
  reviewUnavailable?: boolean;
  // Internal: the source review DID complete (its conflict was set aside as a lifted/inapplicable restriction).
  // Distinguishes that from a technical failure for the scope gate; every other rule treats it like reviewUnavailable.
  reviewCompleted?: boolean;
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
  // Activity-scoped windows apply only when the order is that activity (same/related node or
  // the same meaning at the exclusion threshold); global windows apply to every order.
  const orderTasks = [...reqs, ...resourceReqs];
  const inActivityDomain = (f: Fact) => orderTasks.some(
    (r) =>
      intersects(f.nodeIds, r.nodeIds) ||
      related(r.nodeIds, f.nodeIds, input.relations, true) ||
      cosine(f.embedding, r.embedding) >= SEMANTIC_POLICY.exclusionMin,
  );
  // A source-review conflict that quotes only an activity-scoped time limit which does not apply
  // to this order's activity («не занимаюсь доставкой после 22:00» vs repair after 23:00) is not a
  // restriction of this work. The review is then treated as unavailable (fail-open for recall, never
  // counted as a positive review); every deterministic rule still applies.
  const conflict = input.semanticReview?.hardConflict;
  if (conflict && !input.reviewUnavailable) {
    const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const quoted = norm(conflict.profileEvidence);
    // Evidence spans are whole messages, so the quote alone does not identify the limit: the conflict
    // must be a numeric one that quotes this limit's own hour (a «только iOS» or «до 10 м» conflict
    // from the same message is never ignored).
    const quotesHour = (f: Fact) => [f.startHour, f.endHour].some((h) => h != null && conflict.profileEvidence.includes(String(h)));
    const fromInapplicableLimit = conflict.kind === "numeric" && quoted.length > 0 && input.capabilities.some(
      (f) => isTimeLimited(f) && isActivityScopedWindow(f) && !!f.evidence &&
        norm(f.evidence).includes(quoted) && quotesHour(f) && !inActivityDomain(f),
    );
    // A conflict that quotes only a restriction the user later lifted himself (inert kind="superseded"
    // history fact written by the profile pipeline) is not a current restriction — unless a live
    // restriction of the same area still applies to this order.
    const liftedArea = (f: Fact) =>
      f.kind === "superseded" && f.resourceCapacity?.kind?.startsWith("lifted:") ? f.resourceCapacity.kind.slice(7) : null;
    const areasFor: Record<string, string[]> = { numeric: ["time_global", "time_activity"], exclusion: ["work"], scope: ["scope"] };
    const liveArea = (f: Fact): string | null => {
      if (f.kind === "superseded") return null;
      if (isTimeLimited(f)) return isActivityScopedWindow(f) ? "time_activity" : "time_global";
      if (f.constraintType === "scope") return "scope";
      if (f.kind === "exclude" || f.constraintType === "exclusion") return "work";
      return null;
    };
    const fromLiftedRestriction = quoted.length > 0 && input.capabilities.some((m) => {
      const area = liftedArea(m);
      if (!area || !m.evidence || !(areasFor[conflict.kind] ?? []).includes(area)) return false;
      if (!norm(m.evidence).includes(quoted)) return false;
      const hour = m.resourceCapacity?.value;
      if (area.startsWith("time") && hour != null && !conflict.profileEvidence.includes(String(hour))) return false;
      if (area !== "time_global" && !inActivityDomain(m)) return false;
      return !input.capabilities.some((f) => liveArea(f) === area && (area === "time_global" || inActivityDomain(f)));
    });
    // The user's own lift statement («теперь работаю после 22:00», «делаю и Android»), recorded even when
    // the earlier limit was never a separate fact: a conflict of that area for this activity no longer
    // stands while no live restriction of that area applies. A time conflict must quote a time.
    const quotesTime = /\d{1,2}[:.]\d{2}|\d{1,2}\s*ч/u.test(conflict.profileEvidence);
    const liftAreas: Record<string, { kinds: string[]; live: string[]; global: boolean }> = {
      lift_work_scope: { kinds: ["exclusion", "scope", "numeric"], live: ["work", "scope", "time_activity"], global: false },
      lift_time_activity: { kinds: ["numeric"], live: ["time_activity"], global: false },
      lift_time_global: { kinds: ["numeric"], live: ["time_global"], global: true },
    };
    // The lift statement names what the order asks for («делаю и Android» ↔ «Android-приложение»):
    // a shared content word (crude 5-letter stem) ties the lift to this order when no node maps it.
    const STOP = new Set(["теперь", "работ", "делаю", "делат", "заним", "нужно", "нужен", "нужна", "сдела", "после", "тольк", "также"]);
    const stems = (t: string) => new Set((t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).map((w) => w.slice(0, 5)).filter((w) => !STOP.has(w)));
    const namesOrder = (m: Fact) => { const a = stems(m.evidence ?? ""); return [...stems(conflict.orderEvidence)].some((w) => a.has(w)); };
    const fromUserLift = quoted.length > 0 && input.capabilities.some((m) => {
      const lift = liftAreas[liftedArea(m) ?? ""];
      if (!lift || !lift.kinds.includes(conflict.kind)) return false;
      if (conflict.kind === "numeric" && !quotesTime) return false;
      if (!lift.global && !inActivityDomain(m) && !namesOrder(m)) return false;
      return !input.capabilities.some((f) => lift.live.includes(liveArea(f) ?? "") && (lift.global || inActivityDomain(f)));
    });
    if (fromInapplicableLimit || fromLiftedRestriction || fromUserLift) {
      const decision = evaluateSemantic({ ...input, semanticReview: undefined, reviewUnavailable: true, reviewCompleted: true });
      return { ...decision, trace: { ...decision.trace, semantic_review: input.semanticReview,
        review_conflict_ignored: fromInapplicableLimit ? "inapplicable_activity_time_limit" : "restriction_lifted_by_user" } };
    }
  }
  const trace: Record<string, unknown> = {
    policy: SEMANTIC_POLICY.version,
    city_pass: true,
    semantic_similarity: input.documentSimilarity,
    availability: "unspecified",
    semantic_review: input.semanticReview ?? null,
    ...(input.reviewUnavailable ? { review_unverified: true } : {}),
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
      f.constraintScope !== "optional_component" &&
      // Time-bounded refusals are checked as activity time windows below, not as a total refusal.
      !isTimeLimited(f),
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
  // Each window group must be satisfied on its own: a scoped limit narrows, never widens availability.
  const allWindows = input.capabilities.filter(
    (f) => f.kind === "availability" || f.constraintType === "availability" ||
      f.startHour != null || f.endHour != null,
  );
  const scopedWindows = allWindows.filter(isActivityScopedWindow);
  const applicableScoped = scopedWindows.filter(inActivityDomain);
  if (scopedWindows.length) {
    trace.availability_scoped_applied = applicableScoped.length;
    trace.availability_scoped_not_applicable = scopedWindows.length - applicableScoped.length;
  }
  const windowGroups = [allWindows.filter((f) => !isActivityScopedWindow(f)), applicableScoped]
    .filter((g) => g.length);
  for (const windows of windowGroups) {
    const known = windows.filter(
      (f) => f.startHour != null || f.endHour != null,
    );
    const contains = (f: Fact, hour: number) => {
      const start = f.startHour ?? 0, end = f.endHour ?? 24;
      // A point in time ("в 18:00" -> 18..18) is that hour, not a wrap-around over the whole day.
      if (start === end) return hour === start;
      return start < end ? hour >= start && hour < end : hour >= start || hour < end;
    };
    if (trace.availability !== "compatible") trace.availability = "needs_confirmation";
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
  const allDayWindows = input.capabilities.filter(
    (f) =>
      (f.kind === "availability" || f.constraintType === "availability" || f.kind === "exclude") &&
      f.daysOfWeek != null &&
      f.daysOfWeek.length > 0,
  );
  const dayWindowGroups = [
    allDayWindows.filter((f) => !isActivityScopedWindow(f)),
    allDayWindows.filter((f) => isActivityScopedWindow(f) && inActivityDomain(f)),
  ].filter((g) => g.length);
  for (const dayWindows of dayWindowGroups) {
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
  // Mandatory resource the profile is silent about / capacity not comparable: unverified, not missing.
  let mandatoryResourceUnverified = 0;
  let capacityUnverified = 0;
  // Explicit "нет X" in the profile (resourceRole=missing) matching this requirement by node or meaning.
  const explicitlyMissing = (req: Fact) => input.capabilities.some((f) =>
    f.kind === "resource" && f.resourceRole === "missing" &&
    (intersects(f.nodeIds, req.nodeIds) || related(f.nodeIds, req.nodeIds, input.relations, true) ||
      cosine(f.embedding, req.embedding) >= SEMANTIC_POLICY.semanticMin));
  const unit = (u: string | null | undefined) => (u ?? "").trim().toLowerCase().replace(/\.$/u, "");
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
    // The same resource is owned but provably unsuitable (known kind mismatch / known whole-task shortfall).
    let provenIncompatible = false;

    const hit = resources.some((r) => {
      const sameResource =
        intersects(r.nodeIds, req.nodeIds) ||
        related(r.nodeIds, req.nodeIds, input.relations);
      if (!sameResource) return false;
      
      const availableCapacity = r.resourceCapacity;
      
      // Exact match: same kind and capacity
      const kindMatches = !requiredCapacity?.kind || !availableCapacity?.kind ||
        requiredCapacity.kind === availableCapacity.kind;
      
      // Check capacity matching (if specified). Only known values in the same unit can prove a
      // shortfall; an unknown value/unit or different units is unverified, not incompatible.
      let capacityMatches = true;
      if (requiredCapacity?.value && requiredCapacity.value > 0) {
        const comparable = availableCapacity?.value != null && unit(availableCapacity.unit) !== "" &&
          unit(availableCapacity.unit) === unit(requiredCapacity.unit);
        if (!comparable) capacityUnverified++;
        else capacityMatches = availableCapacity!.value! >= requiredCapacity.value;
      }
      
      // Objective incompatibility of a known physical resource (e.g. motorcycle vs
      // required automobile, drill vs required perforator) is decided on kind alone and
      // must not be masked by a capacity mismatch evaluated in the same comparison.
      if (!kindMatches && required && requiresSpecificKind && isPhysical && !isExplicitMethod) {
        provenIncompatible = true;
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
          provenIncompatible = true;
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
      // Hard only when proven: explicit absence or an owned resource that objectively cannot do it.
      // A profile that simply does not mention the resource is unverified -> the source review decides.
      if (provenIncompatible || explicitlyMissing(req)) return reject("missing_mandatory_resource");
      mandatoryResourceUnverified++;
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
    mandatory_resource_unverified: mandatoryResourceUnverified,
    resource_capacity_unverified: capacityUnverified,
    missing_mandatory_capability: missingMandatoryCapability,
    semantic_review: input.semanticReview ?? null,
    physical_review_required: physicalReviewRequired,
    safety_review_required: Boolean(input.reviewRequired || input.riskLevel > 0),
  });
  // Active scope restriction («беру только X-заказы»), Codex audit 2026-10-18: a deterministic hard gate, after every
  // other hard rule. An order inside the scope (same node, related node or same meaning) passes; one outside it is
  // cleared only by a COMPLETED source review, whose verdict then decides exactly as before — never by a technical
  // review failure (reviewUnavailable) or by the absence of a review. Generic for any scope, not tied to a domain.
  if (input.semanticReview == null && !input.reviewCompleted) {
    for (const scope of input.capabilities.filter((f) => f.constraintType === "scope" && f.kind !== "superseded")) {
      const inside = orderTasks.some((r) =>
        intersects(scope.nodeIds, r.nodeIds) ||
        related(r.nodeIds, scope.nodeIds, input.relations, true) ||
        cosine(scope.embedding, r.embedding) >= SEMANTIC_POLICY.exclusionMin);
      if (!inside) return reject("scope_unverified");
    }
  }
  const resourceReviewRequired = physicalReviewRequired || mandatoryResourceUnverified > 0;
  if ((resourceReviewRequired || input.reviewRequired || input.riskLevel > 0) &&
      !reviewedRelevant && !input.reviewUnavailable) {
    return reject(resourceReviewRequired ? "physical_compatibility_unverified" : "safety_review_required");
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
    !reviewedRelevant && !input.reviewUnavailable
  )
    return reject("insufficient_capability_evidence");
  if (
    weakOverlap &&
    !reviewedRelevant && !input.reviewUnavailable
  )
    return reject("insufficient_capability_evidence");
  let classification: "exact" | "strong" | "probable" | "semantic-only";
  // An unverified mandatory resource never yields "exact" ("у вас есть подходящие навыки" would overstate).
  if (exactCoverage === 1 && mandatoryResourceUnverified === 0) classification = "exact";
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
    (caps.length || resourceHits > 0 || resourceReviewRequired || input.requirements.some(r => r.kind === "resource"))
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
