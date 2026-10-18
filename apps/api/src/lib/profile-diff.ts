import { normalizeProfileItemIdentity } from "@ustal/domain";

/**
 * Дифф черновика профиля по ontologyNodeId (а не по label): тот же узел с другой
 * формулировкой — тот же пункт, не «убрать + добавить».
 * added — пункты черновика, узла которых нет в применённом профиле (label из черновика).
 * removed — пункты применённого профиля, узла которых нет в черновике (label из применённого).
 */
export interface DiffItem {
  ontologyNodeId: string;
  label: string;
}

export function diffByNode(applied: DiffItem[], draft: DiffItem[]): { added: string[]; removed: string[] } {
  const appliedIds = new Set(applied.map((i) => i.ontologyNodeId));
  const draftIds = new Set(draft.map((i) => i.ontologyNodeId));
  return {
    added: draft.filter((i) => !appliedIds.has(i.ontologyNodeId)).map((i) => i.label),
    removed: applied.filter((i) => !draftIds.has(i.ontologyNodeId)).map((i) => i.label),
  };
}

/**
 * Распознанные AI фразы профиля без ontology-узла (matching_facts.node_ids = []).
 * Matching уже использует их через embedding, но в user_capabilities/user_resources
 * они не попадают — отдаём отдельно, чтобы пользователь видел всё распознанное.
 * Ресурсы заказчика/отсутствующие/«совместимость» — не активы исполнителя, не показываем.
 */
export interface ItemAttribute { key: string; value: string | number; unit: string | null }
export interface UnmappedFact {
  /** id факта текущей версии (2026-10-17) — для прямых действий «Убрать». */
  id?: string;
  kind: "capability" | "resource";
  /** Подпись для показа: label факта (2026-10-15), у прежних фактов — их фраза. */
  phrase: string;
  /** Характеристики имеющегося ресурса (только показ, matching их не читает). */
  itemAttributes?: ItemAttribute[];
}
export interface FactRow {
  id?: string;
  kind: string;
  phrase: string;
  label?: string | null;
  attributes?: unknown;
  nodeIds: string[];
  resourceRole?: string | null;
  constraintType?: string | null;
}
const HIDDEN_RESOURCE_ROLES = new Set(["missing", "provided_by_customer", "compatibility"]);
const norm = (s: string) => s.trim().toLowerCase();

export function pickUnmappedFacts(facts: FactRow[], mappedLabels: string[] = []): UnmappedFact[] {
  const seen = new Set(mappedLabels.map(normalizeProfileItemIdentity));
  const out: UnmappedFact[] = [];
  for (const f of facts) {
    if (f.kind !== "capability" && f.kind !== "resource") continue;
    if (f.nodeIds.length) continue;
    // Отказ («больше не делаю …») — ограничение для matching, а не текущий навык.
    if (f.constraintType === "exclusion") continue;
    if (f.kind === "resource" && f.resourceRole && HIDDEN_RESOURCE_ROLES.has(f.resourceRole)) continue;
    const shown = (f.label || f.phrase).trim();
    const key = normalizeProfileItemIdentity(shown);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const attrs = f.kind === "resource" ? itemAttributesOf(f) : [];
    out.push({ ...(f.id ? { id: f.id } : {}), kind: f.kind, phrase: shown, ...(attrs.length ? { itemAttributes: attrs } : {}) });
  }
  return out;
}

export function itemAttributesOf(f: Pick<FactRow, "attributes">): ItemAttribute[] {
  return Array.isArray(f.attributes) ? (f.attributes as ItemAttribute[]) : [];
}
/**
 * Характеристики к строкам ресурсов профиля (user_resources): из факта документа с тем же узлом и той же подписью,
 * а если такой подписи нет — из единственного имеющегося ресурса с этим узлом. Строка без факта — без характеристик.
 */
export function withItemAttributes<R extends { ontologyNodeId: string; label: string }>(resources: R[], facts: FactRow[]): (R & { itemAttributes: ItemAttribute[] })[] {
  const assets = facts.filter((f) => f.kind === "resource" && !(f.resourceRole && HIDDEN_RESOURCE_ROLES.has(f.resourceRole)) && f.constraintType !== "exclusion");
  return resources.map((r) => {
    const sameNode = assets.filter((f) => f.nodeIds.includes(r.ontologyNodeId));
    const key = normalizeProfileItemIdentity(r.label);
    const fact = sameNode.find((f) => normalizeProfileItemIdentity(f.label || f.phrase) === key) ?? (sameNode.length === 1 ? sameNode[0] : undefined);
    return { ...r, itemAttributes: fact ? itemAttributesOf(fact) : [] };
  });
}

/** Новые нераспознанные онтологией фразы черновика относительно применённого профиля. */
export function diffUnmapped(applied: UnmappedFact[], draft: UnmappedFact[]): string[] {
  const appliedKeys = new Set(applied.map((f) => normalizeProfileItemIdentity(f.phrase)));
  return draft.filter((f) => !appliedKeys.has(normalizeProfileItemIdentity(f.phrase))).map((f) => f.phrase);
}

/**
 * Явные ограничения пользователя для раздела «Ограничения» в профиле (2026-10-06). Только то, что уже
 * сохранено как действующий факт-ограничение: отказ от вида работ, «только …», рамки времени. Текст
 * строится из сохранённых полей факта (часы, дни, деятельность) — цитата (evidence) не годится: это
 * целое сообщение пользователя. Ничего не выводится и не дополняется: навыки/ресурсы, отсутствующие
 * ресурсы и снятые пользователем ограничения (kind="superseded") сюда не попадают.
 */
