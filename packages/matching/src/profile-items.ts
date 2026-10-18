import { normalizeProfileItemIdentity } from "@ustal/domain";
import { cosine, isActivityScopedWindow, isTimeLimited, SEMANTIC_POLICY, type Fact } from "./semantic.js";

/**
 * Пункты профиля и их неактивные маркеры (общий код worker и API).
 *
 * 2026-10-17 (direct revoke/restore): SUPERSEDED_KIND, isLift, areaOf, LIFTED_PREFIX и toSupersededMarker перенесены сюда
 * из apps/worker/src/profile-restrictions.ts без изменений — чтобы API строил ту же неактивную историю, что и worker.
 *
 * Снятое ограничение остаётся инертным фактом kind="superseded" с resourceCapacity.kind="lifted:<область>":
 * matching его не применяет, source review не видит его фразу, evaluateSemantic не даёт review «вернуть» его.
 * Убранный пользователем кнопкой навык/ресурс (нейтральное удаление, НЕ отказ) — такой же инертный факт с
 * resourceCapacity.kind="removed_by_user:<capability|resource>": не участвует в matching ни как пункт, ни как запрет.
 */
export const SUPERSEDED_KIND = "superseded";
export const LIFTED_PREFIX = "lifted:";
export const USER_REMOVED_PREFIX = "removed_by_user:";

export const isLift = (f: Pick<Fact, "constraintType">) => f.constraintType === "lift";

export type RestrictionArea = "time_global" | "time_activity" | "scope" | "work";
/** Область ограничения или снятия; null — факт не ограничение. */
export function areaOf(f: Fact): RestrictionArea | null {
  if (f.kind === SUPERSEDED_KIND) return null;
  const timeLike = f.kind === "availability" || f.constraintType === "availability" || isTimeLimited(f);
  if (isLift(f)) {
    if (f.kind === "availability") return isActivityScopedWindow(f) ? "time_activity" : "time_global";
    return null; // снятие «только»/отказа сопоставляется ниже по деятельности (scope и work)
  }
  // Часы на навыке («доставка до 22:00») — тоже ограничение времени этой деятельности.
  if (timeLike && (f.kind === "availability" || f.kind === "exclude" || f.kind === "capability" || f.constraintType === "availability"))
    return isActivityScopedWindow(f) ? "time_activity" : "time_global";
  if (f.constraintType === "scope") return "scope";
  if (f.kind === "exclude" || f.constraintType === "exclusion") return "work";
  return null;
}

/**
 * Инертный исторический факт: не ограничение, не навык, не ресурс — matching его как ограничение не
 * применяет. Сохраняет деятельность (узлы, эмбеддинг), область и час прежнего ограничения
 * (resourceCapacity: kind="lifted:<область>", value=час) — чтобы source review не мог «вернуть» снятое
 * ограничение, процитировав старое сообщение (см. evaluateSemantic).
 */
export function toSupersededMarker<T extends Fact>(f: T): T {
  const area = areaOf(f) ?? "work";
  const hour = f.endHour ?? f.startHour ?? null;
  return {
    ...f, kind: SUPERSEDED_KIND, constraintType: "none", constraintScope: "fact",
    startHour: null, endHour: null, daysOfWeek: null, mandatory: false,
    resourceCapacity: { value: hour, unit: hour == null ? null : "hour", kind: `${LIFTED_PREFIX}${area}` },
  } as T;
}

// ---- Direct revoke/restore пунктов профиля без AI (2026-10-17) ----

export type ProfileItemFamily = "capability" | "resource";
/** Поля факта, которые читает логика пунктов (строки matching_facts и PreparedFact подходят). */
export type ItemFact = Fact & { label?: string | null; evidence?: string | null };

const NON_ASSET_RESOURCE_ROLES = new Set(["missing", "provided_by_customer", "compatibility"]);
const hasHours = (f: Fact) => f.startHour != null || f.endHour != null || !!f.daysOfWeek?.length;

/** Действующий навык (как stateOf=skill в guard): не «только …», не отказ, не снятие, не история. */
export const isActiveCapabilityFact = (f: Fact) =>
  f.kind === "capability" && f.constraintType !== "scope" && f.constraintType !== "exclusion" && f.constraintType !== "lift";
