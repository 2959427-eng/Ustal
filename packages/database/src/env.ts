import { z } from "zod";
import { loadDotenvOnce } from "@ustal/config";

/**
 * @ustal/database — leaf-пакет, которым пользуются и api/worker (полная
 * конфигурация приложения), и служебные скрипты (`db:migrate`, `db:seed`,
 * `drizzle-kit`), которым не нужны JWT-секреты и остальная конфигурация
 * приложения. Поэтому у пакета своя минимальная схема — только DATABASE_URL,
 * а не общий loadEnv() из @ustal/config (который требует JWT_ACCESS_SECRET
 * и т.д. и упал бы при обычном `npm run db:migrate`).
 */
const dbEnvSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgres://").or(z.string().startsWith("postgresql://")),
});

let cached: string | undefined;

export function loadDatabaseUrl(): string {
  if (cached) return cached;
  loadDotenvOnce();
  const parsed = dbEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid database configuration: DATABASE_URL is required (postgres:// or postgresql://)`);
  }
  cached = parsed.data.DATABASE_URL;
  return cached;
}
