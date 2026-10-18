import { cosine, isTimeLimited, SEMANTIC_POLICY } from "@ustal/matching";
import { normalizeProfileItemIdentity } from "@ustal/domain";

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
  startHour?: number | null;
  endHour?: number | null;
  daysOfWeek?: number[] | null;
  constraintScope?: string | null;
  resourceCapacity?: { value: number | null; unit: string | null; kind: string | null } | null;
  refusalIntent?: "revoke" | "restriction" | null;
}

/**
 * Отзыв навыка (2026-10-06). Отказ от деятельности, которая уже есть в профиле навыком, бывает двух видов:
 * - revoke («не хочу больше копать», «убери копание») — навык убирается из активного профиля; сам отказ
 *   остаётся историей и защитой matching (заказ только на этот навык не подбирается), но в разделе
 *   «Ограничения» не показывается — пользователь убрал навык, а не добавил условие;
 * - restriction («умею, но пока не беру», «холодильники больше не ремонтирую» при общем ремонте) — навык
 *   остаётся, отказ — ограничение.
 * Вид определяет нормализация (refusalIntent) по смыслу всего профиля; без явного revoke навык не удаляется.
 */
export const REVOKED_CAPABILITY = "revoked";
export const isRevokedCapability = (f: Pick<ProfileFactLike, "resourceCapacity">) => f.resourceCapacity?.kind === REVOKED_CAPABILITY;
const revokes = (f: ProfileFactLike) => f.refusalIntent === "revoke";

const NON_ASSET_RESOURCE_ROLES = new Set(["missing", "provided_by_customer", "compatibility"]);

/** Можно ли записать ресурсный факт как ресурс пользователя (user_resources). */
export function isUserAssetResource(f: Pick<ProfileFactLike, "kind" | "resourceRole">): boolean {
  return f.kind === "resource" && !NON_ASSET_RESOURCE_ROLES.has(f.resourceRole ?? "none");
}

// «Не занимаюсь доставкой после 22:00» — ограничение времени для доставки, а не отказ от доставки:
// такой факт не отменяет навык и не переносится как отказ (2026-10-06).
const isCapabilityRefusal = (f: ProfileFactLike) =>
  (f.kind === "exclude" || f.constraintType === "exclusion") &&
  !isTimeLimited(f);
const isMissingResource = (f: ProfileFactLike) => f.kind === "resource" && f.resourceRole === "missing";
export const isNegativeFact = (f: ProfileFactLike) => isCapabilityRefusal(f) || isMissingResource(f);
const isPositiveCapability = (f: ProfileFactLike) => f.kind === "capability" && !isCapabilityRefusal(f);
const isPositiveResource = (f: ProfileFactLike) => isUserAssetResource(f);

// Слова владения в подписи ресурса («есть машина», «у меня своя дрель») — не название предмета.
const POSSESSION = new Set(["есть", "имеется", "имею", "меня", "мой", "моя", "моё", "мое", "мои", "свой", "своя", "своё", "свое", "свои", "собственный", "собственная"]);
const itemTokens = (phrase: string) =>
  (normalizeProfileItemIdentity(phrase).match(/[a-zа-я0-9]+/g) ?? []).filter((t) => t.length >= 3 && !POSSESSION.has(t));
// Одно слово в разных падежах: «кофемашину» = «кофемашина», «генератора» = «генератор»; «машина» ≠ «кофемашина».
const sameWord = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= Math.max(4, Math.min(a.length, b.length) - 2);
};
const covers = (inner: string[], outer: string[]) => inner.length > 0 && inner.every((t) => outer.some((o) => sameWord(t, o)));
/**
 * Тот же предмет по названию (2026-10-12). Сравнение по смыслу для коротких названий ненадёжно
 * («кофемашина» ↔ «Есть Кофемашина» — cosine 0.47 при пороге 0.8), поэтому «продал генератор» / «убери
 * кофемашину из ресурсов» не отменяли ресурс, и модель возвращала его из прежнего текста. Совпадение:
 * название отсутствующего ресурса целиком входит в подпись имеющегося, или (для короткой фразы «Генератор я
 * продал», не больше 3 слов) подпись имеющегося целиком входит в неё.
 */
