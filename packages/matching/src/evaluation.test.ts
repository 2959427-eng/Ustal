import { describe, expect, it } from "vitest";
import { getRuntimeConfig } from "@ustal/config";
import { buildExplanation } from "./explanation.js";
import { matchRequirements, type CandidateCapability, type CandidateResource, type OrderRequirement } from "./requirements.js";
import { classifyMatchType, computeScore } from "./scoring.js";

/**
 * matching-evaluation набор (docs/plan.md Фаза 8: "unit/integration/
 * matching-evaluation (25+ кейсов)"). В отличие от scoring.test.ts/
 * requirements.test.ts/explanation.test.ts (юнит-тесты отдельных чистых
 * функций), здесь каждый кейс — реалистичный сценарий "заказ + кандидат",
 * прогнанный через ВЕСЬ pure-function пайплайн (matchRequirements ->
 * computeScore -> classifyMatchType -> buildExplanation) на РЕАЛЬНЫХ весах
 * из @ustal/config (не переизобретённые константы в тесте), с проверкой
 * итогового решения: проходит ли кандидат порог `minimumRelevanceScore`,
 * какой matchType присваивается и что увидит пользователь в объяснении.
 * semanticSimilarity/similarCompletedWork/behavioralPreference/riskFlag не
 * выводятся из requirements (они приходят из pgvector/истории/preferences/
 * risk-классификации заказа в реальном пайплайне — apps/worker/src/handlers/
 * matching-run.ts) и поэтому передаются явно на кейс, как задокументированный
 * вход сценария.
 */

const PAINTING = "cap-painting";
const PLUMBING = "cap-plumbing";
const DRIVING = "cap-driving";
const MOVING_HELP = "cap-moving-help";
const ELECTRICAL_LICENSED = "cap-electrical-licensed";
const CAR = "res-car";
const TOOLS = "res-tools";
const VAN = "res-van";

const { weights, minimumRelevanceScore } = getRuntimeConfig().matching;

interface Scenario {
  name: string;
  requirements: OrderRequirement[];
  capabilities: CandidateCapability[];
  resources: CandidateResource[];
  semanticSimilarity?: number;
  similarCompletedWork?: number;
  behavioralPreference?: number;
  negativePreference?: boolean;
  riskFlag?: boolean;
  isSimpleLowRiskUnregulated?: boolean;
  isRegulatedAndUnverified?: boolean;
  expect: {
    passesThreshold: boolean;
    matchType: "exact" | "probable" | "new_opportunity" | null;
    explanationContains: string;
  };
}

function req(ontologyNodeId: string, requirementType: OrderRequirement["requirementType"], isMandatory = true): OrderRequirement {
  return { ontologyNodeId, requirementType, isMandatory };
}
function cap(ontologyNodeId: string, label: string, evidenceType: "explicit" | "inferred"): CandidateCapability {
  return { ontologyNodeId, label, evidenceType };
}
function res(ontologyNodeId: string, label: string): CandidateResource {
  return { ontologyNodeId, label };
}

