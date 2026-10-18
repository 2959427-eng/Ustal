import "./environment.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Test database connection configuration.
 * Isolated from production database via separate credentials and schema.
 *
 * Invariant: Connection uses TEST_DB_* environment variables, never
 * production DATABASE_URL. All queries execute against blind_evaluation schema.
 */

export interface TestDbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string; // Always "blind_evaluation" to prevent production data access
}

export function getTestDbConfig(): TestDbConfig {
  const host = process.env.TEST_DB_HOST || "localhost";
  const port = parseInt(process.env.TEST_DB_PORT || "5432");
  const database = process.env.TEST_DB_NAME || "ustal_blind_test";
  const user = process.env.TEST_DB_USER || "ustal_blind_test";
  const password = process.env.TEST_DB_PASSWORD || "test_password";
  const schema = "blind_evaluation"; // Fixed: never use production schema

  return { host, port, database, user, password, schema };
}

export function createTestPool(): Pool {
  const config = getTestDbConfig();
  const check = verifyTestDbIsolation(config);
  if (!check.isolated) throw new Error(check.errors.join("; "));

  const pool = new Pool({
    host: config.host, port: config.port, database: config.database,
    user: config.user, password: config.password,
    connectionTimeoutMillis: 5000,
    options: "-c search_path=blind_evaluation",
    application_name: "blind-evaluation-harness",
    // Disable SSL for test environment (use only for local/isolated testing)
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false,
  });

  pool.on("error", (err) => {
    console.error("[TestDB] Unexpected error on idle client", err);
  });

  return pool;
}

export async function createTestDb(pool: Pool) {
  return drizzle(pool);
}

/**
 * Verify that test database is isolated from production.
 * Checks:
 * 1. Connection string uses TEST_DB_* variables, never DATABASE_URL
 * 2. Schema name is "blind_evaluation", never "public"
 * 3. Database name contains "test" or matches TEST_DB_NAME
 */
export function verifyTestDbIsolation(config: TestDbConfig): {
  isolated: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!["localhost", "127.0.0.1", "::1"].includes(config.host)) errors.push("Test DB must be local");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) errors.push("Invalid test DB port");
  if (!/^ustal_[a-z0-9_]*test[a-z0-9_]*$/.test(config.user)) errors.push("Dedicated test role required");

  // Check 1: Database name should indicate test
  if (!/^ustal_[a-z0-9_]*test[a-z0-9_]*$/.test(config.database)) {
    errors.push(`Database name "${config.database}" does not indicate test environment`);
  }

  // Check 2: Schema must be blind_evaluation
  if (config.schema !== "blind_evaluation") {
    errors.push(`Schema "${config.schema}" is not "blind_evaluation" - risk of production data access`);
  }

  // Check 3: User should not be production user
  if (config.user === "postgres" || config.user === "ustal") {
    errors.push(`Database user "${config.user}" may be production user`);
  }

  return {
    isolated: errors.length === 0,
    errors,
  };
}
