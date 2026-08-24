import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadDatabaseUrl } from "./env.js";
import * as schema from "./schema.js";

let sqlClient: ReturnType<typeof postgres> | undefined;

export function getSql() {
  if (!sqlClient) {
    sqlClient = postgres(loadDatabaseUrl(), { max: 10 });
  }
  return sqlClient;
}

export function getDb() {
  return drizzle(getSql(), { schema });
}

export type Database = ReturnType<typeof getDb>;
export * as schema from "./schema.js";
