/**
 * Дни недели в нормализации (2026-10-17, live FAIL: «Не работаю по воскресеньям» → daysOfWeek=[6], т.е. «только вс»).
 *
 * Контракт системы (matching day gate, GET /profile, хранение): daysOfWeek — РАЗРЕШЁННЫЕ дни (0=пн..6=вс), null — без
 * ограничения по дням. Модель путала знак у отрицаний, поэтому на проводе она отдаёт дни вместе с явным знаком
 * daysMode, а сервер детерминированно приводит их к разрешённым дням — downstream ничего не угадывает по тексту:
 *  - "allowed"  — перечислены разрешённые дни → они же;
 *  - "excluded" — перечислены запрещённые дни → дополнение до недели;
 *  - null       — фраза не задаёт ограничение по дням → null (даже если дни перечислены: «могу и по воскресеньям»).
 * Канон: уникальные, отсортированные. Пустой список и «все 7 дней» — не ограничение (null): исключить все дни
 * означало бы «не работаю никогда» — такое не превращается молча в пустой список разрешённых дней (matching читает
 * пустой список как «без ограничения»), а в null с тем же итогом для matching; разрешить все дни — тоже null.
 * Неверные значения (не 0..6, не целые, неизвестный режим) — ошибка: структурированный вызов чинится повтором,
 * потенциально перевёрнутые данные дальше не идут.
 */
export type DaysMode = "allowed" | "excluded";
const WEEK = [0, 1, 2, 3, 4, 5, 6];

export function resolveDaysOfWeek(days: number[] | null | undefined, mode: DaysMode | null | undefined): number[] | null {
  if (mode !== "allowed" && mode !== "excluded" && mode != null) throw new Error(`daysMode must be "allowed", "excluded" or null`);
  for (const d of days ?? []) if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error("daysOfWeek must contain ISO weekdays 0..6");
  if (mode == null) return null;
  const listed = [...new Set(days ?? [])].sort((a, b) => a - b);
  if (!listed.length || listed.length === 7) return null;
  return mode === "allowed" ? listed : WEEK.filter((d) => !listed.includes(d));
}
