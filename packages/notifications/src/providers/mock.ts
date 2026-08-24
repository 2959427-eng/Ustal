import type { PushProvider } from "../types.js";

/**
 * Детерминированный mock для локальной разработки и тестов — без сетевых
 * вызовов. Используется по умолчанию, пока PUSH_PROVIDER=mock (см.
 * .env.example) — как и AI_PROVIDER/MEDIA_STORAGE_PROVIDER, реальных
 * устройств/токенов у нас в разработке нет, а настоящий Expo push к
 * несуществующему токену всё равно вернул бы ошибку — мок делает то же
 * самое явно и без сети.
 */
export const mockPushProvider: PushProvider = {
  name: "mock",
  async send(input) {
    return {
      ok: true,
      providerMessageId: `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      error: null,
    };
  },
};
