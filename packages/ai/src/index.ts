import { loadEnv } from "@ustal/config";
import type { AiProviderBundle } from "./types.js";
import { mockProviders } from "./providers/mock.js";
import { openAiProviders } from "./providers/openai.js";

export * from "./types.js";
export { deriveOpenAiRecipientConfiguration, currentOpenAiRecipientConfiguration, type ActualRecipientConfiguration } from "./recipient-binding.js";
export { AiConsentDenied, configureConsentDispatch, withAiConsentContext, type AiConsentContext, type ConsentPublication, type ConsentAuthorizer } from "./consent-dispatch.js";
export * from "./record-run.js";
export { mockProviders } from "./providers/mock.js";
export { reviewPipelineFingerprint, fingerprintReviewPipeline, collectReviewSources, REVIEW_FINGERPRINT_VERSION, type ReviewPipelineDescriptorInput } from "./review-fingerprint.js";
export { PROFILE_MESSAGE_SEPARATOR } from "./source-evidence.js";
export { openAiProviders, moderateWithRules, PROFILE_FACTS_PROMPT_VERSION, SEMANTIC_REVIEW_PROMPT_VERSION } from "./providers/openai.js";

/** Phase 1 profile_facts: pipeline id + the model the configured provider will use (extraction ledger key). */
export const PROFILE_FACTS_PIPELINE_VERSION = "profile-facts-v1";
export function profileFactsModel(): string {
  const env = loadEnv();
  return env.AI_PROVIDER === "openai" ? env.AI_MODEL_NORMALIZATION : "mock";
}

/** Единая точка получения провайдеров — читает AI_PROVIDER из конфигурации. */
export function getAiProviders(): AiProviderBundle {
  const env = loadEnv();
  return env.AI_PROVIDER === "openai" ? openAiProviders : mockProviders;
}
