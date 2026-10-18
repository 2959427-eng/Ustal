import { areaOf, cosine, hasStaleEffectiveText, isActivityScopedWindow, isLift, isTimeLimited, isUserRemovedMarker, LIFTED_PREFIX, SEMANTIC_POLICY, SUPERSEDED_KIND, type Fact, type RestrictionArea } from "@ustal/matching";
// 2026-10-17: SUPERSEDED_KIND, isLift, areaOf, LIFTED_PREFIX, toSupersededMarker живут в @ustal/matching (общий код с API
// для direct revoke/restore) — здесь реэкспорт без изменения поведения.
export { areaOf, isLift, LIFTED_PREFIX, SUPERSEDED_KIND, toSupersededMarker, type RestrictionArea } from "@ustal/matching";
import { PROFILE_SOURCE_SEPARATOR } from "@ustal/database";

/**
 * Актуальное состояние явных ограничений профиля (2026-10-06).
 *
 * Профиль накопительный: текст = все сообщения пользователя по порядку. Ограничение из раннего
 * сообщения перестаёт действовать, только когда пользователь сам явно его снял или заменил:
 * - снял — нормализация отметила это высказывание `constraintType="lift"` («теперь работаю после
 *   22:00», «теперь делаю и Android»): снимаются более ранние ограничения той же области;
 * - заменил — в более позднем сообщении есть новое ограничение той же области («теперь работаю до
 *   23:00», «только iOS и Android»): старое заменяется новым.
 * Область: время для всей работы (глобальное) / время одной деятельности / «только …» / отказ от
 * вида работ; деятельность совпадает по общему узлу онтологии или по смыслу (порог отказов).
 * Решение принимает сервер по порядку сообщений — без догадок модели. Снятое ограничение не удаляется
 * бесследно: оно остаётся инертным фактом kind="superseded" (история), который не участвует в matching
 * и не показывается, а его фраза убирается из текста профиля, который видит source review.
 * Отказы, снятые более новым положительным навыком, разрешает resolveProfileNegatives.
 */
export interface RestrictionFactLike extends Fact {
  evidence?: string;
}


const segmentStarts = (text: string) => {
  const starts = [0];
  let i = text.indexOf(PROFILE_SOURCE_SEPARATOR);
  while (i >= 0) {
    starts.push(i + PROFILE_SOURCE_SEPARATOR.length);
    i = text.indexOf(PROFILE_SOURCE_SEPARATOR, i + 1);
  }
  return starts;
};
const positionOf = (f: RestrictionFactLike, text: string) => {
  const i = f.evidence ? text.lastIndexOf(f.evidence) : -1;
  return i < 0 ? 0 : i;
};
const segmentOf = (pos: number, starts: number[]) => starts.filter((s) => s <= pos).length - 1;

const sameActivity = (a: Fact, b: Fact) =>
  a.nodeIds.some((id) => b.nodeIds.includes(id)) ||
  cosine(a.embedding, b.embedding) >= SEMANTIC_POLICY.exclusionMin;

type Area = RestrictionArea;

/** Снимает ли (или заменяет ли) более поздний факт `later` ограничение `earlier`. */
function supersedes(later: Fact, earlier: Fact, earlierArea: Area): boolean {
  if (isLift(later)) {
    if (later.kind === "availability") {
      const a = areaOf(later);
      if (a !== earlierArea) return false;
      return a === "time_global" || sameActivity(later, earlier);
    }
    // Снятие для конкретной деятельности («теперь доставляю и после 22:00», «делаю и Android») снимает
    // её отказ, «только …» и рамки времени этой деятельности; глобальные часы — только глобальное снятие.
    return (earlierArea === "scope" || earlierArea === "work" || earlierArea === "time_activity") && sameActivity(later, earlier);
  }
  const a = areaOf(later);
  if (a !== earlierArea) return false;
  if (a === "time_global") return true;
  return sameActivity(later, earlier);
}

/**
 * Возвращает актуальные факты (снятия `lift` удалены — их текст остаётся в источнике) и снятые
 * ограничения. Снятие действует на всё более раннее (даже в том же сообщении: «раньше …, теперь …»);
 * замена новым ограничением — только из более позднего сообщения (в одном сообщении несколько окон
 * времени или видов работ действуют вместе).
 */
