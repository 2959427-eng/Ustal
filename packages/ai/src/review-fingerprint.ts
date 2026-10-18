import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { loadEnv } from "@ustal/config";

/**
 * Fingerprint of the ACTUAL AI review pipeline (2026-10-15, fix of cache key completeness).
 *
 * A memoized review verdict (worker ai-review-cache) may be reused only when the whole pipeline that produced it is
 * unchanged. Instead of trusting manual version strings, the fingerprint hashes:
 *  - the source text of the provider module and its full runtime import closure (relative modules and @ustal/*
 *    workspace packages, `import type` excluded): every system prompt (main review, scope/refusal/action/main-result
 *    verifiers), response schemas (zod + JSON-schema construction), evidence validation, review-constraint
 *    post-processing, repair loop and request parameters (temperature, structured-output mode) live there;
 *  - versions of the third-party packages in that closure (openai SDK, zod, zod-to-json-schema, ...);
 *  - runtime identity: provider, endpoint (OPENAI_BASE_URL, hashed only), review/extraction models, timeout, retries;
 *  - OpenAI SDK client identity the SDK reads from the environment by itself (client.js): OPENAI_ORG_ID,
 *    OPENAI_PROJECT_ID, the EFFECTIVE OPENAI_CUSTOM_HEADERS as built by the SDK itself (sdkEffectiveCustomHeaders),
 *    and the API key — every value only as sha256, never in plaintext.
 * Any edit of any of those files changes the fingerprint automatically (deliberately conservative: an edit of an
 * unrelated prompt in the same file also invalidates the cache, which only costs AI calls, never correctness).
 * If the closure cannot be read, the fingerprint is null and the caller must not use the cache.
 */
export const REVIEW_FINGERPRINT_VERSION = "review-pipeline-v3";

export interface SourcePart { path: string; content: string }
export interface ReviewPipelineDescriptorInput {
  reviewType: string;
  provider: string;
  endpoint: string | null;
  models: Record<string, string>;
  params: Record<string, number | string | null>;
  /** Digests only (see sdkClientIdentity); canonicalized with sorted keys. */
  client?: Record<string, unknown> | null;
  sources: SourcePart[];
  packages: Record<string, string>;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const normalize = (text: string) => text.replace(/\r\n/g, "\n");
/** Canonical JSON: sorted object keys, explicit null, arrays keep their order. */
function canonical(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Platform-independent source path: "/" separators, no drive letter (Windows and POSIX give the same string). */
export function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^[A-Za-z]:(?=\/)/, "");
}
/** Path of a source file relative to the repo root, the same on Windows and POSIX hosts. */
export function sourceRelativePath(base: string, file: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(base) || base.includes("\\");
  return normalizeSourcePath((windows ? win32 : posix).relative(base, file));
}

/**
 * Effective OPENAI_CUSTOM_HEADERS exactly as the installed OpenAI SDK builds them (fix 2026-10-16, Codex FAIL:
 * a hand-written case-insensitive "last wins" merge collided `X-Route:a / x-route:b / X-Route:c` with `x-route:c`,
 * while the SDK sends `b` vs `c`). No own merge semantics: a throwaway client is constructed (synchronous, offline)
 * with the given value in process.env, and its defaultHeaders — the object the SDK merges into every request — are
 * read back: lower-cased names, values as the SDK will send them. The SDK parses the variable into a plain object
 * (exact-case keys: a repeated exact name overwrites in place, keeping its first position) and then merges object keys
 * in order, each key replacing earlier values of the same lower-cased name — so line order and case DO matter.
 * Returns null when no custom header is sent. Invalid header names make every real client construction throw, so the
 * whole raw value is fingerprinted then. If the SDK internals change shape, this throws -> the fingerprint is null
 * and the cache is not used (a differential test against an actually sent request fails loudly).
 */
export function sdkEffectiveCustomHeaders(raw: string | undefined): [string, string][] | null {
  const saved = process.env.OPENAI_CUSTOM_HEADERS;
  if (raw === undefined) delete process.env.OPENAI_CUSTOM_HEADERS; else process.env.OPENAI_CUSTOM_HEADERS = raw;
  try {
    let client: OpenAI;
    try { client = new OpenAI({ apiKey: "fingerprint-only", baseURL: "http://127.0.0.1/fingerprint", organization: null, project: null }); }
    catch (error) {
      if (error instanceof TypeError && /Header name/.test(error.message)) return [["#invalid-custom-headers", sha(raw ?? "")]];
      throw error;
    }
    const defaults = (client as unknown as { _options?: { defaultHeaders?: unknown } })._options?.defaultHeaders;
    if (defaults === undefined || defaults === null) return null;
    const values = (defaults as { values?: unknown }).values;
    const nulls = (defaults as { nulls?: unknown }).nulls;
    if (!(values instanceof Headers) || !(nulls instanceof Set)) throw new Error("unexpected OpenAI SDK defaultHeaders shape");
    const entries = [...values.entries()].map(([name, value]) => [name, value] as [string, string]);
    return entries.length ? entries : null;
  } finally {
    if (saved === undefined) delete process.env.OPENAI_CUSTOM_HEADERS; else process.env.OPENAI_CUSTOM_HEADERS = saved;
  }
}

