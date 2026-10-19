import { AsyncLocalStorage } from "node:async_hooks";

/** Dormant transport infrastructure: no DB authorizer, activation or worker context integration. */
export interface AiConsentContext {
  subjectUserIds: readonly string[]; purpose: string; operation: string; traceId: string;
}
export interface ConsentPublication {
  approved: true; policyId: string; policyHash: string; purpose: string;
  provider: string; endpoint: string; recipientBinding: string;
}
export type ConsentAuthorizer = (input: {
  /** ALL subjects must be checked in ONE fresh committed snapshot; never per-subject reads. */
  subjectUserIds: readonly string[]; publication: Readonly<ConsentPublication>;
  operation: string; traceId: string;
}) => Promise<boolean>;
interface DispatchConfiguration {
  mode: "off" | "enforced"; publication?: ConsentPublication; authorize?: ConsentAuthorizer;
}
type DenialReason = "context_missing" | "context_invalid" | "publication_missing" | "publication_mismatch" |
  "authorizer_missing" | "not_granted" | "check_unavailable" | "invalid_authorizer_result";
export class AiConsentDenied extends Error {
  readonly name = "AiConsentDenied";
  constructor(readonly code: "consent_required" | "policy_unavailable", readonly reason: DenialReason) {
    super(code); // No source text, subject identifiers, endpoint credentials or underlying error cause.
  }
}
interface ConsentState { context: Readonly<AiConsentContext>; denial?: AiConsentDenied }
const storage = new AsyncLocalStorage<ConsentState>();
let configuration: Readonly<DispatchConfiguration> = Object.freeze({ mode: "off" });
let configured = false;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const label = /^[a-z][a-z0-9_.:-]{0,99}$/;

/** Bootstrap-only, once per process. No env flag can silently activate/downgrade this infrastructure. */
export function configureConsentDispatch(input: DispatchConfiguration): void {
  if (configured) throw new Error("Consent dispatch configuration is bootstrap-only");
  if (input.mode !== "off" && input.mode !== "enforced") throw new Error("Invalid consent dispatch mode");
  configuration = Object.freeze({ ...input, publication: input.publication ? Object.freeze({ ...input.publication }) : undefined });
  configured = true;
}
/** Server-owned context only: never construct from client identity fields or model output. */
export function withAiConsentContext<T>(context: AiConsentContext, run: () => Promise<T>): Promise<T> {
  if (!context || !Array.isArray(context.subjectUserIds) || !context.subjectUserIds.length || context.subjectUserIds.length > 100 ||
      context.subjectUserIds.some(id => typeof id !== "string" || !uuid.test(id)) ||
      typeof context.purpose !== "string" || !label.test(context.purpose) ||
      typeof context.operation !== "string" || !label.test(context.operation) ||
      typeof context.traceId !== "string" || !context.traceId || context.traceId.length > 200)
    return Promise.reject(new AiConsentDenied("consent_required", "context_invalid"));
  const frozen = Object.freeze({ subjectUserIds: Object.freeze([...new Set(context.subjectUserIds.map(id => id.toLowerCase()))].sort()),
    purpose: context.purpose, operation: context.operation, traceId: context.traceId });
  return storage.run({ context: frozen }, run);
}
function deny(reason: DenialReason, unavailable = false): never {
  const state = storage.getStore();
  const error = state?.denial ?? new AiConsentDenied(unavailable ? "policy_unavailable" : "consent_required", reason);
  if (state) state.denial = error;
  throw error;
}
function endpoint(value: string): URL | null {
  try {
    const result = new URL(value);
    return ["http:", "https:"].includes(result.protocol) && !result.username && !result.password && !result.search && !result.hash ? result : null;
  } catch { return null; }
}
/** This does NOT read DB or infer a real vendor approval. A future trusted authorizer must verify it. */
async function authorizeDispatch(identity: { provider: string; endpoint: string }, actualRequest = false): Promise<void> {
  if (configuration.mode === "off") return;
  const state = storage.getStore();
  if (!state) deny("context_missing");
  if (state.denial) throw state.denial;
  const publication = configuration.publication;
  if (!publication || publication.approved !== true || !uuid.test(publication.policyId) || !digest.test(publication.policyHash) ||
      !digest.test(publication.recipientBinding) || !label.test(publication.purpose)) deny("publication_missing");
  const declared = endpoint(publication.endpoint), target = endpoint(identity.endpoint);
  if (!declared || !target || publication.provider !== identity.provider || publication.purpose !== state.context.purpose)
    deny("publication_mismatch");
  const base = declared.pathname.replace(/\/$/, ""), path = target.pathname.replace(/\/$/, "");
  if (declared.origin !== target.origin || (actualRequest ? path !== base && !path.startsWith(base + "/") : path !== base))
    deny("publication_mismatch");
  const authorize = configuration.authorize;
  if (!authorize) deny("authorizer_missing", true);
  let result: boolean;
  try { result = await authorize(Object.freeze({ subjectUserIds: state.context.subjectUserIds, publication,
    operation: state.context.operation, traceId: state.context.traceId })); }
  catch { deny("check_unavailable", true); }
  if (typeof result !== "boolean") deny("invalid_authorizer_result", true);
  if (!result) deny("not_granted");
  if (state.denial) throw state.denial;
}

/** Actual SDK fetch: checked for EVERY request/transport retry, not merely the first model call. */
export const consentGuardedOpenAiFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  await authorizeDispatch({ provider: "openai", endpoint: url }, true);
  // Native fetch follows redirects internally without invoking this guard again. In enforced mode
  // reject redirects entirely so 307/308 cannot forward body/credentials outside approved recipient.
  return globalThis.fetch(input, configuration.mode === "enforced" ? { ...init, redirect: "error" } : init);
};

/** Covers directly exported public providers, audio pre-fetch and swallowed nested verifier errors. */
export function guardAiProvider<T extends object>(provider: T, identity: () => { provider: string; endpoint: string }): T {
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(provider, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      if (!wrappers.has(property)) wrappers.set(property, async (...args: unknown[]) => {
        if (configuration.mode === "off") return Reflect.apply(method, target, args);
        const state = storage.getStore();
        await authorizeDispatch(identity());
        try {
          const result: unknown = await Reflect.apply(method, target, args);
          if (state?.denial) throw state.denial;
          return result;
        } catch (error) {
          // SDK may wrap a thrown fetch denial; internal verifier catch may swallow it entirely.
          // Mutable per-context sticky state preserves the original sanitized policy outcome in both cases.
          if (state?.denial) throw state.denial;
          throw error;
        }
      });
      return wrappers.get(property);
    },
  });
}