export function resolveRestrictionUpdates<T extends RestrictionFactLike>(input: T[], text: string): { facts: T[]; superseded: T[]; lifts: T[] } {
  // «Теперь работаю до 18:00» — новая граница, а не снятие: «снятие» с часами — это замена
  // ограничения (модель иногда путает), поэтому оно становится обычным окном времени.
  const facts = input.map((f) => (isLift(f) && isTimeLimited(f) ? ({ ...f, kind: "availability", constraintType: "availability" }) as T : f));
  const starts = segmentStarts(text);
  // Обновление по одному сообщению: порядок задан явно (прежнее состояние профиля — раньше нового сообщения).
  const order = (f: T) => (f as T & { messageOrder?: { seg: number; pos: number } }).messageOrder;
  const pos = facts.map((f) => order(f)?.pos ?? positionOf(f, text));
  const seg = facts.map((f, i) => order(f)?.seg ?? segmentOf(pos[i]!, starts));
  const superseded = new Set<number>();
  facts.forEach((earlier, ei) => {
    if (isLift(earlier)) return;
    const area = areaOf(earlier);
    if (!area) return;
    facts.forEach((later, li) => {
      if (li === ei || superseded.has(ei)) return;
      const newer = isLift(later) ? pos[li]! > pos[ei]! : seg[li]! > seg[ei]!;
      if (newer && supersedes(later, earlier, area)) superseded.add(ei);
    });
  });
  // Навык со снятым ограничением времени остаётся навыком — снимаются только часы.
  const relaxed = (f: T): T => ({ ...f, startHour: null, endHour: null, daysOfWeek: null });
  const isSkill = (f: T) => f.kind === "capability" && !isLift(f) && f.constraintType !== "scope" && f.constraintType !== "exclusion";
  const kept = facts.flatMap((f, i) => (isLift(f) ? [] : !superseded.has(i) ? [f] : isSkill(f) ? [relaxed(f)] : []));
  // Снятие отказа или «только …» («теперь занимаюсь доставкой», «делаю и Android») — это и
  // утверждение, что человек делает эту работу: если такого навыка ещё нет, снятие становится навыком.
  // Только снятие с узлом онтологии (конкретная работа), иначе фраза вроде «работаю после 22:00» стала бы навыком.
  const liftSkills = facts.filter((f) => isLift(f) && f.kind === "capability" && f.nodeIds.length > 0 &&
    !kept.some((k) => isSkill(k) && sameActivity(k, f)))
    .map((f) => ({ ...f, constraintType: "none", constraintScope: "whole_task" }) as T);
  return {
    facts: [...kept, ...liftSkills],
    superseded: facts.filter((f, i) => superseded.has(i) && !isSkill(f)),
    lifts: facts.filter(isLift),
  };
}

/**
 * История самого снятия («теперь работаю после 22:00», «делаю и Android»): даже если модель не
 * выделила прежнее ограничение отдельным фактом, ревью по старому сообщению не должно его вернуть.
 * Область: lift_time_global / lift_time_activity (время) или lift_work_scope (отказ или «только»).
 */
export function toLiftMarker<T extends RestrictionFactLike>(f: T): T {
  const area = f.kind === "availability" ? (isActivityScopedWindow(f) ? "lift_time_activity" : "lift_time_global") : "lift_work_scope";
  return {
    ...f, kind: SUPERSEDED_KIND, constraintType: "none", constraintScope: "fact",
    startHour: null, endHour: null, daysOfWeek: null, mandatory: false,
    resourceCapacity: { value: null, unit: null, kind: `${LIFTED_PREFIX}${area}` },
  } as T;
}

/**
 * Текст профиля для source review.
 *
 * Пока в профиле ничего не снято и не убрано — исходный текст байт в байт (кеш ревью не меняется).
 * Иначе по сообщениям (сегментам исходного текста):
 * - сообщение без неактивных фактов — как есть;
 * - снятое СООБЩЕНИЕМ ограничение, цитата которого не нужна действующим фактам, — его цитата убирается (прежнее правило);
 * - сообщение с решением пользователя кнопкой (removed_by_user) или с неактивным фактом, цитату которого делит
 *   действующий факт («Сверлю бетон и крашу стены», «Ремонтирую технику, не работаю после 18:00»), заменяется
 *   каноническим текстом ДЕЙСТВУЮЩИХ пунктов этого сообщения (подпись/фраза, часы, роль) — effective representation
 *   из активного структурированного состояния, а не вырезание подстрок (аудит Codex 2026-10-17): по предложению на
 *   пункт (effectiveItemSentences), через перевод строки — полноценный источник цитат для review (live E2E 2026-10-17).
 * Исходный текст профиля (история, lineage) не меняется — это только вход ревью.
 */