/**
 * OpenAI SDK client identity that changes requests without passing through loadEnv: the SDK reads these variables
 * from the environment itself (readEnv trims, empty = absent). Only sha256 digests leave this function.
 */
export function sdkClientIdentity(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const read = (name: string) => env[name]?.trim() || undefined;
  const digest = (value: string | undefined) => (value === undefined ? null : sha(value));
  const effective = sdkEffectiveCustomHeaders(env.OPENAI_CUSTOM_HEADERS);
  return { organization: digest(read("OPENAI_ORG_ID")), project: digest(read("OPENAI_PROJECT_ID")),
    customHeaders: effective ? effective.map(([name, value]) => [name, sha(value)]) : null, apiKey: digest(read("OPENAI_API_KEY")) };
}

/** Pure: the fingerprint of an explicit descriptor (used by tests to prove which changes miss). */
export function fingerprintReviewPipeline(input: ReviewPipelineDescriptorInput): string {
  const descriptor = {
    version: REVIEW_FINGERPRINT_VERSION,
    reviewType: input.reviewType,
    provider: input.provider,
    endpoint: input.endpoint === null ? null : sha(input.endpoint),
    models: Object.keys(input.models).sort().map((k) => [k, input.models[k]]),
    params: Object.keys(input.params).sort().map((k) => [k, input.params[k]]),
    sources: input.sources.map((s) => [normalizeSourcePath(s.path), sha(normalize(s.content))] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    packages: Object.keys(input.packages).sort().map((k) => [k, input.packages[k]]),
    client: input.client ?? null,
  };
  return sha(canonical(descriptor));
}

// Runtime (non-type) static imports/re-exports, including multi-line specifier lists.
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type[\s{])(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function tsPath(file: string): string | null {
  for (const candidate of [file.replace(/\.js$/, ".ts"), file.replace(/\.js$/, ".tsx"), file, `${file}.ts`, join(file, "index.ts")])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

function packageVersion(name: string, fromFile: string): string {
  const req = createRequire(fromFile);
  try { return String((req(`${name}/package.json`) as { version?: string }).version ?? "unknown"); }
  catch {
    try {
      let dir = dirname(req.resolve(name));
      while (dir !== dirname(dir)) {
        const pkg = join(dir, "package.json");
        if (existsSync(pkg)) { const json = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string }; if (json.name === name) return json.version ?? "unknown"; }
        dir = dirname(dir);
      }
    } catch { /* fall through */ }
    return "unresolved";
  }
}

/** Source closure of a module: relative modules and @ustal/* workspace packages, followed recursively. */
export function collectReviewSources(rootFile: string): { files: string[]; packages: Record<string, string> } {
  const files = new Set<string>(), packages: Record<string, string> = {};
  const queue = [rootFile];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1]!;
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) {
        const next = tsPath(resolve(dirname(file), spec));
        if (!next) throw new Error(`review fingerprint: unresolved import ${spec}`);
        queue.push(next);
      } else if (spec.startsWith("@ustal/")) {
        const next = tsPath(createRequire(file).resolve(spec));
        if (!next) throw new Error(`review fingerprint: unresolved workspace import ${spec}`);
        queue.push(next);
      } else {
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        packages[name] = packageVersion(name, file);
      }
    }
  }
  return { files: [...files], packages };
}

const providerRoot = (provider: string) =>
  tsPath(fileURLToPath(new URL(provider === "openai" ? "./providers/openai.js" : "./providers/mock.js", import.meta.url)));

let cached: { envKey: string; byType: Map<string, string | null> } | null = null;

/** Fingerprint for the current process configuration; null = cannot prove the pipeline, do not use the cache. */
export function reviewPipelineFingerprint(reviewType: string): string | null {
  const env = loadEnv();
  const runtime = {
    provider: env.AI_PROVIDER,
    endpoint: env.AI_PROVIDER === "openai" ? env.OPENAI_BASE_URL ?? "openai-default" : null,
    models: { semanticReview: env.AI_MODEL_SEMANTIC_REVIEW, extraction: env.AI_MODEL_EXTRACTION },
    params: { requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES },
    client: env.AI_PROVIDER === "openai" ? sdkClientIdentity() : null,
  };
  const envKey = JSON.stringify(runtime);
  if (!cached || cached.envKey !== envKey) cached = { envKey, byType: new Map() };
  if (cached.byType.has(reviewType)) return cached.byType.get(reviewType)!;
  let value: string | null = null;
  try {
    const root = providerRoot(env.AI_PROVIDER);
    if (!root) throw new Error("provider module not found");
    const base = resolve(dirname(root), "../../../..");
    const { files, packages } = collectReviewSources(root);
    value = fingerprintReviewPipeline({ reviewType, ...runtime, packages,
      sources: files.map((f) => ({ path: sourceRelativePath(base, f), content: readFileSync(f, "utf8") })) });
  } catch (error) {
    console.error(JSON.stringify({ event: "review_fingerprint_unavailable", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
  }
  cached.byType.set(reviewType, value);
  return value;
}