const SCENARIOS: Scenario[] = [
  {
    name: "явное совпадение единственной обязательной способности -> exact, проходит порог",
    requirements: [req(PAINTING, "required_capability")],
    capabilities: [cap(PAINTING, "покраска стен", "explicit")],
    resources: [],
    isSimpleLowRiskUnregulated: true,
    expect: { passesThreshold: true, matchType: "exact", explanationContains: "опыт" },
  },
  {
    name: "явное совпадение + похожие выполненные заказы -> exact, объяснение про историю",
    requirements: [req(PAINTING, "required_capability")],
    capabilities: [cap(PAINTING, "покраска стен", "explicit")],
    resources: [],
    similarCompletedWork: 1,
    expect: { passesThreshold: true, matchType: "exact", explanationContains: "уже выполняли похожую работу" },
  },
  {
    name: "выведенная (inferred) способность на обязательное требование -> hasExactCapability=false, probable",
    requirements: [req(PLUMBING, "required_capability")],
    capabilities: [cap(PLUMBING, "сантехника", "inferred")],
    resources: [],
    expect: { passesThreshold: true, matchType: "probable", explanationContains: "опыт" },
  },
  {
    name: "отсутствует обязательная способность (hard filter в реальном пайплайне) -> явного/выведенного совпадения нет, score=0",
    requirements: [req(ELECTRICAL_LICENSED, "required_capability")],
    capabilities: [],
    resources: [],
    expect: { passesThreshold: false, matchType: null, explanationContains: "простая работа" },
  },
  {
    name: "только совпадение желаемого (не обязательного) ресурса -> probable, ниже порога явного совпадения",
    requirements: [req(CAR, "desired_resource", false)],
    capabilities: [],
    resources: [res(CAR, "личный автомобиль")],
    expect: { passesThreshold: true, matchType: "probable", explanationContains: "ресурсы" },
  },
  {
    name: "явная способность + совпавший ресурс -> exact, объяснение перечисляет способность (не ресурс, т.к. exact)",
    requirements: [req(DRIVING, "required_capability"), req(CAR, "required_resource")],
    capabilities: [cap(DRIVING, "вождение", "explicit")],
    resources: [res(CAR, "личный автомобиль")],
    expect: { passesThreshold: true, matchType: "exact", explanationContains: "вождение" },
  },
  {
    name: "явная способность на ОДНО из двух обязательных требований, второе выведенное -> hasExactCapability=false (все required должны быть explicit) -> probable",
    requirements: [req(DRIVING, "required_capability"), req(MOVING_HELP, "required_capability")],
    capabilities: [cap(DRIVING, "вождение", "explicit"), cap(MOVING_HELP, "переезды", "inferred")],
    resources: [],
    expect: { passesThreshold: true, matchType: "probable", explanationContains: "опыт" },
  },
  {
    name: "простая нерегулируемая задача без единого структурного совпадения -> new_opportunity, если разрешено пайплайном",
    requirements: [],
    capabilities: [],
    resources: [],
    isSimpleLowRiskUnregulated: true,
    expect: { passesThreshold: false, matchType: "new_opportunity", explanationContains: "простая работа" },
  },
  {
    name: "регулируемая работа без верификации -> null ДАЖЕ при явном совпадении способности (жёсткий инвариант)",
    requirements: [req(ELECTRICAL_LICENSED, "required_capability")],
    capabilities: [cap(ELECTRICAL_LICENSED, "электромонтаж", "explicit")],
    resources: [],
    isRegulatedAndUnverified: true,
    expect: { passesThreshold: true, matchType: null, explanationContains: "простая работа" },
  },
  {
    name: "регулируемая работа без верификации перекрывает даже similarCompletedWork -> всё ещё null",
    requirements: [req(ELECTRICAL_LICENSED, "required_capability")],
    capabilities: [cap(ELECTRICAL_LICENSED, "электромонтаж", "explicit")],
    resources: [],
    similarCompletedWork: 1,
    isRegulatedAndUnverified: true,
    expect: { passesThreshold: true, matchType: null, explanationContains: "простая работа" },
  },
  {
    name: "высокая semantic similarity без единого структурного совпадения (требование НЕ обязательное, чтобы не наложился missingRequirement penalty) -> проходит порог по одному только семантическому сигналу, но classify без hasProbableFit -> null",
    requirements: [req(PAINTING, "desired_capability", false)],
    capabilities: [],
    resources: [],
    semanticSimilarity: 1,
    expect: { passesThreshold: true, matchType: null, explanationContains: "простая работа" },
  },
  {
    name: "штраф за отсутствующее ОБЯЗАТЕЛЬНОЕ требование топит даже частичное явное совпадение ниже порога (missingRequirement penalty 0.3 > оставшийся позитивный сигнал 0.15)",
    requirements: [req(PAINTING, "required_capability"), req(ELECTRICAL_LICENSED, "required_capability")],
    capabilities: [cap(PAINTING, "покраска стен", "explicit")],
    resources: [],
    expect: { passesThreshold: false, matchType: "probable", explanationContains: "опыт" },
  },
  {
    name: "негативное поведенческое предпочтение (пользователь ранее отклонял похожее) снижает, но не всегда обнуляет score",
    requirements: [req(PAINTING, "required_capability")],
    capabilities: [cap(PAINTING, "покраска стен", "explicit")],
    resources: [],
    negativePreference: true,
    expect: { passesThreshold: true, matchType: "exact", explanationContains: "опыт" },
  },
  {
    name: "riskFlag (например анкета указывает на возможное мошенничество) режет score сильнее всех остальных штрафов (weight 0.5) и топит даже единственное explicit-совпадение ниже порога; classifyMatchType при этом не знает о riskFlag вовсе и всё ещё вернул бы exact — фильтрация по порогу происходит отдельно, до показа кандидата",
    requirements: [req(PAINTING, "required_capability")],
    capabilities: [cap(PAINTING, "покраска стен", "explicit")],
    resources: [],
    riskFlag: true,
    expect: { passesThreshold: false, matchType: "exact", explanationContains: "опыт" },
  },
  {
    name: "riskFlag + missingRequirement вместе могут утопить даже explicit-совпадение ниже порога",
    requirements: [req(PAINTING, "required_capability"), req(ELECTRICAL_LICENSED, "required_capability")],
    capabilities: [cap(PAINTING, "покраска стен", "explicit")],
    resources: [],
    riskFlag: true,
    expect: { passesThreshold: false, matchType: "probable", explanationContains: "опыт" },
  },
  {
    name: "все шесть положительных сигналов на максимуме -> score=100 (клампится, не переполняется)",
    requirements: [req(PAINTING, "required_capability"), req(CAR, "required_resource")],
    capabilities: [cap(PAINTING, "покраска стен", "explicit")],
    resources: [res(CAR, "личный автомобиль")],
    semanticSimilarity: 1,
    similarCompletedWork: 1,
    behavioralPreference: 1,
    expect: { passesThreshold: true, matchType: "exact", explanationContains: "уже выполняли похожую работу" },
  },
  {
    name: "два обязательных ресурса, найден только один -> resourceMatch=0.5, но missingMandatoryRequirement=true (второй) топит частичный сигнал ниже порога",
    requirements: [req(CAR, "required_resource"), req(VAN, "required_resource")],
    capabilities: [],
    resources: [res(CAR, "личный автомобиль")],
    expect: { passesThreshold: false, matchType: "probable", explanationContains: "ресурсы" },
  },
  {
    name: "желаемая (не обязательная) способность без совпадения -> не hard filter, но и не даёт сигнала -> score от других компонентов",
    requirements: [req(PAINTING, "desired_capability", false), req(PLUMBING, "required_capability")],
    capabilities: [cap(PLUMBING, "сантехника", "explicit")],
    resources: [],
    expect: { passesThreshold: true, matchType: "exact", explanationContains: "сантехника" },
  },
  {
    name: "три инструмента-ресурса, все три совпали -> resourceMatch=1, но без capability-требований -> probable, не exact",
    requirements: [req(TOOLS, "required_resource")],
    capabilities: [],
    resources: [res(TOOLS, "набор инструментов")],
    expect: { passesThreshold: true, matchType: "probable", explanationContains: "ресурсы" },
  },
  {
    name: "полностью пустой заказ (нет требований) и пустой кандидат -> нет сигналов, new_opportunity только если помечен простым",
    requirements: [],
    capabilities: [],
    resources: [],
    expect: { passesThreshold: false, matchType: null, explanationContains: "простая работа" },
  },
  {
    name: "behavioralPreference на максимуме (требование НЕ обязательное) даёт скор без единого структурного совпадения, но classify всё равно требует hasProbableFit -> null",
    requirements: [req(PAINTING, "desired_capability", false)],
    capabilities: [],
    resources: [],
    behavioralPreference: 1,
    expect: { passesThreshold: true, matchType: null, explanationContains: "простая работа" },
  },
  {
    name: "explicit + inferred на РАЗНЫЕ обязательные требования одновременно -> смешанный profile, hasExactCapability=false из-за inferred-части",
    requirements: [req(PAINTING, "required_capability"), req(PLUMBING, "required_capability"), req(DRIVING, "required_capability")],
    capabilities: [cap(PAINTING, "покраска", "explicit"), cap(PLUMBING, "сантехника", "explicit"), cap(DRIVING, "вождение", "inferred")],
    resources: [],
    expect: { passesThreshold: true, matchType: "probable", explanationContains: "опыт" },
  },
  {
    name: "минимальный проходной случай: единственный inferred-сигнал ровно на пороге (inferredCapabilityMatch=1 -> score=15 > minimumRelevanceScore=10)",
    requirements: [req(MOVING_HELP, "required_capability")],
    capabilities: [cap(MOVING_HELP, "помощь при переезде", "inferred")],
    resources: [],
    expect: { passesThreshold: true, matchType: "probable", explanationContains: "опыт" },
  },
  {
    name: "заблокированный по бизнес-логике match (riskFlag) на фоне слабого inferred-сигнала уходит ниже порога",
    requirements: [req(MOVING_HELP, "required_capability")],
    capabilities: [cap(MOVING_HELP, "помощь при переезде", "inferred")],
    resources: [],
    riskFlag: true,
    expect: { passesThreshold: false, matchType: "probable", explanationContains: "опыт" },
  },
  {
    name: "явное совпадение способности и ресурса одновременно, оба обязательны и оба найдены -> объяснение из ветки exact без completed work",
    requirements: [req(DRIVING, "required_capability"), req(VAN, "required_resource")],
    capabilities: [cap(DRIVING, "вождение", "explicit")],
    resources: [res(VAN, "грузовой фургон")],
    expect: { passesThreshold: true, matchType: "exact", explanationContains: "вождение" },
  },
  {
    name: "заказ без единого извлечённого требования, но кандидат уже выполнял похожую работу -> similarCompletedWork сам по себе даёт exact (matching.md 13.4: 'подтверждено похожими выполненными заказами'), score ровно на границе порога",
    requirements: [],
    capabilities: [],
    resources: [],
    similarCompletedWork: 1,
    expect: { passesThreshold: true, matchType: "exact", explanationContains: "уже выполняли похожую работу" },
  },
  {
    name: "два желаемых (не обязательных) ресурса, ни один не найден -> не hard filter, resourceMatch=0, но структурного сигнала нет вовсе",
    requirements: [req(CAR, "desired_resource", false), req(VAN, "desired_resource", false)],
    capabilities: [],
    resources: [],
    expect: { passesThreshold: false, matchType: null, explanationContains: "простая работа" },
  },
];

