/**
 * Ввод российского номера на регистрации: префикс +7 фиксирован, пользователь вводит 10 цифр.
 * Отправляется прежний формат +7XXXXXXXXXX (ruPhoneSchema на сервере не меняется).
 */
export function phoneDigitsFromInput(text: string): string {
  let digits = text.replace(/\D/g, "");
  // Вставка полного номера: +7 900…, 7 900…, 8 900… — убираем код страны/междугородний префикс.
  if (digits.length > 10 && (digits.startsWith("7") || digits.startsWith("8"))) digits = digits.slice(1);
  return digits.slice(0, 10);
}

/** «900 123-45-67» — только отображение. */
export function formatPhoneDigits(digits: string): string {
  const d = digits.slice(0, 10);
  const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)];
  let out = parts[0]!;
  if (parts[1]) out += ` ${parts[1]}`;
  if (parts[2]) out += `-${parts[2]}`;
  if (parts[3]) out += `-${parts[3]}`;
  return out;
}

export const phoneFromDigits = (digits: string) => `+7${digits}`;
export const isCompletePhone = (digits: string) => /^\d{10}$/.test(digits);
