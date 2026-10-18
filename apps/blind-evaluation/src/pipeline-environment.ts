import { assertLiveAiEnvironment } from "./environment.js";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { getTestDbConfig, verifyTestDbIsolation } from "./test-db-config.js";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export function runtimeConfig() {
  const config = getTestDbConfig();
  const check = verifyTestDbIsolation(config);
  if (!check.isolated) throw new Error(check.errors.join("; "));
  return { ...config, user: `${config.user}_runtime`, password: process.env.TEST_DB_RUNTIME_PASSWORD || config.password };
}
export function databaseUrl(config: ReturnType<typeof getTestDbConfig>): string {
  const url = new URL("postgresql://localhost");
  url.hostname = config.host; url.port = String(config.port); url.pathname = `/${config.database}`;
  url.username = config.user; url.password = config.password;
  return url.href;
}
export function createRuntimePool() {
  return new Pool({ ...runtimeConfig(), options: "-c search_path=public", connectionTimeoutMillis: 5000 });
}
// Must precede all worker/database imports. Never load a production database URL.
export function configurePipeline(mode: "dry" | "offline-test" | "live") {
  if (mode === "live") assertLiveAiEnvironment();
  process.env.DATABASE_URL = databaseUrl(runtimeConfig());
  process.env.NODE_ENV = "test";
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString("hex");
  process.env.JWT_REFRESH_SECRET = randomBytes(32).toString("hex");
  process.env.AI_PROVIDER = mode === "live" ? "openai" : "mock";
  if (mode !== "live") return;
  if (process.env.CONFIRM_EVALUATION !== "true") throw new Error("Live run requires CONFIRM_EVALUATION=true");

}
export async function verifyRuntimeIsolation(pool: Pool) {
  const config = runtimeConfig();
  const identity = await pool.query("SELECT current_database() AS db, current_user AS role");
  if (identity.rows[0].db !== config.database || identity.rows[0].role !== config.user) throw new Error("Runtime DB identity mismatch");
  const role = await pool.query("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user");
  if (Object.values(role.rows[0]).some(Boolean)) throw new Error("Runtime role is privileged");
  try { await pool.query("SELECT expected_label FROM blind_evaluation.holdout_cases LIMIT 0"); }
  catch (error) { if ((error as {code?: string}).code === "42501") return; throw error; }
  throw new Error("Runtime role can read holdout labels");
}