export function sameResourceItem(missingPhrase: string, ownedPhrase: string): boolean {
  const identity = normalizeProfileItemIdentity(missingPhrase);
  if (identity && identity === normalizeProfileItemIdentity(ownedPhrase)) return true;
  const missing = itemTokens(missingPhrase), owned = itemTokens(ownedPhrase);
  return covers(missing, owned) || (missing.length <= 3 && covers(owned, missing));
}

function conflicts(negative: ProfileFactLike, positive: ProfileFactLike): boolean {
  const pairOk =
    (isCapabilityRefusal(negative) && isPositiveCapability(positive)) ||
    (isMissingResource(negative) && isPositiveResource(positive));
  if (!pairOk) return false;
  if (negative.nodeIds.some((id) => positive.nodeIds.includes(id))) return true;
  if (isMissingResource(negative) && sameResourceItem(negative.phrase, positive.phrase)) return true;
  return cosine(negative.embedding, positive.embedding) >= SEMANTIC_POLICY.exclusionMin;
}

/**
 * Ресурсы без ontology-узла («самолёт», «кофемашина») живут только в фактах документа профиля: перенос
 * user_resources их не касается. Если модель не повторила такой ресурс в новом ответе, он пропадал из профиля.
 * Прежний имеющийся ресурс без узла переносится, если в текущих фактах нет того же предмета и он не отменён
 * текущим «нет ресурса» / «продал» / «убери из ресурсов» (2026-10-12).
 */
export function unmappedResourcesToCarry<T extends ProfileFactLike>(currentFacts: ProfileFactLike[], priorFacts: T[]): T[] {
  const missing = currentFacts.filter(isMissingResource);
  // Любой текущий факт о том же предмете (модель могла вернуть его и не ресурсом) — не дублируем.
  const present = currentFacts.filter((f) => f.kind === "resource" || f.kind === "capability");
  const seen = new Set<string>();
  return priorFacts.filter((p) =>
    isPositiveResource(p) && !p.nodeIds.length &&
    !present.some((c) => sameResourceItem(c.phrase, p.phrase) || sameResourceItem(p.phrase, c.phrase)) &&
    !missing.some((m) => conflicts(m, p))).filter((p) => {
      const identity = normalizeProfileItemIdentity(p.phrase);
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    });
}

/**
 * Порядок факта в профиле. При обновлении по одному сообщению (2026-10-13) он задан явно: прежнее состояние
 * профиля старше любого факта нового сообщения (messageOrder). Иначе — позиция evidence в накопительном тексте.
 */
export interface MessageOrder { seg: number; pos: number }
const position = (f: ProfileFactLike & { messageOrder?: MessageOrder }, sourceText: string) => {
  if (f.messageOrder) return f.messageOrder.pos;
  const i = f.evidence ? sourceText.lastIndexOf(f.evidence) : -1;
  return i < 0 ? 0 : i;
};

/**
 * Разрешает противоречия внутри одного профильного документа: из пары «положительный ↔
 * отрицательный» остаётся более новый факт (при равенстве — отрицательный).
 */
export function resolveProfileNegatives<T extends ProfileFactLike>(facts: T[], sourceText: string): T[] {
  const drop = new Set<number>();
  const revoked = new Set<number>();
  const sameActivity = new Set<number>();
  facts.forEach((neg, ni) => {
    if (!isNegativeFact(neg)) return;
    facts.forEach((pos, pi) => {
      if (ni === pi || !conflicts(neg, pos)) return;
      // Более новое положительное («снова беру заказы на копку») снимает прежний отказ.
      if (position(neg, sourceText) < position(pos, sourceText)) return void drop.add(ni);
      if (isMissingResource(neg) || revokes(neg)) {
        drop.add(pi);
        if (!isMissingResource(neg)) revoked.add(ni);
      } else if (neg.nodeIds.some((id) => pos.nodeIds.includes(id))) sameActivity.add(ni);
      // restriction: навык остаётся, отказ — ограничение.
    });
  });
  // Факты меняются на месте: вызывающий код сравнивает результат с исходным списком по ссылке.
  // Отказ от той же деятельности, что и навык профиля, — отказ от таких заказов целиком, а не от части
  // задачи: иначе рядом с навыком на том же узле он был бы только мягким сигналом.
  revoked.forEach((i) => Object.assign(facts[i]!, { kind: "exclude", constraintScope: "whole_task",
    resourceCapacity: { value: null, unit: null, kind: REVOKED_CAPABILITY } }));
  sameActivity.forEach((i) => { if (!revoked.has(i)) Object.assign(facts[i]!, { kind: "exclude", constraintScope: "whole_task" }); });
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
  // Прежний навык отменяют только отсутствие ресурса и явный отзыв навыка; ограничение его не трогает.
  const negatives = currentFacts.filter((f) => isMissingResource(f) || (isCapabilityRefusal(f) && revokes(f)));
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
  const supersededLabels = new Set([...cancelled].map((p) => normalizeProfileItemIdentity(p.phrase)));
  return { excludedNodeIds, supersededLabels, relabel };
}

