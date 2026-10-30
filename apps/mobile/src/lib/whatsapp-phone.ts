export const WHATSAPP_PHONE_ERROR = "Укажите WhatsApp в формате +7 900 123-45-67 или оставьте поле пустым.";

/** No truncation: a malformed/overlong optional number must never become another valid number. */
export function normalizeWhatsappPhone(input: string): string | null {
  // Copied phone numbers may contain Unicode hyphen/non-breaking hyphen (e.g. WhatsApp on iOS).
  const text = input.replace(/[\u2010\u2011]/g, "-").trim();
  if (!text) return null;
  if (!/^\+?[\d\s()-]+$/.test(text)) throw new Error(WHATSAPP_PHONE_ERROR);
  let digits = text.replace(/\D/g, "");
  if (text.startsWith("+") && (digits.length !== 11 || !digits.startsWith("7"))) throw new Error(WHATSAPP_PHONE_ERROR);
  if (digits.length === 11 && /^[78]/.test(digits)) digits = digits.slice(1);
  if (!/^\d{10}$/.test(digits)) throw new Error(WHATSAPP_PHONE_ERROR);
  return `+7${digits}`;
}

/** Server validation details are diagnostic data, not user-facing copy. */
export function profileSaveError(error: unknown): string {
  if (error instanceof Error && /whatsappPhone|Телефон должен|Укажите WhatsApp/.test(error.message)) return WHATSAPP_PHONE_ERROR;
  return "Не удалось сохранить изменения. Проверьте подключение и попробуйте ещё раз.";
}
