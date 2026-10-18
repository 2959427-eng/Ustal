import { loadDotenvOnce } from "@ustal/config";

// Resolve this repository's root .env, regardless of the script's working directory.
// Explicit process variables retain precedence; no credentials are copied elsewhere.
loadDotenvOnce();

export function assertLiveAiEnvironment(source: NodeJS.ProcessEnv = process.env): void {
  const invalid: string[] = [];
  if (source.AI_PROVIDER !== "openai") invalid.push("AI_PROVIDER must be openai");
  if (!source.OPENAI_BASE_URL?.trim()) invalid.push("OPENAI_BASE_URL is required");
  else {
    try { new URL(source.OPENAI_BASE_URL); }
    catch { invalid.push("OPENAI_BASE_URL must be a valid URL"); }
  }
  if (!source.OPENAI_API_KEY?.trim()) invalid.push("OPENAI_API_KEY is required");
  if (invalid.length) throw new Error("Blind live environment invalid: " + invalid.join("; ") + ". Configure the repository root .env or process environment.");
}

export function safeEnvironmentError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of ["OPENAI_API_KEY", "TEST_DB_PASSWORD", "TEST_DB_ADMIN_PASSWORD", "TEST_DB_RUNTIME_PASSWORD"]) {
    const value = process.env[key];
    if (value) message = message.split(value).join("[REDACTED]");
  }
  return message.replace(/postgres(?:ql)?:\/\/\S+|sk-[\w-]+/g, "[REDACTED]");
}
