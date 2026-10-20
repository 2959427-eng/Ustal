import { createHash } from "node:crypto";
import { canonicalRecipientEndpoint, loadEnv } from "@ustal/config";
import { sdkEffectiveCustomHeaders } from "./review-fingerprint.js";

export interface ActualRecipientConfiguration { provider: string; endpoint: string; recipientBinding: string }
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const credential = /^(?:authorization|proxy-authorization|(?:[a-z0-9]+[-_])*api[-_]?key)$/i;

/** Pure explicit fixture/config descriptor. This is NOT a registry approval or user grant. */
export function deriveOpenAiRecipientConfiguration(input: {
  endpoint: string; models: Record<string, string>; env: Record<string, string | undefined>;
}): Readonly<ActualRecipientConfiguration> {
  const endpoint = canonicalRecipientEndpoint(input.endpoint);
  const effective = sdkEffectiveCustomHeaders(input.env.OPENAI_CUSTOM_HEADERS) ?? [];
  if (effective.some(([name]) => name.startsWith("#"))) throw new Error("Invalid recipient routing headers");
  const custom = new Map(effective);
  const read = (name: string) => input.env[name]?.trim() || null;
  const organization = custom.has("openai-organization") ? custom.get("openai-organization")! : read("OPENAI_ORG_ID");
  const project = custom.has("openai-project") ? custom.get("openai-project")! : read("OPENAI_PROJECT_ID");
  const routeHeaders = effective.filter(([name]) => !credential.test(name) && !["openai-organization", "openai-project"].includes(name))
    .map(([name, value]) => [name, sha(value)]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
  const models = Object.keys(input.models).sort().map(name => [name, input.models[name]]);
  if (!models.length || models.some(([, value]) => typeof value !== "string" || !value?.trim())) throw new Error("Invalid recipient models");
  const recipientBinding = sha(JSON.stringify({ schema: "ai-recipient-binding-v1", provider: "openai", endpoint, models,
    organization: organization === null ? null : sha(organization), project: project === null ? null : sha(project), routeHeaders }));
  return Object.freeze({ provider: "openai", endpoint, recipientBinding });
}

/** Server-owned current configuration. No client/publication input and no credential values returned. */
export function currentOpenAiRecipientConfiguration(): Readonly<ActualRecipientConfiguration> {
  const env = loadEnv();
  if (env.AI_PROVIDER !== "openai") throw new Error("No real OpenAI recipient configured");
  return deriveOpenAiRecipientConfiguration({ endpoint: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", env: process.env,
    models: { extraction: env.AI_MODEL_EXTRACTION, normalization: env.AI_MODEL_NORMALIZATION, review: env.AI_MODEL_SEMANTIC_REVIEW,
      // These are the actual provider literals; unused config defaults must not claim different wire models.
      moderation: env.AI_MODEL_EXTRACTION, embedding: "text-embedding-3-small", stt: "whisper-1" } });
}
