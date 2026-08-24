import { z } from "zod";
import { loadDotenvOnce } from "./dotenv-root.js";

/**
 * Единая точка чтения переменных окружения. Ничего в коде (api/worker/admin)
 * не должно читать process.env напрямую — только через этот модуль, чтобы
 * секреты не утекали в мобильный bundle и чтобы отсутствующая переменная
 * падала явной ошибкой при старте, а не тихо где-то в середине запроса.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres://")),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),

  AI_PROVIDER: z.enum(["openai", "mock"]).default("mock"),
  OPENAI_API_KEY: z.string().optional(),
  AI_MODEL_EXTRACTION: z.string().default("gpt-4o-mini"),
  AI_MODEL_MODERATION: z.string().default("gpt-4o-mini"),
  AI_MODEL_EMBEDDING: z.string().default("text-embedding-3-small"),
  AI_MODEL_STT: z.string().default("whisper-1"),

  OBJECT_STORAGE_ENDPOINT: z.string().optional(),
  OBJECT_STORAGE_BUCKET: z.string().default("ustal-media"),
  OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().optional(),

  MEDIA_STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  MEDIA_LOCAL_DIR: z.string().default("./data/media"),

  EXPO_ACCESS_TOKEN: z.string().optional(),
  PUSH_PROVIDER: z.enum(["expo", "mock"]).default("mock"),

  PROFILE_FREEFORM_EDITS_PER_HOUR: z.coerce.number().default(15),
  CONTACT_UNLOCKS_PER_HOUR: z.coerce.number().default(30),

  ADMIN_SESSION_SECRET: z.string().min(16).optional(),

  API_PORT: z.coerce.number().default(4000),
  ADMIN_PORT: z.coerce.number().default(4100),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Валидирует и кеширует process.env один раз за процесс. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  loadDotenvOnce();
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  cached = parsed.data;
  return cached;
}
