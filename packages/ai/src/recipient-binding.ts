import { createHash } from "node:crypto";
import { canonicalRecipientEndpoint } from "@ustal/config";
import type OpenAI from "openai";
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
  return deriveEffective({ endpoint, models: input.models, effective, organization, project });
}

function deriveEffective(input: { endpoint: string; models: Record<string, string>; effective: readonly (readonly [string, string])[];
  organization: string | null; project: string | null }): Readonly<ActualRecipientConfiguration> {
  const { endpoint, organization, project } = input;
  const routeHeaders = input.effective.filter(([name]) => !credential.test(name) && !["openai-organization", "openai-project"].includes(name))
    .map(([name, value]) => [name, sha(value)]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
  const models = Object.keys(input.models).sort().map(name => [name, input.models[name]]);
  if (!models.length || models.some(([, value]) => typeof value !== "string" || !value?.trim())) throw new Error("Invalid recipient models");
  const recipientBinding = sha(JSON.stringify({ schema: "ai-recipient-binding-v1", provider: "openai", endpoint, models,
    organization: organization === null ? null : sha(organization), project: project === null ? null : sha(project), routeHeaders }));
  return Object.freeze({ provider: "openai", endpoint, recipientBinding });
}

/** Internal production projection used by the provider-owned helper, not a client/reset export. */
export async function deriveOpenAiRecipientConfigurationFromClient(client: OpenAI, models: Record<string, string>): Promise<Readonly<ActualRecipientConfiguration>> {
  try {
    const sdk = client as unknown as { baseURL: string; _options?: { defaultHeaders?: unknown };
      buildHeaders?: (input: { options: Record<string, never>; method: string; bodyHeaders: Record<string, string>; retryCount: number }) => Promise<Headers> };
    if (!sdk._options || typeof sdk.buildHeaders !== "function") throw Error();
    const custom = sdk._options.defaultHeaders;
    let names: string[] = [];
    if (custom instanceof Headers) names = [...custom.keys()];
    else if (Array.isArray(custom)) {
      if (!custom.every(item => Array.isArray(item) && typeof item[0] === "string")) throw Error();
      names = custom.map(item => item[0]);
    } else if (custom && typeof custom === "object") {
      const value = custom as { values?: unknown; nulls?: unknown };
      if (value.values instanceof Headers || value.nulls instanceof Set) {
        if (!(value.values instanceof Headers) || !(value.nulls instanceof Set) || [...value.nulls].some(name => typeof name !== "string")) throw Error();
        names = [...value.values.keys(), ...value.nulls] as string[];
      } else names = Object.keys(custom);
    } else if (custom !== undefined && custom !== null) throw Error();
    // Installed SDK supplies actual precedence/null deletion/auth handling. No request is dispatched.
    const headers = await sdk.buildHeaders.call(client, { options: {}, method: "post", bodyHeaders: { "Content-Type": "application/json" }, retryCount: 0 });
    if (!(headers instanceof Headers)) throw Error();
    const effective: [string, string][] = [];
    for (const name of [...new Set(names.map(name => name.toLowerCase()))]) {
      const value = headers.get(name); if (value !== null) effective.push([name, value]);
    }
    return deriveEffective({ endpoint: canonicalRecipientEndpoint(sdk.baseURL), models, effective,
      organization: headers.get("openai-organization"), project: headers.get("openai-project") });
  } catch { throw new Error("Unable to derive actual SDK recipient configuration"); }
}
