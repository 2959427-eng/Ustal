import { loadEnv } from "@ustal/config";
import type { PushProvider } from "./types.js";
import { mockPushProvider } from "./providers/mock.js";
import { expoPushProvider } from "./providers/expo.js";

export * from "./types.js";
export { mockPushProvider } from "./providers/mock.js";
export { expoPushProvider } from "./providers/expo.js";

/** Единая точка получения провайдера — читает PUSH_PROVIDER из конфигурации. */
export function getPushProvider(): PushProvider {
  const env = loadEnv();
  return env.PUSH_PROVIDER === "expo" ? expoPushProvider : mockPushProvider;
}
