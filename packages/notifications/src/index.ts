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
  if (env.NODE_ENV === "production" && env.PUSH_PROVIDER !== "expo") throw new Error("Production push requires PUSH_PROVIDER=expo");
  return env.PUSH_PROVIDER === "expo" ? expoPushProvider : mockPushProvider;
}