export type RestrictionType = "time" | "work" | "scope";
export interface ProfileRestriction {
  type: RestrictionType;
  text: string;
  /** id факта текущей версии (2026-10-17) — для «Снять ограничение». */
  id?: string;
}
export interface RestrictionFactRow {
  id?: string;
  kind: string;
  phrase: string;
  evidence?: string | null;
  constraintType?: string | null;
  constraintScope?: string | null;
  startHour?: number | null;
  endHour?: number | null;
  daysOfWeek?: number[] | null;
  resourceCapacity?: { kind?: string | null } | null;
}
// Отзыв навыка («не хочу больше копать»): навык убран из профиля, а сохранённый отказ — только история и
// защита matching (worker помечает его resourceCapacity.kind="revoked"). Это не условие работы, поэтому в
// «Ограничениях» не показывается — иначе рядом стояла бы противоречивая пара «навык убран» / «не выполняю».
const isRevokedSkill = (f: RestrictionFactRow) => f.resourceCapacity?.kind === "revoked";
// Часы на навыке («ремонт — до 18:00») matching применяет как ограничение времени этой работы —
// значит, это тоже явное ограничение пользователя и показывается.
const hasHours = (f: RestrictionFactRow) => f.startHour != null || f.endHour != null || !!f.daysOfWeek?.length;
const isRestrictionFact = (f: RestrictionFactRow) =>
  f.kind === "exclude" || f.kind === "availability" ||
  f.constraintType === "exclusion" || f.constraintType === "scope" || f.constraintType === "availability" ||
  (f.kind === "capability" && hasHours(f));
const DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const cap = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);
const hhmm = (h: number) => `${h}:00`;
function timeText(f: RestrictionFactRow): string {
  const parts: string[] = [];
  if (f.startHour != null && f.endHour != null) parts.push(`с ${hhmm(f.startHour)} до ${hhmm(f.endHour)}`);
  else if (f.endHour != null) parts.push(`до ${hhmm(f.endHour)}`);
  else if (f.startHour != null) parts.push(`с ${hhmm(f.startHour)}`);
  if (f.daysOfWeek?.length) parts.push(`по дням: ${[...f.daysOfWeek].sort().map((d) => DAYS[d]).join(", ")}`);
  return parts.join(", ");
}

/**
 * Ограничения для показа и их факты (2026-10-17): одно показанное ограничение может стоять на нескольких фактах
 * (модель дублирует), «Снять ограничение» снимает их все. id — первый факт группы.
 */
export function restrictionGroups(facts: RestrictionFactRow[]): (ProfileRestriction & { factIds: string[] })[] {
  const byKey = new Map<string, ProfileRestriction & { factIds: string[] }>();
  const out: (ProfileRestriction & { factIds: string[] })[] = [];
  const hiddenDuplicates: { id: string; key: string }[] = [];
  // Те же часы, что и у общего окна «Работаю до …», модель иногда дублирует на навыке — показываем один раз.
  const globalHours = new Set(facts.filter((f) => f.kind === "availability" && f.constraintScope !== "fact").map(timeText).filter(Boolean));
  for (const f of facts) {
    // Отсутствующий / проданный ресурс («генератор я продал») — изменение ресурсов, а не условие работы.
    if (!isRestrictionFact(f) || isRevokedSkill(f) || f.kind === "resource") continue;
    if (f.kind === "capability" && f.constraintType !== "scope" && f.constraintType !== "exclusion" && globalHours.has(timeText(f))) {
      // Скрытый дубль общего окна: снимается вместе с ним (иначе часы на навыке продолжили бы действовать).
      if (f.id) hiddenDuplicates.push({ id: f.id, key: norm(`Работаю ${timeText(f)}`) });
      continue;
    }
    const phrase = f.phrase.trim();
    const when = timeText(f);
    const activityScoped = f.kind !== "availability" || f.constraintScope === "fact";
    let type: RestrictionType;
    let text: string;
    if (when || (f.kind === "availability" && f.constraintType !== "scope")) {
      type = "time";
      text = !when ? cap(phrase) : activityScoped && phrase ? `${cap(phrase)} — ${when}` : `Работаю ${when}`;
    } else if (f.constraintType === "scope") {
      type = "scope";
      text = cap(phrase);
    } else {
      type = "work";
      // «Могу копать» как подпись отказа → «Не выполняю: копать».
      text = `Не выполняю: ${phrase.replace(/^(я\s+)?(могу|умею)\s+/i, "")}`;
    }
    const key = norm(text);
    if (!phrase && !when) continue;
    const existing = byKey.get(key);
    if (existing) { if (f.id) existing.factIds.push(f.id); continue; }
    const item = { type, text, ...(f.id ? { id: f.id } : {}), factIds: f.id ? [f.id] : [] };
    byKey.set(key, item);
    out.push(item);
  }
  for (const d of hiddenDuplicates) byKey.get(d.key)?.factIds.push(d.id);
  return out;
}

export function pickRestrictions(facts: RestrictionFactRow[]): ProfileRestriction[] {
  return restrictionGroups(facts).map(({ factIds: _ids, ...r }) => r);
}