/** Действующий ресурс пользователя (как isUserAssetResource в worker). */
export const isActiveResourceFact = (f: Fact) => f.kind === "resource" && !NON_ASSET_RESOURCE_ROLES.has(f.resourceRole ?? "none");
export const isUserRemovedMarker = (f: Fact) => f.kind === SUPERSEDED_KIND && !!f.resourceCapacity?.kind?.startsWith(USER_REMOVED_PREFIX);
export function userRemovedFamily(f: Fact): ProfileItemFamily | null {
  if (!isUserRemovedMarker(f)) return null;
  const family = f.resourceCapacity!.kind!.slice(USER_REMOVED_PREFIX.length);
  return family === "capability" || family === "resource" ? family : null;
}

/**
 * Устойчивая смысловая идентичность пункта между версиями профиля (аудит Codex 2026-10-17).
 *
 * Узел онтологии — НЕ полная идентичность (тот же принцип, что deduplicateProfileResourceFacts и строки
 * user_capabilities/user_resources «узел + подпись»): «Легковая машина» и «Грузовая машина» на узле car — два пункта.
 * Пункт = семейство + узлы + нормализованная подпись (key). Выбор фактов пункта (selectItemFacts):
 *  1) кандидаты — факты семейства с общим узлом (без узла — только факты без узла);
 *  2) кандидаты с той же подписью/фразой — это пункт;
 *  3) иначе (переформулировка при переборке профиля): единственный кандидат с узлом — он; несколько — ближайший
 *     по эмбеддингу исходного факта (embedding из журнала), если сходство ≥ ITEM_REWORDING_MIN; иначе ничего
 *     (неоднозначно — лучше не убрать, чем убрать чужой пункт). Без узла переформулировка — только по эмбеддингу.
 */
export interface ProfileItemIdentity {
  family: ProfileItemFamily;
  nodeIds: string[];
  key: string;
  /** Эмбеддинг исходного факта (из snapshot журнала) — только для переформулировок при переборке; не хранится в identity. */
  embedding?: number[] | null;
}
/**
 * Переформулировка (только при переборке профиля, где известен эмбеддинг исходного факта) засчитывается лишь при
 * ОДНОЗНАЧНОМ совпадении (аудит Codex №2): лучший кандидат ≥ SEMANTIC_POLICY.mandatoryMin (0.9 — порог, при котором
 * matching считает фразы одним и тем же требованием), и ни один другой кандидат не достигает semanticMin (0.78 —
 * порог семантического совпадения). Если второй кандидат тоже «тот же смысл» по политике matching, различить их
 * нечем → ничего не выбирается (решение журнала не применяется, onAmbiguous). Без векторов для сравнения — тоже ничего.
 */
export const ITEM_REWORDING_MIN = SEMANTIC_POLICY.mandatoryMin;
export const ITEM_REWORDING_RIVAL_MAX = SEMANTIC_POLICY.semanticMin;
export const itemKey = (text: string | null | undefined) => normalizeProfileItemIdentity(text ?? "");
const familyOf = (f: Fact): ProfileItemFamily | null =>
  isActiveCapabilityFact(f) ? "capability" : isActiveResourceFact(f) ? "resource" : null;
const keysOf = (f: ItemFact) => [itemKey(f.label), itemKey(f.phrase)].filter(Boolean);

