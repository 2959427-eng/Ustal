import { cosine, SEMANTIC_POLICY } from "@ustal/matching";

/**
 * Отрицательная информация в AI-профиле исполнителя («продал машину», «больше не работаю
 * таксистом») должна переопределять старую положительную. Общие правила, не под конкретный
 * ресурс/навык:
 *
 * - Отрицательный факт: kind="exclude" / constraintType="exclusion" (отказ от навыка/работы)
 *   или ресурс с resourceRole="missing" (явное отсутствие ресурса).
 * - Конфликт: отказ ↔ навык, «нет ресурса» ↔ ресурс; одинаковый ontology-узел ИЛИ смысловая
 *   близость фраз (cosine ≥ SEMANTIC_POLICY.exclusionMin — тот же порог, что matching
 *   использует для отказов). Так же работает и для фраз без ontology-узла.
 * - Кто новее, тот и прав: позиция evidence в накопительном тексте профиля (новое изменение
 *   пользователя дописывается в конец). При равенстве побеждает отрицательный факт.
 *   Поэтому «продал машину» убирает старую «есть машина», а более позднее «купил машину снова»
 *   возвращает её.
 * - Ресурсы с ролями missing / provided_by_customer / compatibility — не активы исполнителя:
 *   в user_resources не пишутся никогда (остаются только фактами-ограничениями для matching).
 */
export interface ProfileFactLike {
  kind: string;
  phrase: string;
  evidence?: string;
  nodeIds: string[];
  resourceRole?: string | null;
  constraintType?: string | null;
  embedding?: number[] | null;
}

const NON_ASSET_RESOURCE_ROLES = new Set(["missing", "provided_by_customer", "compatibility"]);

/** Можно ли записать ресурсный факт как ресурс пользователя (user_resources). */
export function isUserAssetResource(f: Pick<ProfileFactLike, "kind" | "resourceRole">): boolean {
  return f.kind === "resource" && !NON_ASSET_RESOURCE_ROLES.has(f.resourceRole ?? "none");
}

const isCapabilityRefusal = (f: ProfileFactLike) => f.kind === "exclude" || f.constraintType === "exclusion";
const isMissingResource = (f: ProfileFactLike) => f.kind === "resource" && f.resourceRole === "missing";
export const isNegativeFact = (f: ProfileFactLike) => isCapabilityRefusal(f) || isMissingResource(f);
const isPositiveCapability = (f: ProfileFactLike) => f.kind === "capability" && !isCapabilityRefusal(f);
const isPositiveResource = (f: ProfileFactLike) => isUserAssetResource(f);

function conflicts(negative: ProfileFactLike, positive: ProfileFactLike): boolean {
  const pairOk =
    (isCapabilityRefusal(negative) && isPositiveCapability(positive)) ||
    (isMissingResource(negative) && isPositiveResource(positive));
  if (!pairOk) return false;
  if (negative.nodeIds.some((id) => positive.nodeIds.includes(id))) return true;
  return cosine(negative.embedding, positive.embedding) >= SEMANTIC_POLICY.exclusionMin;
}

const position = (f: ProfileFactLike, sourceText: string) => {
  const i = f.evidence ? sourceText.lastIndexOf(f.evidence) : -1;
  return i < 0 ? 0 : i;
};

/**
 * Разрешает противоречия внутри одного профильного документа: из пары «положительный ↔
 * отрицательный» остаётся более новый факт (при равенстве — отрицательный).
 */
export function resolveProfileNegatives<T extends ProfileFactLike>(facts: T[], sourceText: string): T[] {
  const drop = new Set<number>();
  facts.forEach((neg, ni) => {
    if (!isNegativeFact(neg)) return;
    facts.forEach((pos, pi) => {
      if (ni === pi || !conflicts(neg, pos)) return;
      if (position(neg, sourceText) >= position(pos, sourceText)) drop.add(pi);
      else drop.add(ni);
    });
  });
  return facts.filter((_, i) => !drop.has(i));
}

