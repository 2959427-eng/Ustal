import { loadEnv } from "@ustal/config";
import { mockSmsProvider } from "./mock.js";

export interface SmsProvider {
  send(phone: string, code: string): Promise<void>;
}

/**
 * Единственная точка выбора SMS-провайдера. Подключение реального провайдера
 * (например, СМС-агрегатора) — это ещё один `case` здесь и новые переменные
 * окружения под него; ни схема БД, ни роуты, ни мобильный клиент не меняются.
 */
export function getSmsProvider(): SmsProvider {
  const env = loadEnv();
  switch (env.SMS_PROVIDER) {
    case "mock":
      return mockSmsProvider;
    default: {
      const exhaustive: never = env.SMS_PROVIDER;
      throw new Error(`Unknown SMS_PROVIDER: ${exhaustive as string}`);
    }
  }
}