function pick<T extends ItemFact>(pool: T[], id: ProfileItemIdentity, onAmbiguous?: (candidates: number) => void): T[] {
  const cands = pool.filter((f) => (id.nodeIds.length ? f.nodeIds.some((n) => id.nodeIds.includes(n)) : !f.nodeIds.length));
  if (!cands.length) return [];
  if (!id.key) return id.nodeIds.length ? cands : []; // прежние данные без подписи: пункт = узел
  const byKey = cands.filter((f) => keysOf(f).includes(id.key));
  // Точная идентичность (действие кнопкой по текущей версии) — только подпись; переформулировка — только при
  // переборке, где известен эмбеддинг исходного факта.
  if (byKey.length || id.embedding === undefined || !id.embedding?.length) return byKey;
  const scored = cands.map((f) => ({ f, score: f.embedding?.length ? cosine(f.embedding, id.embedding) : -1 })).sort((x, y) => y.score - x.score);
  const [best, second] = scored;
  const rivals = scored.filter((x) => x.score >= ITEM_REWORDING_RIVAL_MAX).length;
  if (rivals > 1) { onAmbiguous?.(rivals); return []; }
  return best && best.score >= ITEM_REWORDING_MIN && (!second || second.score < ITEM_REWORDING_RIVAL_MAX) ? [best.f] : [];
}
/** Действующие факты пункта (см. правило выше). */
export function selectItemFacts<T extends ItemFact>(facts: T[], id: ProfileItemIdentity, onAmbiguous?: (candidates: number) => void): T[] {
  return pick(facts.filter((f) => familyOf(f) === id.family), id, onAmbiguous);
}
/** Маркеры removed_by_user этого пункта. */
export function selectItemMarkers<T extends ItemFact>(facts: T[], id: ProfileItemIdentity, onAmbiguous?: (candidates: number) => void): T[] {
  return pick(facts.filter((f) => userRemovedFamily(f) === id.family), id, onAmbiguous);
}
/** Совпадает ли факт с пунктом точно: общий узел (без узла — тоже без узла) и та же подпись/фраза. */
export function factMatchesItem(f: ItemFact, id: ProfileItemIdentity, family: ProfileItemFamily | null = familyOf(f)): boolean {
  return family === id.family && pick([f], { ...id, embedding: undefined }).length > 0;
}
/**
 * Относится ли предложенный факт к убранному пункту (для guard «невоскрешения»): тот же узел ИЛИ та же подпись.
 * Шире, чем factMatchesItem: модель могла назвать тот же пункт иначе — вернуть его может только сообщение, которое его называет.
 */
export function factRelatesToItem(f: ItemFact, id: ProfileItemIdentity): boolean {
  if (familyOf(f) !== id.family) return false;
  return (id.nodeIds.length > 0 && f.nodeIds.some((n) => id.nodeIds.includes(n))) || (!!id.key && keysOf(f).includes(id.key));
}

/** Нейтрально убранный пользователем пункт: инертная история, не отказ и не ограничение. */
export function toUserRemovedMarker<T extends Fact>(f: T, family: ProfileItemFamily): T {
  return {
    ...f, kind: SUPERSEDED_KIND, constraintType: "none", constraintScope: "fact", resourceRole: "none",
    startHour: null, endHour: null, daysOfWeek: null, mandatory: false,
    resourceCapacity: { value: null, unit: null, kind: `${USER_REMOVED_PREFIX}${family}` },
  } as T;
}

export interface ItemOptions {
  /** Название узла онтологии — подпись части составного факта (иначе часть несла бы фразу целого). */
  nodeLabel?: (nodeId: string) => string | null | undefined;
  /** Переформулированный пункт неоднозначен (несколько равных кандидатов) — решение не применено. */
  onAmbiguous?: (candidates: number) => void;
}
/**
 * Часть составного факта (несколько узлов), которая остаётся/возвращается отдельно: подпись и фраза — из названий
 * её узлов (фраза целого содержит смысл другой части); эмбеддинг сбрасывается — его пересчитывает
 * profile_embedding_refresh (до пересчёта часть сопоставляется только по узлу, без «чужого» смысла).
 */
function componentOf<T extends ItemFact>(f: T, nodeIds: string[], opts: ItemOptions): T {
  const names = nodeIds.map((n) => opts.nodeLabel?.(n)).filter((x): x is string => !!x);
  const label = names.length === nodeIds.length ? names.join(", ") : null;
  return { ...f, nodeIds, ...(label ? { label, phrase: label.toLowerCase() } : {}), embedding: null } as T;
}

/**
 * Убрать навык/ресурс: действующие факты этого пункта становятся маркерами removed_by_user.
 * Составной факт (несколько узлов): остальные узлы остаются действующей частью (своя подпись, без смысла убранной).
 * Возвращает новые факты и исходные (для журнала и восстановления); removed пуст — пункта уже нет (идемпотентно).
 */
