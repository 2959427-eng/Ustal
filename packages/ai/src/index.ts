import { loadEnv } from "@ustal/config";
import type { AiProviderBundle } from "./types.js";
import { mockProviders } from "./providers/mock.js";
import { openAiProviders } from "./providers/openai.js";

export * from "./types.js";
export { mockProviders } from "./providers/mock.js";
export { openAiProviders, moderateWithRules } from "./providers/openai.js";

/** Единая точка получения провайдеров — читает AI_PROVIDER из конфигурации. */
export function getAiProviders(): AiProviderBundle {
  const env = loadEnv();
  return env.AI_PROVIDER === "openai" ? openAiProviders : mockProviders;
}
