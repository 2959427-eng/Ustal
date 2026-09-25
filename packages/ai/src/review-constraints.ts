import type { SemanticReview } from "@ustal/validation";
import { assertGroundedEvidence, EvidenceValidationError, sourceLeaves } from "./evidence-validation.js";

type Sources = { profile: string[]; order: string[] };
type NumericLimit = NonNullable<SemanticReview["numericLimits"]>[number];
const exclusive = /(?:\bonly\b|только|исключительно)/iu;
// "not only" / "не только" widens a scope instead of limiting it.
const exclusiveBoundary = /(?<!\bnot\s)\bonly\b|(?<!не\s)только|исключительно/iu;
const absence = /(?:\b(?:no|without|lack|cannot|can't)\b|\bnot\s+(?:have|hold|licensed)\b|нет|не\s+(?:имею|обладаю|получал|могу)|отсутствует)/iu;
const mandatory = /(?:\b(?:required|requires|must|mandatory|need)\b|требуется|требует|обязательн|необходим|нуж[ен])/iu;
const credential = /(?:\b(?:licen[cs]e|category|permit|certificate)\b|категори|водительск|удостоверени|лицензи|допуск|сертификат)/iu;
// Explicit single-trip / indivisible execution wording for total quantities.
const oneTrip = /(?:\b(?:one|single)\s+(?:trip|run|batch|load|go)\b|\bindivisibl|\bat once\b|за\s+один\s+(?:раз|рейс|заход)|одн(?:им|у)\s+(?:рейс|ходк|поездк|партие|раз)|единовременн|целиком|неделим)/iu;
const normalized = (text: string) => text.toLocaleLowerCase().replace(/\s+/gu, "");
// Closed spelling equivalence of the SAME unit; never converts between magnitudes.
const unitAliases: Record<string, string> = { m: "м", kg: "кг", g: "г", km: "км", wpm: "слов/мин", "words/min": "слов/мин" };
const canonicalUnit = (unit: string) => unitAliases[normalized(unit)] ?? normalized(unit);
const unitSpellings = (unit: string) => {
  const canonical = canonicalUnit(unit);
  return [canonical, ...Object.keys(unitAliases).filter(alias => unitAliases[alias] === canonical)];
};
const hasNumber = (text: string, value: number) =>
  [...text.matchAll(/\d+(?:[.,]\d+)?/gu)].some(match => Number(match[0].replace(",", ".")) === value);

function isHardNumeric(limit: NumericLimit, orderSources: string[]): boolean {
  if (limit.available === null || limit.required === null || limit.availableUnit === null || limit.requiredUnit === null) return false;
  if (canonicalUnit(limit.availableUnit) !== canonicalUnit(limit.requiredUnit) || !(limit.required > limit.available)) return false;
  // Units per time are rates by definition, whatever the model labelled them.
  const kind = limit.availableUnit.includes("/") || limit.requiredUnit.includes("/") ? "rate" : limit.limitKind;
  if (kind !== "total_quantity") return true;
  // A divisible total can be split into trips/batches unless the order explicitly forbids it.
  if (limit.wholeTaskEvidence === null) return false;
  assertGroundedEvidence(limit.wholeTaskEvidence, orderSources, "wholeTaskEvidence");
  return oneTrip.test(limit.wholeTaskEvidence);
}

/** Source-backed constraints take precedence over relevance; unknown is not incompatible. */
export function applyReviewConstraints(review: SemanticReview, sources: Sources): SemanticReview {
  const grounded = (pair: { profileEvidence: string; orderEvidence: string }) => {
    assertGroundedEvidence(pair.profileEvidence, sources.profile, "profileEvidence");
    assertGroundedEvidence(pair.orderEvidence, sources.order, "orderEvidence");
  };
  let conflict = review.hardConflict;
  let suppressed = false;
  if (conflict) {
    grounded(conflict);
    // Mentioning a credential does not assert that all other credentials are absent.
    if (conflict.kind === "eligibility" && credential.test(`${conflict.profileEvidence} ${conflict.orderEvidence}`) &&
        (!(exclusive.test(conflict.profileEvidence) || absence.test(conflict.profileEvidence)) ||
         !mandatory.test(`${conflict.orderEvidence} `))) { conflict = null; suppressed = true; }
  }
  for (const limit of review.numericLimits ?? []) {
    grounded(limit);
    for (const [value, unit, evidence] of [
      [limit.available, limit.availableUnit, limit.profileEvidence],
      [limit.required, limit.requiredUnit, limit.orderEvidence],
    ] as const) {
      if (value !== null && !hasNumber(evidence, value)) throw new EvidenceValidationError({field:"numericValue",evidence,sources:[evidence]}, "Numeric limit must occur in source evidence");
      if (unit !== null && !unitSpellings(unit).some(spelling => normalized(evidence).includes(spelling))) throw new EvidenceValidationError({field:"numericUnit",evidence,sources:[evidence]}, "Numeric unit must occur in source evidence");
    }
    if (!conflict && isHardNumeric(limit, sources.order)) {
      conflict = { kind: "numeric", profileEvidence: limit.profileEvidence, orderEvidence: limit.orderEvidence };
    }
  }
  const scope = review.exclusiveScope;
  if (scope) {
    grounded(scope);
    if (!scope.allowed.every(value => normalized(scope.profileEvidence).includes(normalized(value))) ||
        (scope.requested !== null && !normalized(scope.orderEvidence).includes(normalized(scope.requested)))) {
      throw new EvidenceValidationError({field:"exclusiveScope",evidence:scope.profileEvidence,sources:[scope.orderEvidence]}, "Exclusive scope identifiers must occur in source evidence");
    }
    // The server never compares identifiers across languages/synonyms; the reviewer states containment.
    if (!conflict && exclusiveBoundary.test(scope.profileEvidence) && scope.requested !== null && scope.requestedWithinAllowed === false) {
      conflict = { kind: "scope", profileEvidence: scope.profileEvidence, orderEvidence: scope.orderEvidence };
    }
  } else if (review.exclusiveScope === null) {
    // Omitted inventory: an explicit exclusive boundary in the profile must be assessed.
    const leaf = sources.profile.flatMap(sourceLeaves).find(value => exclusiveBoundary.test(value));
    if (leaf) throw new EvidenceValidationError({ field: "exclusiveScope", evidence: leaf, sources: sources.profile },
      "Profile states an exclusive boundary (only/только/исключительно) but exclusiveScope is null");
  }
  if (!conflict && review.compatible === false) {
    // A negative verdict must be source-grounded. A conflict removed as unproven cannot justify it.
    if (suppressed) return { ...review, hardConflict: null, compatible: true };
    throw new EvidenceValidationError({ field: "hardConflict", evidence: review.reason, sources: [] },
      "compatible=false requires a grounded hardConflict (use kind=domain for an unrelated domain)");
  }
  return { ...review, hardConflict: conflict, compatible: conflict ? false : review.compatible };
}
