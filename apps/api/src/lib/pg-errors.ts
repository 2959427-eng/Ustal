/**
 * Ошибки Postgres, которые вызваны вводом клиента или конкурентностью, а не сбоем сервера → управляемый 4xx.
 *  - 22P02 — значение не того формата (как правило, id в адресе не uuid) → такого объекта нет;
 *  - 22021 / 22P05 — недопустимый символ (например, NUL) в тексте → некорректный запрос;
 *  - UX001 — запись от удалённого аккаунта (миграция 0026, триггер ustal_guard_deleted_user): сессии больше нет → 401;
 *  - 40P01 / 40001 / 55P03 — deadlock / serialization / lock timeout: действие не выполнено, можно повторить → 409.
 */
export function mapPgError(error: unknown): { status: number; body: { error: { code: string; message: string } } } | null {
  const e = error as { cause?: { code?: string }; code?: string };
  const pgCode = e.cause?.code ?? e.code;
  if (pgCode === "22P02") return { status: 404, body: { error: { code: "not_found", message: "Не найдено" } } };
  if (pgCode === "22021" || pgCode === "22P05")
    return { status: 400, body: { error: { code: "validation_error", message: "Текст содержит недопустимые символы" } } };
  if (pgCode === "UX001") return { status: 401, body: { error: { code: "unauthorized", message: "Invalid or expired token" } } };
  if (pgCode === "40P01" || pgCode === "40001" || pgCode === "55P03")
    return { status: 409, body: { error: { code: "conflict_retry", message: "Данные сейчас изменяются. Повторите через несколько секунд." } } };
  return null;
}
