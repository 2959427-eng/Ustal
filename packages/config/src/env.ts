import { z } from "zod";
import { loadDotenvOnce } from "./dotenv-root.js";

/**
 * Единая точка чтения переменных окружения. Ничего в коде (api/worker/admin)
 * не должно читать process.env напрямую — только через этот модуль, чтобы
 * секреты не утекали в мобильный bundle и чтобы отсутствующая переменная
 * падала явной ошибкой при старте, а не тихо где-то в середине запроса.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.string().default("info"),

    DATABASE_URL: z.string().url().or(z.string().startsWith("postgres://")),

    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_REFRESH_SECRET: z.string().min(16),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),

    USTAL_REGISTRATION_AGE_MODE: z.enum(["compatibility", "required"]).default("compatibility"),
    USTAL_AI_CONSENT_MODE: z.enum(["off", "enforced"]).default("off"),
    USTAL_AI_CONSENT_PURPOSE: z.preprocess(v => v === "" ? undefined : v, z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/).optional()),
    AI_PROVIDER: z.enum(["openai", "mock"]).default("mock"),
    OPENAI_API_KEY: z.string().optional(),
    // Пустое значение (как в .env.example: "OPENAI_BASE_URL=") = не задано. Без этого
    // скопированный как есть .env.example валил старт API и worker ("Invalid url").
    OPENAI_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
    AI_MODEL_EXTRACTION: z.string().default("gpt-4o-mini"),
    AI_MODEL_NORMALIZATION: z.string().default("gpt-4.1-mini"),
    AI_MODEL_SEMANTIC_REVIEW: z.string().default("gpt-4.1-mini"),
    AI_MODEL_MODERATION: z.string().default("gpt-4o-mini"),
    AI_MODEL_EMBEDDING: z.string().default("text-embedding-3-small"),
    AI_MODEL_STT: z.string().default("whisper-1"),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(45000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),

    OBJECT_STORAGE_ENDPOINT: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
    OBJECT_STORAGE_BUCKET: z.string().default("ustal-media"),
    OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
    OBJECT_STORAGE_SECRET_KEY: z.string().optional(),

    MEDIA_STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
    MEDIA_LOCAL_DIR: z.string().default("./data/media"),

    EXPO_ACCESS_TOKEN: z.string().optional(),
    PUSH_PROVIDER: z.enum(["expo", "mock"]).default("mock"),

    PROFILE_FREEFORM_EDITS_PER_HOUR: z.coerce.number().default(10),
    // Direct revoke/restore пунктов профиля без AI (2026-10-17): отдельный лимит, не тратит лимит AI-сообщений.
    PROFILE_ITEM_ACTIONS_PER_HOUR: z.coerce.number().default(30),
    // Phase 1 profile_facts (SHADOW): a separate per-input AI extraction of structured profile facts.
    // Never read by matching/feed/public profile. "disabled" stops enqueueing new extraction jobs.
    PROFILE_FACTS_EXTRACTION: z.enum(["enabled", "disabled"]).default("enabled"),
    CONTACT_UNLOCKS_PER_HOUR: z.coerce.number().default(30),
    ORDERS_PER_HOUR: z.coerce.number().default(20),
    REPORTS_PER_HOUR: z.coerce.number().default(20),
    MEDIA_UPLOADS_PER_HOUR: z.coerce.number().default(30),
    // Простая суммарная квота хранения на пользователя (все медиа вместе, фото+аудио).
    // Не rate-limit по времени, а фиксированный потолок — анти-abuse для диска/S3.
    MEDIA_STORAGE_MAX_BYTES_PER_USER: z.coerce.number().default(500 * 1024 * 1024),
    // Сколько доверенных reverse-proxy стоит перед API (prod: Caddy = 1). 0 — прямое подключение (dev):
    // тогда X-Forwarded-For игнорируется, а rate-limit считается по реальному IP сокета.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    // Подтверждение телефона (OTP), см. docs/architecture.md: архитектура готова заранее,
    // включается флагом без переделки регистрации.
    //  - disabled (по умолчанию, dev/ранний запуск): регистрация без SMS, phoneVerifiedAt=null,
    //    это не блокирует использование приложения — только для сравнения счётов/поддержки.
    //  - required_for_new: новые регистрации обязаны подтвердить номер кодом; уже
    //    существующие неподтверждённые пользователи не блокируются — им лишь предлагается
    //    подтвердить номер при следующем входе (POST /auth/login возвращает phoneVerificationSuggested).
    PHONE_VERIFICATION_MODE: z.enum(["disabled", "required_for_new"]).default("disabled"),
    // Только "mock" реализован сейчас (лог + память процесса, для dev/тестов). Реальный
    // провайдер подключается позже как ещё один case в apps/api/src/lib/sms/index.ts —
    // без изменений в роутах/схемах данных.
    SMS_PROVIDER: z.enum(["mock"]).default("mock"),
    OTP_CODE_TTL_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    OTP_REQUEST_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
    OTP_REQUESTS_PER_PHONE_PER_DAY: z.coerce.number().int().min(1).max(100).default(5),
    // Секрет для короткоживущего токена «телефон подтверждён» (POST /auth/otp/verify →
    // POST /auth/register). Отдельный от JWT_ACCESS_SECRET намеренно — токен не должен
    // подходить ни под один другой проверяющий его секрет payload.
    PHONE_VERIFICATION_SECRET: z.string().min(16).optional(),

    ADMIN_SESSION_SECRET: z.string().min(16).optional(),

    API_PORT: z.coerce.number().default(4000),
    ADMIN_PORT: z.coerce.number().default(4100),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.AI_PROVIDER === "openai" && !env.OPENAI_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENAI_BASE_URL"],
        message: "required in production when AI_PROVIDER=openai; production OpenAI traffic must go through relay",
      });
    }
    if (env.NODE_ENV === "production") {
      const issue = (key: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
      const parsedUrl = (key: string, value: string) => {
        try { return new URL(value); } catch { issue(key, "must be a valid URL"); return undefined; }
      };
      const unsafe = (value: string | undefined) => !value || /change-me|<SET_ME>|example|^dev-|^test-/i.test(value);
      for (const key of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "ADMIN_SESSION_SECRET"] as const) {
        if (unsafe(env[key]) || (env[key]?.length ?? 0) < 32) issue(key, "must be a unique production secret of at least 32 characters");
      }
      if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET || env.ADMIN_SESSION_SECRET === env.JWT_ACCESS_SECRET || env.ADMIN_SESSION_SECRET === env.JWT_REFRESH_SECRET) issue("JWT_ACCESS_SECRET", "authentication secrets must be distinct");
      if (env.AI_PROVIDER !== "openai") issue("AI_PROVIDER", "production requires openai");
      if (unsafe(env.OPENAI_API_KEY) || (env.OPENAI_API_KEY?.length ?? 0) < 32 || env.OPENAI_API_KEY?.startsWith("sk-")) issue("OPENAI_API_KEY", "production requires the protected relay client token");
      if (env.OPENAI_BASE_URL) {
        const url = parsedUrl("OPENAI_BASE_URL", env.OPENAI_BASE_URL);
        if (url && (url.protocol !== "https:" || url.hostname === "api.openai.com" || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1")) issue("OPENAI_BASE_URL", "must be an HTTPS relay URL ending in /v1 without credentials or query");
      }
      if (env.MEDIA_STORAGE_PROVIDER !== "s3") issue("MEDIA_STORAGE_PROVIDER", "production requires persistent S3 storage");
      for (const key of ["OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY", "OBJECT_STORAGE_SECRET_KEY"] as const) {
        if (unsafe(env[key])) issue(key, "required production S3 configuration");
      }
      if (env.OBJECT_STORAGE_ENDPOINT && !/^https:\/\//.test(env.OBJECT_STORAGE_ENDPOINT)) issue("OBJECT_STORAGE_ENDPOINT", "must use HTTPS");
      const dbUrl = parsedUrl("DATABASE_URL", env.DATABASE_URL);
      if (dbUrl) {
        try {
          const password = decodeURIComponent(dbUrl.password);
          if (unsafe(password) || ["ustal", "postgres", "password"].includes(password)) issue("DATABASE_URL", "requires a non-default database password");
        } catch { issue("DATABASE_URL", "invalid password encoding"); }
      }
    }
    // Мок-SMS ничего не отправляет реальному человеку — только в лог/память процесса.
    // Включить PHONE_VERIFICATION_MODE в production с ним нельзя: пользователи не получат код.
    if (env.NODE_ENV === "production" && env.PHONE_VERIFICATION_MODE !== "disabled" && env.SMS_PROVIDER === "mock") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SMS_PROVIDER"],
        message: "SMS_PROVIDER=mock запрещён в production при включённом PHONE_VERIFICATION_MODE — подключите реальный провайдер",
      });
    }
    if (env.PHONE_VERIFICATION_MODE !== "disabled" && !env.PHONE_VERIFICATION_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PHONE_VERIFICATION_SECRET"],
        message: "required when PHONE_VERIFICATION_MODE is not disabled",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Валидирует и кеширует process.env один раз за процесс — кроме тестов: там process.env
 * может меняться между кейсами в пределах одного процесса (см. apps/api/src/otp.integration.test.ts,
 * который переключает PHONE_VERIFICATION_MODE и лимиты OTP между кейсами), поэтому в
 * NODE_ENV=test кеш пропускается и конфиг парсится заново на каждый вызов.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && process.env.NODE_ENV !== "test") return cached;
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
