import Constants from "expo-constants";
import { ApiRequestError } from "@ustal/api-client";
import { apiClient } from "./client";

export const SUPPORT_MIN_LENGTH = 5;
export const SUPPORT_MAX_LENGTH = 2000;

/** Текст ошибки для экрана поддержки; введённый текст при этом не теряется. */
export function supportErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) return "Слишком много обращений — попробуйте через час.";
    if (error.status === 503) return "Отправка обращений временно недоступна. Попробуйте позже.";
    if (error.status === 400) return `Опишите проблему: от ${SUPPORT_MIN_LENGTH} до ${SUPPORT_MAX_LENGTH} символов.`;
  }
  return "Не удалось отправить обращение. Проверьте подключение и попробуйте ещё раз.";
}

/** POST /support — письмо уходит на почту поддержки с сервера; имя и телефон сервер берёт из аккаунта. */
export function sendSupportMessage(text: string): Promise<{ sent: true }> {
  const appVersion = Constants.expoConfig?.version;
  return apiClient.request<{ sent: true }>("/support", {
    method: "POST",
    body: JSON.stringify(typeof appVersion === "string" ? { text: text.trim(), appVersion } : { text: text.trim() }),
  });
}