export function revokeProfileItem<T extends ItemFact>(facts: T[], id: ProfileItemIdentity, opts: ItemOptions = {}): { facts: T[]; removed: T[] } {
  const targets = new Set(selectItemFacts(facts, id, opts.onAmbiguous));
  const out: T[] = [];
  const removed: T[] = [];
  for (const f of facts) {
    if (!targets.has(f)) { out.push(f); continue; }
    removed.push(f);
    const mine = id.nodeIds.length ? f.nodeIds.filter((n) => id.nodeIds.includes(n)) : f.nodeIds;
    const others = f.nodeIds.filter((n) => !mine.includes(n));
    if (others.length && mine.length) {
      out.push(componentOf(f, others, opts));
      out.push(toUserRemovedMarker(componentOf(f, mine, opts), id.family));
    } else out.push(toUserRemovedMarker(f, id.family));
  }
  return { facts: out, removed };
}

const sameSource = (a: ItemFact, b: ItemFact) => a.phrase === b.phrase && (a.evidence ?? null) === (b.evidence ?? null);
const covers = (o: ItemFact, part: ItemFact) => part.nodeIds.length > 0 && part.nodeIds.every((n) => o.nodeIds.includes(n));

/**
 * Восстановить убранный навык/ресурс — только выбранную часть (аудит Codex 2026-10-17): каждый маркер пункта
 * возвращается как действующий факт из исходного (журнал/replay) с узлами ЭТОГО маркера; убранные отдельно
 * другие части составного факта остаются убранными. Если оставшаяся действующая часть + возвращённая вместе
 * составляют исходный факт — он возвращается целиком (как был). Уже действующий пункт — без дубля.
 */
export function restoreProfileItem<T extends ItemFact>(facts: T[], id: ProfileItemIdentity, originals: T[], opts: ItemOptions = {}): { facts: T[]; changed: boolean } {
  const markers = selectItemMarkers(facts, id, opts.onAmbiguous);
  if (!markers.length) return { facts, changed: false };
  const alreadyActive = selectItemFacts(facts, { ...id, embedding: undefined }).length > 0;
  let out = facts.filter((f) => !markers.includes(f));
  if (alreadyActive) return { facts: out, changed: true };
  for (const m of markers) {
    const o = originals.find((x) => x.kind === (id.family === "capability" ? "capability" : "resource") && covers(x, m) && (x.evidence ?? null) === (m.evidence ?? null))
      ?? originals.find((x) => covers(x, m)) ?? originals.find((x) => !m.nodeIds.length && !x.nodeIds.length);
    if (!o) {
      // Исходного факта нет (журнал без snapshot): маркер снова становится пунктом.
      out.push({ ...m, kind: id.family, resourceRole: id.family === "resource" ? "available" : "none",
        resourceCapacity: { value: null, unit: null, kind: null } } as T);
      continue;
    }
    const whole = !m.nodeIds.length || o.nodeIds.every((n) => m.nodeIds.includes(n));
    if (whole) { out.push(o); continue; }
    // Оставшаяся часть того же факта + эта часть = исходный факт целиком.
    const rest = out.findIndex((f) => familyOf(f) === id.family && (f.evidence ?? null) === (o.evidence ?? null) && covers(o, f) &&
      o.nodeIds.every((n) => f.nodeIds.includes(n) || m.nodeIds.includes(n)));
    if (rest >= 0) out = out.map((f, i) => (i === rest ? o : f));
    else out.push(componentOf(o, m.nodeIds, opts));
  }
  return { facts: out, changed: true };
}

/** Факт-ограничение (как показывает GET /profile): отказ, время, «только …», часы на навыке. Не убранный навык. */
export const isRestrictionItemFact = (f: Fact) =>
  f.kind !== SUPERSEDED_KIND && f.resourceCapacity?.kind !== "revoked" && f.kind !== "resource" &&
  (f.kind === "exclude" || f.kind === "availability" || f.constraintType === "exclusion" || f.constraintType === "scope" ||
    f.constraintType === "availability" || (f.kind === "capability" && hasHours(f)));

export const RESTRICTION_SIGNATURE_ATTR = "restriction_signature";
/** Навык, чья фраза описывала снятое ограничение, а чистой подписи нет: в тексте для ревью не показывается (fail-safe). */
export const EFFECTIVE_TEXT_UNAVAILABLE_ATTR = "effective_text_unavailable";
export const hasStaleEffectiveText = (f: { attributes?: unknown }) =>
  Array.isArray(f.attributes) && (f.attributes as { key?: string }[]).some((a) => a?.key === EFFECTIVE_TEXT_UNAVAILABLE_ATTR);
