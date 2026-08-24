import { loadEnv } from "@ustal/config";
import type { PushProvider } from "../types.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Настоящий Expo Push API — https://exp.host/--/api/v2/push/send. Не требует
 * Apple/Google developer-аккаунтов на этом шаге (см. architecture.md §5 п.9 —
 * это ограничение относится к подписанной сборке приложения и к APNs
 * credentials, которые сам Expo прячет за собой для managed workflow); нужен
 * только реальный `expoPushToken` с настоящего устройства, которого у нас в
 * этой сессии нет. Заготовка на боевое использование, как openAiProviders/
 * s3Storage в других пакетах.
 */
export const expoPushProvider: PushProvider = {
  name: "expo",
  async send(input) {
    const env = loadEnv();
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          to: input.expoPushToken,
          title: input.title,
          body: input.body,
          data: input.data ?? {},
        }),
      });
      const json = (await response.json()) as { data?: ExpoTicket | ExpoTicket[] };
      const ticket = Array.isArray(json.data) ? json.data[0] : json.data;
      if (!ticket || ticket.status !== "ok") {
        return {
          ok: false,
          providerMessageId: null,
          error: ticket?.message ?? ticket?.details?.error ?? `HTTP ${response.status}`,
        };
      }
      return { ok: true, providerMessageId: ticket.id ?? null, error: null };
    } catch (err) {
      return { ok: false, providerMessageId: null, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