/**
 * Отказ сверяется и с навыками прежнего применённого профиля (модель часто не повторяет отозванный навык в
 * новом ответе — тогда он убирается переносом, planNegativeOverrides), так же, как resolveProfileNegatives
 * сверяет его с навыками текущего текста (2026-10-06):
 * - явный отзыв прежнего навыка помечается как отозванный навык (whole_task): в «Ограничениях» не показывается;
 * - ограничение деятельности, которая есть навыком (тот же ontology-узел), — отказ от таких заказов целиком
 *   (whole_task): навык переносится в новую версию, и рядом с ним fact-scoped отказ был бы только мягким
 *   сигналом — заказ подбирался бы по навыку.
 */
export function scopeRefusalsOfPriorSkills(currentFacts: ProfileFactLike[], priorFacts: ProfileFactLike[]): void {
  const priorSkills = priorFacts.filter(isPositiveCapability);
  for (const f of currentFacts) {
    if (!isCapabilityRefusal(f) || f.constraintScope === "optional_component" || isRevokedCapability(f)) continue;
    if (revokes(f) && priorSkills.some((p) => conflicts(f, p)))
      Object.assign(f, { kind: "exclude", constraintScope: "whole_task", resourceCapacity: { value: null, unit: null, kind: REVOKED_CAPABILITY } });
    else if (priorSkills.some((p) => f.nodeIds.some((id) => p.nodeIds.includes(id))))
      Object.assign(f, { kind: "exclude", constraintScope: "whole_task" });
  }
}

/**
 * Повторный отказ от уже отозванного навыка («Больше не копаю» после «Не хочу больше копать») — тот же
 * отзыв, а не новое ограничение: помечается так же и в «Ограничениях» не показывается (2026-10-13).
 */
export function inheritRevokes(added: ProfileFactLike[], priorFacts: ProfileFactLike[]): void {
  const revoked = priorFacts.filter(isRevokedCapability);
  for (const f of added)
    if (isCapabilityRefusal(f) && !isRevokedCapability(f) && f.constraintScope !== "optional_component" &&
      revoked.some((r) => r.nodeIds.some((id) => f.nodeIds.includes(id)) ||
        cosine(r.embedding, f.embedding) >= SEMANTIC_POLICY.exclusionMin))
      Object.assign(f, { kind: "exclude", constraintScope: "whole_task", resourceCapacity: { value: null, unit: null, kind: REVOKED_CAPABILITY } });
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
 * Снятие ограничения (constraintType="lift") не отбрасывается: оно ничего не ограничивает, только
 * снимает прежнее (2026-10-06).
 */
export function dropCareerContext<T extends { subjectType?: string; kind: string; constraintType: string; startHour?: number | null; endHour?: number | null; daysOfWeek?: number[] | null }>(kind: "profile" | "order", facts: T[]): T[] {
  // Конкретные часы/дни («не работаю после 22:00») — это доступность для заказов, а не поиск работы:
  // модель иногда помечает их career_context, но такой факт не отбрасывается (2026-10-06).
  return kind === "profile"
    ? facts.filter((f) => !(f.subjectType === "career_context" && f.constraintType !== "lift" && !isTimeLimited(f) &&
        (f.kind === "exclude" || f.kind === "availability" || f.constraintType !== "none")))
    : facts;
}
