/**
 * Полная схема БД USTAL (Drizzle ORM). Источник истины для миграций
 * (`npm run db:generate`). Соответствует docs/data-model.md.
 *
 * Денежные суммы — *_minor (копейки). Время — timestamptz (UTC).
 * embedding — pgvector, размерность 1536 (text-embedding-3-small).
 */
import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  bigint,
  numeric,
  timestamp,
  jsonb,
  vector,
  uniqueIndex,
  index,
  check,
  foreignKey,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const EMBEDDING_DIM = 1536;
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Справочники и пользователи
// ---------------------------------------------------------------------------

export const cities = pgTable("cities", {
  id: id(),
  name: varchar("name", { length: 100 }).notNull(),
  regionName: varchar("region_name", { length: 150 }).notNull(),
  federalDistrict: varchar("federal_district", { length: 100 }).notNull(),
  timezone: varchar("timezone", { length: 50 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    phone: varchar("phone", { length: 20 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    verificationLevel: varchar("verification_level", { length: 20 }).notNull().default("none"),
    status: varchar("status", { length: 20 }).notNull().default("active"), // active|blocked|deleted
    createdAt: createdAt(),
  },
  (t) => ({
    // один номер = максимум один активный аккаунт (частичный индекс на status='active')
    phoneActiveUnique: uniqueIndex("users_phone_active_unique")
      .on(t.phone)
      .where(sql`${t.status} = 'active'`),
  }),
);

export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  cityId: uuid("city_id").notNull().references(() => cities.id),
  whatsappPhone: varchar("whatsapp_phone", { length: 20 }),
  acceptedRulesAt: timestamp("accepted_rules_at", { withTimezone: true }).notNull(),
  acceptedPdnAt: timestamp("accepted_pdn_at", { withTimezone: true }).notNull(),
  avatarMediaId: uuid("avatar_media_id"),
  /** «О себе» — короткое описание, видно в публичном профиле. */
  about: varchar("about", { length: 500 }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSessions = pgTable(
  "user_sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    // Цепочка ротации refresh-токенов: у первой сессии (register/login) — новый familyId,
    // у каждой последующей (после /auth/refresh) — familyId родителя. При обнаружении reuse
    // (уже отозванный refresh предъявлен снова) отзывается вся family одним запросом — иначе
    // токен, угнанный и использованный раньше владельца, оставлял бы рабочую сессию у атакующего.
    familyId: uuid("family_id").notNull(),
    deviceInfo: text("device_info"),
    issuedAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    familyIdIdx: index("user_sessions_family_id_idx").on(t.familyId),
  }),
);

export const deviceInstallations = pgTable(
  "device_installations",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expoPushToken: text("expo_push_token").notNull(),
    platform: varchar("platform", { length: 10 }).notNull(), // ios|android
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => ({
    // Фаза 5: POST /devices идемпотентен по expo_push_token (upsert, не
    // дубли, docs/api.md «Уведомления и устройства») — тот же токен может
    // переехать на другого пользователя (переустановка приложения на другом
    // аккаунте на том же устройстве), поэтому уникален сам токен, а не пара
    // (user_id, token).
    tokenUnique: uniqueIndex("device_installations_token_unique").on(t.expoPushToken),
  }),
);

/**
 * Добавление #10 (см. docs/architecture.md §5): в исходной модели данных
 * решение "добавить Object Storage" (п.4) фиксировало инфраструктуру, но не
 * саму таблицу учёта загруженных файлов — без неё `order_media.media_id` и
 * `profile_source_inputs.audio_media_id` ссылаются в никуда. Минимальное
 * решение: единая таблица `media` для фото и аудио, ключ — во внешнем
 * хранилище (см. packages/storage), не сам файл.
 */
export const media = pgTable("media", {
  id: id(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 20 }).notNull(), // photo|audio
  storageProvider: varchar("storage_provider", { length: 20 }).notNull(), // local|s3
  storageKey: text("storage_key").notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: integer("size_bytes"),
  createdAt: createdAt(),
});

/**
 * Добавление #10 (продолжение): api.md требует `Idempotency-Key` на
 * `POST /orders` и `POST /profile/inputs`, но в исходной модели данных не
 * было таблицы для его хранения. Решение: общая таблица, переиспользуемая
 * любым endpoint'ом с идемпотентностью (endpoint+key+user уникальны);
 * повторный вызов с тем же ключом и тем же телом возвращает сохранённый
 * ответ, с другим телом — 409.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    endpoint: varchar("endpoint", { length: 100 }).notNull(),
    key: varchar("key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqueKey: uniqueIndex("idempotency_keys_unique").on(t.userId, t.endpoint, t.key),
  }),
);

// ---------------------------------------------------------------------------
// AI-профиль возможностей
// ---------------------------------------------------------------------------

export const profileSourceInputs = pgTable("profile_source_inputs", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  inputType: varchar("input_type", { length: 10 }).notNull(), // text|voice
  rawText: text("raw_text"),
  audioMediaId: uuid("audio_media_id"),
  transcript: text("transcript"),
  transcriptCorrected: text("transcript_corrected"),
  // Пауза «Проверка транскрипции» (экран 9 screens.md, claude/pipeline-split-design.md):
  // transcribing (voice, STT ещё не готов) -> awaiting_review (STT готов, можно
  // править) -> confirmed (ушло в profile_extraction). Text-ввод сразу confirmed —
  // там нечего разделять, правка уже произошла в композере до отправки.
  status: varchar("status", { length: 20 }).notNull().default("confirmed"),
  createdAt: createdAt(),
  // Source revoke (2026-09-28): the owner withdrew this message from the whole profile. One semantics:
  // facts derived from it are revoked, it is never (re-)extracted, never part of a future AI-profile
  // build, and the current AI profile is rebuilt from the remaining messages if it contained it
  // (matching then recalculates through rematch_requests). Raw text is kept only as internal audit.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => ({
  // Target of composite FKs from profile_facts/profile_fact_extractions: a fact's user_id must be the
  // owner of its source input (DB-level ownership guarantee, not only application code).
  idUserUnique: uniqueIndex("profile_source_inputs_id_user_unique").on(t.id, t.userId),
}));

/**
 * Состояние автоматической обработки сообщения профиля (QA 2026-10-14, дефект №2). Хранится отдельно от
 * задач pg-boss: архивирование задач, перезапуск worker или новая задача не сбрасывают счётчик неудач.
 * Одна строка на сообщение и этап (transcribe — STT, extraction — AI-разбор).
 *  - state: processing (идёт попытка) | retrying (последняя попытка не удалась, будет повтор) |
 *    exhausted (лимит неудач исчерпан — автоматически больше не ставится в AI) | succeeded.
 *  - lease_until/lease_owner: аренда попытки — одновременно сообщение обрабатывает только один worker;
 *    истёкшая аренда (worker остановился посреди попытки) засчитывается как неудача.
 *  - manual_resets/manual_reset_at: явный ручной повтор (retry-profile-input-cli) обнуляет счётчик.
 */
export const profileInputRecovery = pgTable("profile_input_recovery", {
  sourceInputId: uuid("source_input_id").notNull(),
  stage: varchar("stage", { length: 20 }).notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  state: varchar("state", { length: 20 }).notNull().default("processing"),
  attempts: integer("attempts").notNull().default(0),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lastError: text("last_error"),
  firstFailedAt: timestamp("first_failed_at", { withTimezone: true }),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
  exhaustedAt: timestamp("exhausted_at", { withTimezone: true }),
  succeededAt: timestamp("succeeded_at", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  leaseOwner: varchar("lease_owner", { length: 100 }),
  manualResets: integer("manual_resets").notNull().default(0),
  manualResetAt: timestamp("manual_reset_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.sourceInputId, t.stage] }),
  sourceInputFk: foreignKey({ name: "profile_input_recovery_source_input_fk", columns: [t.sourceInputId],
    foreignColumns: [profileSourceInputs.id] }).onDelete("cascade"),
  stateIdx: index("profile_input_recovery_state_idx").on(t.state),
  stageCheck: check("profile_input_recovery_stage_check", sql`${t.stage} in ('transcribe', 'extraction')`),
  stateCheck: check("profile_input_recovery_state_check", sql`${t.state} in ('processing', 'retrying', 'exhausted', 'succeeded')`),
}));

export const capabilityProfiles = pgTable("capability_profiles", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  profileVersion: integer("profile_version").notNull(),
  extractionVersion: varchar("extraction_version", { length: 50 }).notNull(),
  embeddingModel: varchar("embedding_model", { length: 100 }),
  sourceInputId: uuid("source_input_id").references(() => profileSourceInputs.id),
  // Пауза «Подтверждение изменений» (экран 10 screens.md,
  // claude/pipeline-split-design.md): draft (extraction только что создал,
  // ещё не текущий профиль) -> applied (текущий) -> superseded (был applied,
  // заменён более новым) | discarded (пользователь отклонил черновик).
  // Source revoke (2026-09-28): applied -> rebuild_pending (содержит отозванное сообщение; не
  // используется matching/feed до пересборки) -> superseded; draft -> invalidated (построен на
  // профиле с отозванным сообщением; неотозванный ввод переизвлекается поверх пересобранного профиля).
  status: varchar("status", { length: 20 }).notNull().default("applied"),
  createdAt: createdAt(),
  // Вектор документа этой версии устарел (2026-10-17, прямое действие кнопкой изменило текст навыков или у части
  // факта нет вектора). Пока true, matching НЕ использует вектор документа/профиля как положительный сигнал
  // (retrieval и documentSimilarity) — временная потеря recall вместо ложных совпадений по убранному навыку.
  // Сбрасывает только worker (profile_embedding_refresh) для ЭТОЙ версии вместе с записью нового вектора.
  embeddingStale: boolean("embedding_stale").notNull().default(false),
}, (t) => ({
  embeddingStale: index("capability_profiles_embedding_stale_idx").on(t.userId).where(sql`embedding_stale`),
}));

export const userCapabilities = pgTable("user_capabilities", {
  id: id(),
  capabilityProfileId: uuid("capability_profile_id")
    .notNull()
    .references(() => capabilityProfiles.id, { onDelete: "cascade" }),
  ontologyNodeId: uuid("ontology_node_id").notNull(),
  label: text("label").notNull(),
  proficiency: varchar("proficiency", { length: 20 }).notNull().default("unknown"),
  evidenceType: varchar("evidence_type", { length: 20 }).notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
});

export const userResources = pgTable("user_resources", {
  id: id(),
  capabilityProfileId: uuid("capability_profile_id")
    .notNull()
    .references(() => capabilityProfiles.id, { onDelete: "cascade" }),
  ontologyNodeId: uuid("ontology_node_id").notNull(),
  label: text("label").notNull(),
  resourceType: varchar("resource_type", { length: 20 }).notNull(),
  attributes: jsonb("attributes").notNull().default({}),
  evidenceType: varchar("evidence_type", { length: 20 }).notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
});

/**
 * Добавление #10 (продолжение): `capability_profiles.embedding_model` был
 * зарезервирован полем, но у профиля не было столбца-вектора (в отличие от
 * `order_embeddings`), хотя matching.md §13.2 требует semantic similarity и
 * для профиля тоже. Решение: та же схема, что и у `order_embeddings` —
 * отдельная таблица 1:1 с версией профиля (профиль append-only, значит и
 * эмбеддинг версионируется вместе с ним, а не перезаписывается).
 */
export const profileEmbeddings = pgTable("profile_embeddings", {
  capabilityProfileId: uuid("capability_profile_id")
    .primaryKey()
    .references(() => capabilityProfiles.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
  embeddingModel: varchar("embedding_model", { length: 100 }).notNull(),
});

export const learnedPreferences = pgTable("learned_preferences", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ontologyNodeId: uuid("ontology_node_id").notNull(),
  signal: varchar("signal", { length: 10 }).notNull(), // positive|negative
  source: varchar("source", { length: 30 }).notNull(),
  weight: numeric("weight", { precision: 5, scale: 3 }).notNull(),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Phase 1 profile_facts — SHADOW MODE (claude/extended-ai-profile-architecture-2026-09-27.md)
//
// A separate AI extraction turns EACH confirmed profile_source_inputs row into structured facts.
// Nothing in matching / feed / public profile / skills-resources reads these tables. The raw text
// stays in profile_source_inputs (never overwritten), so any input can be re-extracted later.
// ---------------------------------------------------------------------------

/**
 * One extraction attempt ledger row per (source input, pipeline/prompt/model version): idempotency,
 * failures available for retry/reprocessing, and the version every fact was produced with.
 * status: pending | succeeded | failed | skipped. error: technical code only, never user text.
 */
export const profileFactExtractions = pgTable(
  "profile_fact_extractions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sourceInputId: uuid("source_input_id").notNull(),
    pipelineVersion: varchar("pipeline_version", { length: 50 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 30 }).notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    factsCount: integer("facts_count"),
    rejectedCount: integer("rejected_count"),
    error: varchar("error", { length: 300 }),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    versionUnique: uniqueIndex("profile_fact_extractions_version_unique").on(
      t.sourceInputId, t.pipelineVersion, t.promptVersion, t.model,
    ),
    byUserStatus: index("profile_fact_extractions_user_status_idx").on(t.userId, t.status),
    idUserUnique: uniqueIndex("profile_fact_extractions_id_user_unique").on(t.id, t.userId),
    sourceOwner: foreignKey({
      name: "profile_fact_extractions_source_owner_fk",
      columns: [t.sourceInputId, t.userId],
      foreignColumns: [profileSourceInputs.id, profileSourceInputs.userId],
    }).onDelete("cascade"),
    statusCheck: check("profile_fact_extractions_status_check",
      sql`${t.status} in ('pending','succeeded','failed','skipped')`),
  }),
);

/**
 * Universal fact row. fact_type is a code-level registry (@ustal/validation PROFILE_FACT_TYPES);
 * slot_key is the conflict identity computed by the server (single-valued type, or type + normalized
 * label). status: active (current) | superseded (a later statement for the same slot wins) |
 * replaced (this input was re-extracted by a newer pipeline; replaces_fact_id links the new row to
 * the old one so later user confirmation/visibility can be carried over). At most one active fact
 * per (user, slot) is enforced by the partial unique index.
 */
export const profileFacts = pgTable(
  "profile_facts",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sourceInputId: uuid("source_input_id").notNull(),
    extractionId: uuid("extraction_id").notNull(),
    factType: varchar("fact_type", { length: 40 }).notNull(),
    slotKey: varchar("slot_key", { length: 200 }).notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
    evidence: text("evidence").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    assertion: varchar("assertion", { length: 10 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    // Phase 2A user control. user_decision: confirmed | corrected | revoked (null = AI only).
    // user_value: the owner's corrected value (value keeps the AI output for audit/reprocessing).
    // visibility: private (own profile / future internal matching only) | shareable (may be disclosed to a
    // counterparty after an explicit owner action — never automatically). New facts are private.
    userDecision: varchar("user_decision", { length: 10 }),
    userValue: jsonb("user_value").$type<Record<string, unknown>>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    visibility: varchar("visibility", { length: 10 }).notNull().default("private"),
    supersededByFactId: uuid("superseded_by_fact_id").references((): AnyPgColumn => profileFacts.id, { onDelete: "set null" }),
    replacesFactId: uuid("replaces_fact_id").references((): AnyPgColumn => profileFacts.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneActivePerSlot: uniqueIndex("profile_facts_active_slot_unique")
      .on(t.userId, t.slotKey)
      .where(sql`${t.status} = 'active'`),
    byUserSlot: index("profile_facts_user_slot_idx").on(t.userId, t.slotKey),
    bySource: index("profile_facts_source_idx").on(t.sourceInputId),
    byExtraction: index("profile_facts_extraction_idx").on(t.extractionId),
    sourceOwner: foreignKey({
      name: "profile_facts_source_owner_fk",
      columns: [t.sourceInputId, t.userId],
      foreignColumns: [profileSourceInputs.id, profileSourceInputs.userId],
    }).onDelete("cascade"),
    extractionOwner: foreignKey({
      name: "profile_facts_extraction_owner_fk",
      columns: [t.extractionId, t.userId],
      foreignColumns: [profileFactExtractions.id, profileFactExtractions.userId],
    }).onDelete("cascade"),
    statusCheck: check("profile_facts_status_check", sql`${t.status} in ('active','superseded','replaced','revoked')`),
    decisionCheck: check("profile_facts_user_decision_check", sql`${t.userDecision} is null or ${t.userDecision} in ('confirmed','corrected','revoked')`),
    // revoked status <=> revoked decision; a user value exists only for a correction.
    revokedCheck: check("profile_facts_revoked_check", sql`(${t.status} = 'revoked') = (coalesce(${t.userDecision}, '') = 'revoked')`),
    userValueCheck: check("profile_facts_user_value_check", sql`(${t.userValue} is null) = (coalesce(${t.userDecision}, '') <> 'corrected')`),
    visibilityCheck: check("profile_facts_visibility_check", sql`${t.visibility} in ('private','shareable')`),
    assertionCheck: check("profile_facts_assertion_check", sql`${t.assertion} in ('explicit','inferred')`),
    confidenceCheck: check("profile_facts_confidence_check", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  }),
);

// ---------------------------------------------------------------------------
// Онтология
// ---------------------------------------------------------------------------

export const ontologyNodes = pgTable("ontology_nodes", {
  id: id(),
  canonicalKey: varchar("canonical_key", { length: 100 }).notNull().unique(),
  nameRu: varchar("name_ru", { length: 150 }).notNull(),
  description: text("description"),
  nodeType: varchar("node_type", { length: 20 }).notNull(), // action|object|capability|resource|condition|risk
  parentId: uuid("parent_id"),
  riskLevel: integer("risk_level").notNull().default(0),
  regulated: boolean("regulated").notNull().default(false),
  requiresVerification: boolean("requires_verification").notNull().default(false),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  version: integer("version").notNull().default(1),
});

export const ontologySynonyms = pgTable("ontology_synonyms", {
  id: id(),
  ontologyNodeId: uuid("ontology_node_id")
    .notNull()
    .references(() => ontologyNodes.id, { onDelete: "cascade" }),
  phraseRu: text("phrase_ru").notNull(),
});

export const ontologyRelations = pgTable("ontology_relations", {
  id: id(),
  fromNodeId: uuid("from_node_id").notNull().references(() => ontologyNodes.id, { onDelete: "cascade" }),
  toNodeId: uuid("to_node_id").notNull().references(() => ontologyNodes.id, { onDelete: "cascade" }),
  relationType: varchar("relation_type", { length: 30 }).notNull(),
});

export const ontologyCandidates = pgTable("ontology_candidates", {
  id: id(),
  rawPhrase: text("raw_phrase").notNull(),
  suggestedNodeIds: jsonb("suggested_node_ids").notNull().default([]),
  embeddingSimilarity: numeric("embedding_similarity", { precision: 5, scale: 4 }),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending|merged|rejected
  createdAt: createdAt(),
  resolvedByAdminId: uuid("resolved_by_admin_id"),
});

// ---------------------------------------------------------------------------
// Заказы
// ---------------------------------------------------------------------------

export const orders = pgTable("orders", {
  id: id(),
  authorId: uuid("author_id").notNull().references(() => users.id),
  cityId: uuid("city_id").notNull().references(() => cities.id),
  // Nullable (изменено в Фазе 3): для голосового заказа на момент INSERT текста
  // ещё нет. Пока пусто — заказ в status='processing' и не виден никому,
  // кроме автора (см. apps/api/src/routes/orders.ts).
  //
  // Пауза «Проверка транскрипции» (экран 9/11 screens.md,
  // claude/pipeline-split-design.md): `transcript` — сырой результат STT,
  // неизменяемый; `sourceText` заполняется ТОЛЬКО на шаге подтверждения
  // (POST /orders/{id}/confirm-transcript), не раньше — иначе order_extraction
  // мог бы стартовать раньше, чем пользователь успел поправить текст.
  // `sourceStatus`: transcribing (voice, STT ещё не готов) -> awaiting_review
  // (STT готов, можно править) -> confirmed (sourceText заполнен, ушло в
  // order_extraction). Text-ввод сразу confirmed, sourceText = введённый текст.
  sourceText: text("source_text"),
  transcript: text("transcript"),
  sourceStatus: varchar("source_status", { length: 20 }).notNull().default("confirmed"),
  normalizedTitle: text("normalized_title"),
  normalizedDescription: text("normalized_description"),
  priceMinor: integer("price_minor"),
  // Заказчик готов рассмотреть отклик с другой ценой; если false — поле «ваша цена» у исполнителя не показывается.
  acceptsPriceOffers: boolean("accepts_price_offers").notNull().default(false),
  currency: varchar("currency", { length: 3 }).notNull().default("RUB"),
  desiredAt: timestamp("desired_at", { withTimezone: true }),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  riskLevel: integer("risk_level").notNull().default(0),
  moderationStatus: varchar("moderation_status", { length: 20 }).notNull().default("pending"),
  // Заменено общей таблицей `idempotency_keys` (добавление #10, Фаза 2) — это
  // поле больше не заполняется, оставлено nullable, чтобы не ломать уже
  // накопленные строки при деплое; кандидат на удаление отдельной миграцией.
  idempotencyKey: varchar("idempotency_key", { length: 100 }),
  createdAt: createdAt(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // Показ волнами до лимита откликов (2026-10-15, @ustal/domain order-delivery): номер текущей волны и время её
  // начала, признак «подходящие люди закончились» и закрытие приёма откликов (заказчиком или по лимиту).
  deliveryWave: integer("delivery_wave").notNull().default(1),
  // Номер волны, подбор которой уже опубликован (0 — ещё ни одного прогона): следующая волна — только после него.
  deliveredWave: integer("delivered_wave").notNull().default(0),
  deliveryWaveAt: timestamp("delivery_wave_at", { withTimezone: true }),
  deliveryExhaustedAt: timestamp("delivery_exhausted_at", { withTimezone: true }),
  responsesClosedAt: timestamp("responses_closed_at", { withTimezone: true }),
  // НЕТ: required_executors_count, confirmed_executors_count, price_per_executor,
  //      agreed_price, team_size — сознательно, см. docs/data-model.md
});

export const orderMedia = pgTable("order_media", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  mediaId: uuid("media_id").notNull(),
  position: integer("position").notNull().default(0),
});

export const orderRequirements = pgTable("order_requirements", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  ontologyNodeId: uuid("ontology_node_id").notNull(),
  requirementType: varchar("requirement_type", { length: 30 }).notNull(),
  isMandatory: boolean("is_mandatory").notNull().default(false),
});

export const orderAiExtractions = pgTable("order_ai_extractions", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  extractionVersion: varchar("extraction_version", { length: 50 }).notNull(),
  rawResult: jsonb("raw_result").notNull(),
  createdAt: createdAt(),
});

export const orderEmbeddings = pgTable("order_embeddings", {
  orderId: uuid("order_id")
    .primaryKey()
    .references(() => orders.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
  embeddingModel: varchar("embedding_model", { length: 100 }).notNull(),
});

// ---------------------------------------------------------------------------
// Отклики, контакты, назначения
// ---------------------------------------------------------------------------

export const responses = pgTable(
  "responses",
  {
    id: id(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    executorId: uuid("executor_id").notNull().references(() => users.id),
    offeredPriceMinor: integer("offered_price_minor"),
    comment: text("comment"),
    availabilityText: text("availability_text"),
    status: varchar("status", { length: 20 }).notNull().default("active"), // active|withdrawn|not_selected
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // один активный отклик на (order, executor)
    oneActivePerOrderExecutor: uniqueIndex("responses_active_unique")
      .on(t.orderId, t.executorId)
      .where(sql`${t.status} = 'active'`),
  }),
);

export const contactUnlocks = pgTable("contact_unlocks", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => users.id),
  executorId: uuid("executor_id").notNull().references(() => users.id),
  responseId: uuid("response_id").notNull().references(() => responses.id),
  unlockedAt: createdAt(),
});

export const orderAssignments = pgTable(
  "order_assignments",
  {
    id: id(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    executorId: uuid("executor_id").notNull().references(() => users.id),
    responseId: uuid("response_id").notNull().references(() => responses.id),
    status: varchar("status", { length: 20 }).notNull().default("selected"),
    selectedAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Фаза 7: api.md для not-completed говорит «опциональная причина», но
    // исходная модель данных не давала ей места — добавлено минимальное
    // текстовое поле, см. architecture.md §5. Заполняется только веткой
    // not-completed; для completed остаётся null.
    notCompletedReason: text("not_completed_reason"),
    // Security-этап «исполнитель не должен зависать в работе» (2026-09-22):
    // исполнитель может сам отметить, что работа сделана ("completed") или
    // что выполнить не получилось ("issue") — это ТОЛЬКО сигнал заказчику,
    // сам заказ/assignment не переводит: окончательное решение (complete /
    // not-completed, см. routes/assignments.ts) по-прежнему только у
    // заказчика. Пусто, пока исполнитель ничего не отмечал.
    executorReport: varchar("executor_report", { length: 20 }),
    executorReportAt: timestamp("executor_report_at", { withTimezone: true }),
  },
  (t) => ({
    // исполнитель не может быть дважды выбран в один заказ
    oneAssignmentPerOrderExecutor: uniqueIndex("assignments_order_executor_unique").on(
      t.orderId,
      t.executorId,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Отзывы
// ---------------------------------------------------------------------------

export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    fromUserId: uuid("from_user_id").notNull().references(() => users.id),
    toUserId: uuid("to_user_id").notNull().references(() => users.id),
    lastOrderId: uuid("last_order_id").notNull().references(() => orders.id),
    rating: integer("rating").notNull(),
    text: text("text"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    onePerDirection: uniqueIndex("reviews_from_to_unique").on(t.fromUserId, t.toUserId),
  }),
);

// ---------------------------------------------------------------------------
// Оценки по заказу (MVP): одна запись = одна сторона закрыла «Оценить».
// rating NULL = пропуск. to_role — в какой роли оценивают получателя.
// ---------------------------------------------------------------------------

export const orderRatings = pgTable(
  "order_ratings",
  {
    id: id(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    fromUserId: uuid("from_user_id").notNull().references(() => users.id),
    toUserId: uuid("to_user_id").notNull().references(() => users.id),
    toRole: varchar("to_role", { length: 10 }).notNull(),
    rating: integer("rating"),
    createdAt: createdAt(),
  },
  (t) => ({
    onePerSide: uniqueIndex("order_ratings_order_from_unique").on(t.orderId, t.fromUserId),
    byRecipient: index("order_ratings_to_user_idx").on(t.toUserId, t.toRole),
  }),
);

// ---------------------------------------------------------------------------
// Подтверждение телефона (OTP): готово заранее, включается флагом
// PHONE_VERIFICATION_MODE (packages/config/src/env.ts) без переделки
// регистрации. Код хранится только хешем; purpose разделяет анонимную
// регистрацию ("register") и подтверждение уже существующего аккаунта
// ("existing_user", предлагается постепенно при входе).
// ---------------------------------------------------------------------------

export const phoneOtpCodes = pgTable(
  "phone_otp_codes",
  {
    id: id(),
    phone: varchar("phone", { length: 20 }).notNull(),
    purpose: varchar("purpose", { length: 20 }).notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    byPhonePurpose: index("phone_otp_codes_phone_purpose_idx").on(t.phone, t.purpose, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Уведомления, безопасность, служебное
// ---------------------------------------------------------------------------

export const notifications = pgTable("notifications", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 50 }).notNull(),
  payload: jsonb("payload").notNull().default({}),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const pushDeliveries = pgTable("push_deliveries", {
  id: id(),
  notificationId: uuid("notification_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
  deviceInstallationId: uuid("device_installation_id")
    .notNull()
    .references(() => deviceInstallations.id),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  providerMessageId: text("provider_message_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  error: text("error"),
});

export const reports = pgTable("reports", {
  id: id(),
  reporterId: uuid("reporter_id").notNull().references(() => users.id),
  targetType: varchar("target_type", { length: 30 }).notNull(),
  targetId: uuid("target_id").notNull(),
  reason: varchar("reason", { length: 100 }).notNull(),
  comment: text("comment"),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  createdAt: createdAt(),
});

export const blocks = pgTable(
  "blocks",
  {
    id: id(),
    blockerId: uuid("blocker_id").notNull().references(() => users.id),
    blockedId: uuid("blocked_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => ({
    uniquePair: uniqueIndex("blocks_pair_unique").on(t.blockerId, t.blockedId),
  }),
);

export const moderationCases = pgTable("moderation_cases", {
  id: id(),
  orderId: uuid("order_id").references(() => orders.id),
  userId: uuid("user_id").references(() => users.id),
  decision: varchar("decision", { length: 30 }).notNull(), // allow|allow_with_warning|manual_review|reject
  reason: text("reason"),
  createdAt: createdAt(),
  resolvedByAdminId: uuid("resolved_by_admin_id"),
});

export const aiRuns = pgTable("ai_runs", {
  id: id(),
  operationType: varchar("operation_type", { length: 50 }).notNull(),
  provider: varchar("provider", { length: 30 }).notNull(),
  model: varchar("model", { length: 100 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 30 }).notNull(),
  schemaVersion: varchar("schema_version", { length: 30 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  latencyMs: integer("latency_ms"),
  status: varchar("status", { length: 20 }).notNull(),
  error: text("error"),
  tokensInput: integer("tokens_input"),
  tokensOutput: integer("tokens_output"),
  estimatedCostMinor: integer("estimated_cost_minor"),
  traceId: varchar("trace_id", { length: 100 }).notNull(),
});

/**
 * Variant B (2026-10-15): content-addressed memo of successful AI review verdicts (semantic pair review,
 * general-access refusal check). cache_key = sha256 of review type + provider/model + prompt/schema version +
 * the exact AI input, so any change of profile/order/restriction text or version yields a new key; rows are
 * never updated. Only successful, non-degraded verdicts are stored; technical failures are never cached.
 */
/**
 * Direct revoke/restore пунктов профиля без AI (2026-10-17): журнал решений пользователя.
 * Действующее состояние — в версиях capability_profiles (маркеры removed_by_user / lifted в matching_facts);
 * журнал нужен, чтобы решение кнопкой пережило переборку профиля из сообщений (rebuild/reprocess) — у такого
 * решения нет сообщения — и для аудита «убрано пользователем». Append-only.
 * identity: { family, nodeIds, key } (как samePoint guard) или для ограничения { kind, phrase, evidence };
 * snapshot: исходные факты/строки пункта (для восстановления).
 */
export const profileItemDecisions = pgTable(
  "profile_item_decisions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 10 }).notNull(),
    family: varchar("family", { length: 20 }).notNull(),
    identity: jsonb("identity").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    profileVersion: integer("profile_version").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    // Полный детерминированный порядок решений (2026-10-17): decided_at, затем seq (монотонный, порядок записи).
    seq: bigint("seq", { mode: "number" }).generatedByDefaultAsIdentity(),
  },
  (t) => ({ userTime: index("profile_item_decisions_user_idx").on(t.userId, t.decidedAt) }),
);

/**
 * УСТАРЕЛО (2026-10-17, аудит Codex №3): запросы пересчёта векторов из миграции 0024; механизм заменён флагом
 * capability_profiles.embedding_stale (0025 переносит ожидающие запросы во флаг). Таблица оставлена как переходная
 * (окружения, где 0024 уже применена) и не используется кодом; удаление — отдельной миграцией после релиза.
 */
export const profileEmbeddingRefreshRequests = pgTable("profile_embedding_refresh_requests", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
});


export const aiReviewCache = pgTable(
  "ai_review_cache",
  {
    id: id(),
    cacheKey: varchar("cache_key", { length: 64 }).notNull(),
    reviewType: varchar("review_type", { length: 50 }).notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 60 }).notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ keyUnique: uniqueIndex("ai_review_cache_key_unique").on(t.cacheKey) }),
);

export const matchingRuns = pgTable("matching_runs", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  candidatesCount: integer("candidates_count"),
  inputHash: varchar("input_hash", { length: 64 }),
});

export const matchingCandidates = pgTable("matching_candidates", {
  id: id(),
  matchingRunId: uuid("matching_run_id").notNull().references(() => matchingRuns.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  score: numeric("score", { precision: 5, scale: 2 }).notNull(),
  matchType: varchar("match_type", { length: 20 }).notNull(), // exact|probable (legacy rows may hold other values; varchar, no enum)
  explanation: text("explanation").notNull(),
  breakdown: jsonb("breakdown").notNull().default({}),
}, (t) => ({ runUserUnique: uniqueIndex("matching_candidates_run_user_unique").on(t.matchingRunId, t.userId) }));

/** Immutable processing snapshots; original profile/order text is never overwritten by backfill. */
export const matchingDocuments = pgTable("matching_documents", {
  id: id(),
  profileId: uuid("profile_id").references(() => capabilityProfiles.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
  processingVersion: varchar("processing_version", { length: 100 }).notNull(),
  sourceHash: varchar("source_hash", { length: 64 }).notNull(),
  sourceText: text("source_text").notNull(),
  embeddingModel: varchar("embedding_model", { length: 100 }).notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
  processedAt: createdAt(),
}, (t) => ({
  profileVersion: uniqueIndex("matching_docs_profile_version").on(t.profileId, t.processingVersion, t.sourceHash),
  orderVersion: uniqueIndex("matching_docs_order_version").on(t.orderId, t.processingVersion, t.sourceHash),
}));

export const matchingFacts = pgTable("matching_facts", {
  id: id(),
  documentId: uuid("document_id").notNull().references(() => matchingDocuments.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 20 }).notNull(),
  constraintType: varchar("constraint_type", { length: 30 }).notNull().default("none"),
  constraintScope: varchar("constraint_scope", { length: 30 }).notNull().default("fact"),
  resourceRole: varchar("resource_role", { length: 30 }).notNull().default("none"),
  resourceCapacity: jsonb("resource_capacity").$type<{ value: number | null; unit: string | null; kind: string | null }>().notNull().default({ value: null, unit: null, kind: null }),
  phrase: text("phrase").notNull(),
  // Profile items (2026-10-15): short normalized display label (null = show phrase) and descriptive
  // attributes of an owned resource ({key, value, unit}). Display/profile only — matching does not read them.
  label: text("label"),
  attributes: jsonb("attributes").$type<{ key: string; value: string | number; unit: string | null }[]>().notNull().default([]),
  evidence: text("evidence").notNull(),
  nodeIds: jsonb("node_ids").$type<string[]>().notNull().default([]),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
  mandatory: boolean("mandatory").notNull(),
  startHour: integer("start_hour"),
  endHour: integer("end_hour"),
  // ISO weekday numbering local to the order's city: 0=Mon..6=Sun. Null = unspecified.
  daysOfWeek: jsonb("days_of_week").$type<number[] | null>(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
}, (t) => ({ byDocument: index("matching_facts_document_idx").on(t.documentId) }));

export const matchingTraces = pgTable("matching_traces", {
  id: id(),
  matchingRunId: uuid("matching_run_id").notNull().references(() => matchingRuns.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  decision: varchar("decision", { length: 30 }).notNull(),
  detail: jsonb("detail").notNull(),
}, (t) => ({ byRun: index("matching_traces_run_idx").on(t.matchingRunId) }));

/** Transactional coalescing outbox: profile changes survive a queue/network failure. */
export const rematchRequests = pgTable("rematch_requests", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  requestedAt: createdAt(),
  cursor: uuid("cursor"),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actorType: varchar("actor_type", { length: 10 }).notNull(), // user|admin|system
    actorId: uuid("actor_id"),
    action: varchar("action", { length: 100 }).notNull(),
    targetType: varchar("target_type", { length: 50 }).notNull(),
    targetId: uuid("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => ({
    byTarget: index("audit_logs_target_idx").on(t.targetType, t.targetId),
  }),
);

export const backgroundJobs = pgTable("background_jobs", {
  id: id(),
  jobType: varchar("job_type", { length: 50 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("created"),
  payload: jsonb("payload").notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: createdAt(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const adminUsers = pgTable("admin_users", {
  id: id(),
  email: varchar("email", { length: 200 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 30 }).notNull().default("moderator"),
  createdAt: createdAt(),
});

/** Retained only until physical erasure succeeds; never exposed through user APIs. */
export const mediaCleanupRequests = pgTable("media_cleanup_requests", {
  id: id(),
  storageProvider: text("storage_provider").notNull(),
  storageKey: text("storage_key").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid("lease_token"),
  lastErrorCode: text("last_error_code"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("media_cleanup_storage_unique").on(t.storageProvider, t.storageKey),
  index("media_cleanup_due_idx").on(t.storageProvider, t.nextAttemptAt),
]);