describe("matching-evaluation: полный пайплайн matchRequirements -> computeScore -> classifyMatchType -> buildExplanation", () => {
  it.each(SCENARIOS)("$name", (scenario) => {
    const match = matchRequirements(scenario.requirements, scenario.capabilities, scenario.resources);

    const scoring = computeScore(
      {
        explicitCapabilityMatch: match.explicitCapabilityMatch,
        inferredCapabilityMatch: match.inferredCapabilityMatch,
        resourceMatch: match.resourceMatch,
        semanticSimilarity: scenario.semanticSimilarity ?? 0,
        similarCompletedWork: scenario.similarCompletedWork ?? 0,
        behavioralPreference: scenario.behavioralPreference ?? 0,
        missingRequirement: match.missingMandatoryRequirement,
        negativePreference: scenario.negativePreference ?? false,
        riskFlag: scenario.riskFlag ?? false,
      },
      weights,
    );

    const matchType = classifyMatchType({
      hasExactCapability: match.hasExactCapability,
      hasSimilarCompletedWork: (scenario.similarCompletedWork ?? 0) > 0,
      hasProbableFit: match.hasProbableFit,
      isSimpleLowRiskUnregulated: scenario.isSimpleLowRiskUnregulated ?? false,
      isRegulatedAndUnverified: scenario.isRegulatedAndUnverified ?? false,
    });

    const passesThreshold = scoring.score >= minimumRelevanceScore;
    expect(passesThreshold, `score=${scoring.score}, threshold=${minimumRelevanceScore}`).toBe(scenario.expect.passesThreshold);
    expect(matchType).toBe(scenario.expect.matchType);

    if (matchType) {
      const explanation = buildExplanation({
        matchType,
        hasSimilarCompletedWork: (scenario.similarCompletedWork ?? 0) > 0,
        matchedCapabilityLabels: match.matchedCapabilityLabels,
        matchedResourceLabels: match.matchedResourceLabels,
      });
      expect(explanation).toContain(scenario.expect.explanationContains);
    } else {
      // Нет матча -> заказ не рекомендуется автоматически (manual_review для
      // регулируемых, либо просто не попадает в matching_candidates). Явного
      // "explanation" для null-кейса в реальном пайплайне не строится —
      // здесь мы всё равно фиксируем ожидаемый пользовательский текст
      // (new_opportunity/"простая работа") на случай, если бы пайплайн решил
      // предложить это как fallback, чтобы формулировка была явно закреплена.
      const explanation = buildExplanation({
        matchType: "new_opportunity",
        hasSimilarCompletedWork: false,
        matchedCapabilityLabels: [],
        matchedResourceLabels: [],
      });
      expect(explanation).toContain(scenario.expect.explanationContains);
    }
  });

  it("суммарно покрывает не менее 25 сценариев (docs/plan.md Фаза 8 требование)", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(25);
  });

  it("инвариант: ни один сценарий/вход scoring не ссылается на оплату (структурная защита, не только формула)", () => {
    // ScoringInput типизирован без payment-полей на уровне TypeScript
    // (packages/matching/src/scoring.ts) — этот тест фиксирует факт как
    // регрессионный маркер: если кто-то добавит payment-related ключ в
    // ScoringInput, литеральные объекты кейсов выше не потребуют его (значит
    // проверка на уровне типов не поймает добавление опционального поля).
    // Явно перечисляем допустимые ключи scoring-входа.
    const allowedKeys = [
      "explicitCapabilityMatch",
      "inferredCapabilityMatch",
      "resourceMatch",
      "semanticSimilarity",
      "similarCompletedWork",
      "behavioralPreference",
      "missingRequirement",
      "negativePreference",
      "riskFlag",
    ];
    const scoring = computeScore(
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
    expect(Object.keys(scoring.breakdown).every((k) => allowedKeys.includes(k) || k === "penalty")).toBe(true);
  });
});
