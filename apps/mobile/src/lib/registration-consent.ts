export type LegalDocumentId = "privacy" | "terms" | "ai-processing";
export interface LegalDocumentInfo { id: LegalDocumentId; available: boolean; version: string | null; path: string }

/** Регистрация возможна только когда политика и соглашение опубликованы: принимать несуществующий текст нельзя. */
export const registrationDocumentsReady = (docs: readonly LegalDocumentInfo[]) =>
  (["privacy", "terms"] as const).every((id) => docs.some((d) => d.id === id && d.available));

/** Проверка согласий на экране регистрации: ни одна отметка не ставится за пользователя. */
export function registrationConsentError(input: { acceptedRules: boolean; acceptedPdn: boolean; documentsReady: boolean; allowUnpublished: boolean }): string | null {
  if (!input.documentsReady && !input.allowUnpublished) return "Документы ещё не опубликованы — регистрация временно недоступна";
  if (!input.acceptedRules) return "Нужно принять пользовательское соглашение и политику обработки персональных данных";
  if (!input.acceptedPdn) return "Нужно согласие на обработку персональных данных";
  return null;
}
