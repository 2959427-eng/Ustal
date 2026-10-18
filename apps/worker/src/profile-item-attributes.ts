/**
 * Подписи и характеристики пунктов профиля (2026-10-15): одно сообщение даёт несколько атомарных пунктов, у каждого —
 * короткая подпись для показа (label) и, у имеющегося ресурса, характеристики { key, value, unit }.
 * Модель предлагает их; здесь — детерминированная нормализация формы (не смысла): канонические ключи и единицы,
 * число вместо «1,5». Характеристики не читает matching — только профиль и его показ.
 */
export interface ResourceAttribute { key: string; value: string | number; unit: string | null }

/** Одинаковый смысл — один ключ. Только распространённые варианты написания, не закрытая схема. */
const KEY_ALIASES: Record<string, string> = {
  seats: "passenger_capacity", seat_count: "passenger_capacity", seating_capacity: "passenger_capacity",
  passengers: "passenger_capacity", passenger_seats: "passenger_capacity", capacity_passengers: "passenger_capacity",
  load_capacity: "payload", carrying_capacity: "payload", payload_capacity: "payload", max_load: "payload",
  cargo_capacity: "payload", lifting_capacity: "payload", weight_capacity: "payload",
  manufacturer: "brand", make: "brand", maker: "brand",
};
const UNIT_ALIASES: [RegExp, string][] = [
  [/^(т|тн|тонн[аы]?|t|ton|tons|tonne|tonnes)$/, "t"],
  [/^(кг|килограмм(а|ов)?|kg)$/, "kg"],
  [/^(м|метр(а|ов)?|m|meter|meters|metre|metres)$/, "m"],
  [/^(шт|штук[аи]?|мест[оа]?|человек|чел|пассажир(а|ов)?|pcs|seats?|people|persons?|passengers?)$/, "pcs"],
];
export function canonicalUnit(unit: string | null | undefined): string | null {
  const u = (unit ?? "").trim().toLowerCase().replace(/ё/g, "е").replace(/\.$/, "");
  if (!u) return null;
  for (const [re, canonical] of UNIT_ALIASES) if (re.test(u)) return canonical;
  return u.slice(0, 20);
}
export function canonicalKey(key: string): string | null {
  const k = key.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!k || !/^[a-z]/.test(k)) return null;
  return KEY_ALIASES[k] ?? k;
}
function canonicalValue(value: unknown): string | number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  const n = v.replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(n) ? Number(n) : v.slice(0, 120);
}
/** Характеристики в канонической форме; повтор ключа — побеждает последнее значение. */
export function normalizeAttributes(raw: unknown): ResourceAttribute[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, ResourceAttribute>();
  for (const a of raw as { key?: unknown; value?: unknown; unit?: unknown }[]) {
    if (!a || typeof a.key !== "string") continue;
    const key = canonicalKey(a.key);
    const value = canonicalValue(a.value);
    if (!key || value === null) continue;
    out.set(key, { key, value, unit: typeof value === "number" ? canonicalUnit(typeof a.unit === "string" ? a.unit : null) : null });
  }
  return [...out.values()];
}
/** Прежние характеристики, дополненные/заменённые новыми (по ключу). */
export function mergeAttributes(prior: ResourceAttribute[], next: ResourceAttribute[]): ResourceAttribute[] {
  const out = new Map(prior.map((a) => [a.key, a]));
  for (const a of next) out.set(a.key, a);
  return [...out.values()];
}
/** Новые характеристики что-то добавляют или меняют относительно прежних. */
export function attributesChange(prior: ResourceAttribute[], next: ResourceAttribute[]) {
  return next.some((a) => { const p = prior.find((x) => x.key === a.key); return !p || p.value !== a.value || p.unit !== a.unit; });
}
/** Подпись: обрезанная строка или null (тогда показывается phrase). Смысл подписи не правится. */
export function normalizeLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const l = label.replace(/\s+/g, " ").trim().replace(/[.;:,]+$/, "");
  if (!l) return null;
  return l.charAt(0).toUpperCase() + l.slice(1);
}
