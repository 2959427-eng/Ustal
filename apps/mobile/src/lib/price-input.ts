/**
 * Разбор цены, введённой пользователем (mobile follow-up QA 2026-10-14, F06). Прежде `Number("2000,50")`
 * давал NaN, а JSON превращал его в null — и PATCH стирал прежнюю цену. Теперь три исхода:
 *  - empty: поле пустое — цены нет (при редактировании это явное снятие цены);
 *  - ok: сумма в копейках; разделитель дробной части «,» или «.», до двух знаков, пробелы между
 *    разрядами допускаются («2 000,50»);
 *  - invalid: всё остальное («20abc», «2000,505», «-5», «0») — запрос не отправляется.
 */
export type PriceInput = { kind: "empty" } | { kind: "ok"; minor: number } | { kind: "invalid" };

export function parsePriceInput(text: string): PriceInput {
  const compact = text.replace(/[\s  ]/g, "");
  if (!compact) return { kind: "empty" };
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(compact);
  if (!m) return { kind: "invalid" };
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor <= 0) return { kind: "invalid" };
  return { kind: "ok", minor };
}

export const PRICE_INPUT_ERROR = "Введите цену числом, например 2000 или 2000,50";