/**
 * Отказ от узкой деятельности («больше не работаю таксистом») не должен привязываться к
 * широкому навыку («вождение») — иначе он удаляет навык и блокирует смежные заказы
 * (грузоперевозки, перегон авто). Узел отказа сохраняется, только если:
 * - фраза отказа прямо называет этот узел (название/ключ/синоним), или
 * - это узкая деятельность: action-узел без дочерних узлов.
 * Иначе отказ остаётся фразой без узла и работает только по смыслу (embedding).
 * Отказы/неумение самого общего навыка («не умею водить» → «вождение») называют узел прямо
 * и сохраняются.
 */
export function narrowRefusalNodeIds(
  phraseNodeId: string | undefined,
  nodeIds: string[],
  node: (id: string) => { nodeType: string; hasChildren: boolean } | undefined,
): string[] {
  return nodeIds.filter((id) => {
    if (id === phraseNodeId) return true;
    const n = node(id);
    return !!n && n.nodeType === "action" && !n.hasChildren;
  });
}

/**
 * Узлы прежнего применённого профиля, которые текущие отрицательные факты отменяют
 * (прежний профиль всегда старше — отрицание побеждает). Используется, чтобы старый навык/
 * ресурс не переносился накопительным правилом (carry-forward) в новую версию.
 *
 * Конфликт только по смыслу (без общего узла) отменяет конкретную прежнюю фразу, а не весь
 * узел: если тот же узел подтверждён другой, не отменённой фразой («умею водить» рядом с
 * отменённым «подрабатываю таксистом»), узел сохраняется, а его подпись берётся из
 * неотменённой фразы (relabel).
 */
export function planNegativeOverrides(
  currentFacts: ProfileFactLike[],
  priorFacts: ProfileFactLike[],
): { excludedNodeIds: Set<string>; supersededLabels: Set<string>; relabel: Map<string, string> } {
  const excludedNodeIds = new Set<string>();
  const cancelled = new Set<ProfileFactLike>();
  const negatives = currentFacts.filter(isNegativeFact);
  for (const neg of negatives) {
    for (const id of neg.nodeIds) excludedNodeIds.add(id);
    for (const prior of priorFacts) if (conflicts(neg, prior)) cancelled.add(prior);
  }
  const survivors = priorFacts.filter((p) => !cancelled.has(p) && !isNegativeFact(p));
  const relabel = new Map<string, string>();
  for (const prior of cancelled)
    for (const id of prior.nodeIds) {
      const other = survivors.find((q) => q.nodeIds.includes(id));
      if (other) relabel.set(id, other.phrase);
      else excludedNodeIds.add(id);
    }
  const supersededLabels = new Set([...cancelled].map((p) => p.phrase.trim().toLowerCase()));
  return { excludedNodeIds, supersededLabels, relabel };
}

/** Совместимость: только множество исключённых узлов. */
export function supersededNodeIds(currentFacts: ProfileFactLike[], priorFacts: ProfileFactLike[]): Set<string> {
  return planNegativeOverrides(currentFacts, priorFacts).excludedNodeIds;
}

/**
 * Карьерный контекст профиля (собственный поиск работы: желаемая должность/зарплата, «работу активно
 * не ищу», готовность к релокации/командировкам) не ограничивает сервисные заказы. Факт-ограничение
 * (exclude / availability / constraintType != none), который нормализация пометила subjectType=
 * career_context, отбрасывается до ontology mapping: иначе «не готов к переезду в другой город»
 * превращался в отказ от узла «переезд» и отсекал заказы на переезд. Позитивные факты не трогаем;
 * исходный текст остаётся в sourceText и доступен source review. Заказы не затрагиваются.
 */
export function dropCareerContext<T extends { subjectType?: string; kind: string; constraintType: string }>(kind: "profile" | "order", facts: T[]): T[] {
  return kind === "profile"
    ? facts.filter((f) => !(f.subjectType === "career_context" &&
        (f.kind === "exclude" || f.kind === "availability" || f.constraintType !== "none")))
    : facts;
}