/**
 * Действующий навык после снятия его часов/дней (аудит Codex №3): фраза описывала и снятое ограничение
 * («доставляю документы до 22:00»), поэтому каноническая подпись берётся из структурного состояния, без вырезания
 * подстрок и без AI. Приоритет: 1) сохранённая атомарная подпись пункта (label); 2) названия узлов онтологии;
 * 3) прежние данные без подписи и узла — чистого текста нет: навык остаётся действующим для matching, но помечается
 * effective_text_unavailable и в текст ревью не попадает (лучше пропуск, чем снятое ограничение как факт).
 * При смене фразы вектор сбрасывается (пересчитает profile_embedding_refresh).
 */
function relaxedSkill<T extends ItemFact>(relaxed: T, opts: ItemOptions): T {
  const label = relaxed.label?.trim();
  if (label) return { ...relaxed, phrase: label.toLowerCase(), embedding: null } as T;
  if (relaxed.nodeIds.length && relaxed.nodeIds.every((n) => !!opts.nodeLabel?.(n))) return componentOf(relaxed, relaxed.nodeIds, opts);
  const own = (relaxed as unknown as { attributes?: unknown }).attributes;
  const attrs = Array.isArray(own) ? own : [];
  return { ...relaxed, attributes: [...attrs, { key: EFFECTIVE_TEXT_UNAVAILABLE_ATTR, value: "1", unit: null }] } as T;
}
/**
 * Снять ограничение: тот же lifecycle, что снятие сообщением — инертный маркер lifted:<область>. Маркер кнопки несёт
 * ПОЛНУЮ структурную подпись снятого ограничения (attributes: restriction_signature) — по ней восстановление и replay
 * находят именно его (будни 9–18 ≠ выходные 12–18; аудит Codex №2).
 * Часы на навыке снимаются, сам навык остаётся; его фраза описывала и снятые часы («доставка посылок до 22:00»),
 * поэтому действующий навык получает каноническую подпись из названий своих узлов (raw-фраза остаётся в истории:
 * маркер и evidence), вектор пересчитывается (embedding=null → profile_embedding_refresh).
 */
export function liftRestrictionFacts<T extends ItemFact>(facts: T[], target: (f: T) => boolean, opts: ItemOptions = {}): { facts: T[]; removed: T[] } {
  const out: T[] = [];
  const removed: T[] = [];
  for (const f of facts) {
    if (!target(f) || !isRestrictionItemFact(f)) { out.push(f); continue; }
    removed.push(f);
    // Навык со снятым ограничением остаётся навыком — как при снятии сообщением (resolveRestrictionUpdates, isSkill):
    // навык — capability, не снятие, не «только …», не отказ. Реальная форма навыка с часами — constraintType=availability,
    // constraintScope=fact (live E2E 2026-10-17): снимается только ограничение, остаётся обычный навык.
    if (isActiveCapabilityFact(f)) {
      const plain = f.constraintType === "availability" ? { constraintType: "none" as const, constraintScope: "whole_task" as const } : {};
      const relaxed = { ...f, ...plain, startHour: null, endHour: null, daysOfWeek: null };
      // Подпись из названий узлов; без названий (неизвестная деятельность) фраза остаётся — WARN (см. отчёт).
      out.push(relaxedSkill(relaxed, opts));
    }
    const marker = toSupersededMarker(f) as T & { attributes?: unknown };
    out.push({ ...marker, attributes: [{ key: RESTRICTION_SIGNATURE_ATTR, value: restrictionSignature(f), unit: null }] } as T);
  }
  return { facts: out, removed };
}

/**
 * Структурная идентичность ограничения — одна полная каноническая подпись для журнала, маркера, снятия, восстановления,
 * replay и API (аудиты Codex №2/№3). Поля — всё, что читает matching для ограничений профиля (evaluateSemantic):
 *  - область (areaOf: время всего профиля / время деятельности / «только» / отказ);
 *  - kind (exclude / availability / capability с часами) и constraintType (exclusion / scope / availability / none);
 *  - constraintScope (whole_task / fact / optional_component; отсутствие ≡ whole_task, как у matching для отказов);
 *  - предмет: узлы деятельности (отсортированы); без узла — нормализованная подпись («key:…»); у окна всего профиля — нет;
 *  - startHour, endHour (null ≠ 0 — разные границы);
 *  - daysOfWeek (множество, отсортировано; null ≡ [] — matching не ограничивает дни в обоих случаях).
 * Фраза и цитата в подпись не входят (хранятся в журнале для аудита). Сериализация — JSON фиксированного порядка, версия «r2».
 */
