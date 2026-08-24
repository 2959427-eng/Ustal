import type { MatchType } from "@ustal/domain";

/**
 * Человекочитаемое объяснение совпадения (matching.md 13.4). Никакого
 * chain-of-thought, сырых векторов или технических вычислений — только
 * готовые шаблоны на основе уже посчитанных структурных данных.
 */
export function buildExplanation(input: {
  matchType: MatchType;
  hasSimilarCompletedWork: boolean;
  matchedCapabilityLabels: string[];
  matchedResourceLabels: string[];
}): string {
  const { matchType, hasSimilarCompletedWork, matchedCapabilityLabels, matchedResourceLabels } = input;

  if (matchType === "exact") {
    if (hasSimilarCompletedWork) return "Вы уже выполняли похожую работу";
    if (matchedCapabilityLabels.length > 0) {
      return `У вас есть подходящий опыт: ${matchedCapabilityLabels.join(", ")}`;
    }
    return "У вас есть подходящий опыт для этой задачи";
  }

  if (matchType === "probable") {
    const parts: string[] = [];
    if (matchedCapabilityLabels.length > 0) parts.push(`опыт (${matchedCapabilityLabels.join(", ")})`);
    if (matchedResourceLabels.length > 0) parts.push(`ресурсы (${matchedResourceLabels.join(", ")})`);
    if (parts.length > 0) return `Похоже, подходит: ваш(и) ${parts.join(" и ")}`;
    return "Ваши способности и ресурсы частично подходят для этой задачи";
  }

  // new_opportunity
  return "Это простая работа без специальной квалификации — доступна каждому";
}