export interface ReviewTextFact {
  kind: string; evidence?: string | null; phrase?: string | null; label?: string | null; resourceCapacity?: Fact["resourceCapacity"] | null;
  constraintType?: string | null; constraintScope?: string | null; resourceRole?: string | null; startHour?: number | null; endHour?: number | null; daysOfWeek?: number[] | null;
  attributes?: unknown;
}
const DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
function hoursText(f: ReviewTextFact): string {
  const parts: string[] = [];
  if (f.startHour != null && f.endHour != null) parts.push(`с ${f.startHour}:00 до ${f.endHour}:00`);
  else if (f.endHour != null) parts.push(`до ${f.endHour}:00`);
  else if (f.startHour != null) parts.push(`с ${f.startHour}:00`);
  if (f.daysOfWeek?.length) parts.push(`по дням: ${[...f.daysOfWeek].sort().map((d) => DAYS[d]).join(", ")}`);
  return parts.join(", ");
}
const clean = (t: string) => t.trim().replace(/[.;!?\s]+$/u, "");
const sentence = (t: string) => { const c = clean(t); return c ? `${c[0]!.toUpperCase()}${c.slice(1)}.` : ""; };
/**
 * Действующий пункт как ОТДЕЛЬНЫЕ предложения синтетического текста ревью (live E2E 2026-10-17): текст — полноценный
 * источник доказательств для review (цитаты проверяются строго против него), а не набор подписей UI. Каждый пункт —
 * своё предложение (фрагмент для evidence validation: границы — «.», «;», перевод строки):
 *  - навык: «Могу выполнять: <подпись>.» — глагол действия есть в самом тексте; время навыка — отдельным
 *    предложением «Ограничение времени для «<подпись>»: до 21:00; на другие работы оно не распространяется.» — цитата
 *    действия не обязана включать число, и ревью не переносит окно одной работы на другие (live mini-set L8);
 *  - ресурс: «У меня есть ресурс: <подпись>.»; отсутствующий/не свой ресурс — его фраза;
 *  - отказ: «Не выполняю: <фраза>.»; «только …»: «Только: <фраза>.»;
 *  - окно времени всего профиля: «Доступность: до 18:00.»; окно деятельности — как время навыка (только для неё).
 * Убранные/снятые пункты сюда не попадают (их нет среди действующих фактов). Навык без чистой подписи — пропуск.
 */
export function effectiveItemSentences(f: ReviewTextFact): string[] {
  if (hasStaleEffectiveText(f)) return [];
  const name = clean(f.label || f.phrase || "");
  const phrase = clean(f.phrase || f.label || "");
  const hours = hoursText(f);
  if (f.kind === "exclude" || f.constraintType === "exclusion")
    return [sentence(/^не\s/i.test(phrase) ? phrase : `Не выполняю: ${phrase}`)];
  if (f.constraintType === "scope") return [sentence(`Только: ${phrase}`)];
  // Окно одной деятельности — явно только для неё (live: «Доступность для X: до 19:00» ревью применял ко всей работе).
  const scopedWindow = (what: string) => sentence(`Ограничение времени для «${what}»: ${hours}; на другие работы оно не распространяется`);
  if (f.kind === "availability")
    return [hours ? (f.constraintScope === "fact" && phrase ? scopedWindow(phrase) : sentence(`Доступность: ${hours}`)) : sentence(phrase)];
  if (f.kind === "resource")
    return [sentence(f.resourceRole && !["none", "available"].includes(f.resourceRole) ? phrase : `У меня есть ресурс: ${name}`)];
  if (f.kind === "capability") return [sentence(`Могу выполнять: ${name}`), ...(hours ? [scopedWindow(name)] : [])];
  return [sentence(name)];
}
/** Тот же пункт одной строкой (совместимость). */
export const effectiveItemText = (f: ReviewTextFact): string => effectiveItemSentences(f).join(" ");
export function reviewProfileText(sourceText: string, facts: ReviewTextFact[]): string {
  const inactive = facts.filter((f) => f.kind === SUPERSEDED_KIND && f.evidence);
  if (!inactive.length) return sourceText;
  const live = facts.filter((f) => f.kind !== SUPERSEDED_KIND && f.evidence);
  const overlaps = (a: string, b: string) => a.includes(b) || b.includes(a);
  const segments = sourceText.split(PROFILE_SOURCE_SEPARATOR).map((seg) => {
    const stale = inactive.filter((f) => seg.includes(f.evidence!));
    if (!stale.length) return seg;
    const canonical = stale.some((f) => isUserRemovedMarker(f as unknown as Fact) || live.some((l) => overlaps(l.evidence!, f.evidence!)));
    if (!canonical) {
      let t = seg;
      for (const f of stale) t = t.split(f.evidence!).join("");
      return t;
    }
    const items = live.filter((l) => seg.includes(l.evidence!))
      .sort((x, y) => seg.indexOf(x.evidence!) - seg.indexOf(y.evidence!))
      .flatMap(effectiveItemSentences).filter(Boolean);
    return [...new Set(items)].join("\n");
  });
  const out = segments.filter((x) => x.trim()).join(PROFILE_SOURCE_SEPARATOR);
  // Без изменений текст отдаётся как есть (байт в байт).
  return out === sourceText ? sourceText : out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