export function restrictionSignature(f: ItemFact): string | null {
  const area = areaOf(f);
  if (!area) return null;
  const subject = area === "time_global" ? [] : f.nodeIds.length ? [...f.nodeIds].sort() : [`key:${itemKey(f.label || f.phrase)}`];
  // Отсутствие и пустое — как их трактует matching: нет области у отказа ≡ whole_task; дни null ≡ [] (без ограничения дней).
  const scope = f.constraintScope ?? "whole_task";
  const days = f.daysOfWeek?.length ? [...new Set(f.daysOfWeek)].sort((x, y) => x - y) : null;
  return JSON.stringify(["r2", area, f.kind, f.constraintType ?? "none", scope, subject, f.startHour ?? null, f.endHour ?? null, days]);
}
const liftedArea = (m: Fact) => (m.kind === SUPERSEDED_KIND && m.resourceCapacity?.kind?.startsWith(LIFTED_PREFIX) ? m.resourceCapacity.kind.slice(LIFTED_PREFIX.length) : null);
export const isLiftedRestrictionMarker = (m: Fact) => liftedArea(m) != null;
/**
 * Идентичность снятого ограничения по маркеру — та же полная restrictionSignature (сохранена в маркере кнопки).
 * Маркер без подписи (снятие сообщением / прежние данные) не сопоставляется ни с каким решением кнопки.
 */
export function liftedMarkerSignature(m: ItemFact): string | null {
  if (!isLiftedRestrictionMarker(m)) return null;
  const attrs = (m as { attributes?: { key: string; value: unknown }[] | null }).attributes;
  const sig = Array.isArray(attrs) ? attrs.find((a) => a.key === RESTRICTION_SIGNATURE_ATTR)?.value : null;
  return typeof sig === "string" ? sig : null;
}
/** Подпись, с которой сравнивается маркер, для исходного факта ограничения. */
export const markerSignatureOf = (o: ItemFact): string | null => restrictionSignature(o);

/** Вернуть снятое кнопкой ограничение: убрать его маркер (и копию навыка без часов), вернуть исходные факты. */
export function restoreRestrictionFacts<T extends ItemFact>(facts: T[], originals: T[]): { facts: T[]; changed: boolean } {
  let out = [...facts];
  let changed = false;
  for (const o of originals) {
    const sig = restrictionSignature(o);
    if (sig && out.some((f) => f.kind !== SUPERSEDED_KIND && restrictionSignature(f) === sig)) continue; // уже действует — без дубля
    const msig = markerSignatureOf(o);
    const marker = out.findIndex((f) => liftedMarkerSignature(f) === msig);
    if (marker >= 0) out = out.filter((_, i) => i !== marker);
    if (isActiveCapabilityFact(o)) {
      // Навык, с которого сняли часы: тот же факт (та же цитата) без часов, иначе — тот же набор узлов.
      const same = (f: T) => isActiveCapabilityFact(f) && !hasHours(f);
      let relaxed = out.findIndex((f) => same(f) && sameSource(f, o));
      if (relaxed < 0) relaxed = out.findIndex((f) => same(f) && f.nodeIds.length > 0 &&
        JSON.stringify([...f.nodeIds].sort()) === JSON.stringify([...o.nodeIds].sort()));
      // Без узла: та же цитата и та же атомарная подпись (фраза могла смениться на подпись при снятии).
      if (relaxed < 0) relaxed = out.findIndex((f) => same(f) && !f.nodeIds.length && !o.nodeIds.length &&
        (f.evidence ?? null) === (o.evidence ?? null) && (f.label ?? null) === (o.label ?? null));
      if (relaxed >= 0) out = out.filter((_, i) => i !== relaxed);
    }
    out.push(o);
    changed = true;
  }
  return { facts: out, changed };
}
