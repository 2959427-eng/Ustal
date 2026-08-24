import type { MatchingWeights } from "@ustal/config";
import type { MatchType } from "@ustal/domain";

/**
 * Реализует формулу из docs/matching.md раздел 13.3. Каждый компонент — число
 * 0..1 (доля выполнения критерия), итог — 0..100. Инвариант, закреплённый
 * тестами: сигнатура функции физически не может принять поле, связанное
 * с оплатой — WHERE payment/price никогда не появится в этом модуле.
 */
export interface ScoringInput {
  explicitCapabilityMatch: number;
  inferredCapabilityMatch: number;
  resourceMatch: number;
  semanticSimilarity: number;
  similarCompletedWork: number;
  behavioralPreference: number;
  missingRequirement: boolean;
  negativePreference: boolean;
  riskFlag: boolean;
}

export interface ScoringResult {
  score: number; // 0..100
  breakdown: Record<string, number>;
}

export function computeScore(input: ScoringInput, weights: MatchingWeights): ScoringResult {
  const positive =
    input.explicitCapabilityMatch * weights.explicitCapabilityMatch +
    input.inferredCapabilityMatch * weights.inferredCapabilityMatch +
    input.resourceMatch * weights.resourceMatch +
    input.semanticSimilarity * weights.semanticSimilarity +
    input.similarCompletedWork * weights.similarCompletedWork +
    input.behavioralPreference * weights.behavioralPreference;

  let penalty = 0;
  if (input.missingRequirement) penalty += weights.missingRequirementPenalty;
  if (input.negativePreference) penalty += weights.negativePreferencePenalty;
  if (input.riskFlag) penalty += weights.riskPenalty;

  const score = Math.max(0, Math.min(100, Math.round((positive - penalty) * 100)));
  return {
    score,
    breakdown: {
      explicitCapabilityMatch: input.explicitCapabilityMatch * weights.explicitCapabilityMatch,
      inferredCapabilityMatch: input.inferredCapabilityMatch * weights.inferredCapabilityMatch,
      resourceMatch: input.resourceMatch * weights.resourceMatch,
      semanticSimilarity: input.semanticSimilarity * weights.semanticSimilarity,
      similarCompletedWork: input.similarCompletedWork * weights.similarCompletedWork,
      behavioralPreference: input.behavioralPreference * weights.behavioralPreference,
      penalty,
    },
  };
}

/**
 * Тип совпадения (docs/matching.md 13.4). isRegulatedAndUnverified блокирует
 * probable/new_opportunity — см. architecture.md п.7: в MVP ни один
 * пользователь не проходит верификацию, поэтому регулируемые задачи никогда
 * не классифицируются как probable/new_opportunity автоматически.
 */
export function classifyMatchType(input: {
  hasExactCapability: boolean;
  hasSimilarCompletedWork: boolean;
  hasProbableFit: boolean;
  isSimpleLowRiskUnregulated: boolean;
  isRegulatedAndUnverified: boolean;
}): MatchType | null {
  if (input.isRegulatedAndUnverified) return null; // -> manual_review, не рекомендуется вовсе
  if (input.hasExactCapability || input.hasSimilarCompletedWork) return "exact";
  if (input.hasProbableFit) return "probable";
  if (input.isSimpleLowRiskUnregulated) return "new_opportunity";
  return null;
}
