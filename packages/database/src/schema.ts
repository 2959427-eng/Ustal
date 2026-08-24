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
  numeric,
  timestamp,
  jsonb,
  vector,
  uniqueIndex,
  index,
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
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSessions = pgTable("user_sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  deviceInfo: text("device_info"),
  issuedAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

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
  createdAt: createdAt(),
});

export const capabilityProfiles = pgTable("capability_profiles", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  profileVersion: integer("profile_version").notNull(),
  extractionVersion: varchar("extraction_version", { length: 50 }).notNull(),
  embeddingModel: varchar("embedding_model", { length: 100 }),
  createdAt: createdAt(),
});

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
  // ещё нет — worker заполняет его транскрипцией асинхронно, тот же паттерн,
  // что и profile_source_inputs.transcript. Пока пусто — заказ в status='processing'
  // и не виден никому, кроме автора (см. apps/api/src/routes/orders.ts).
  sourceText: text("source_text"),
  normalizedTitle: text("normalized_title"),
  normalizedDescription: text("normalized_description"),
  priceMinor: integer("price_minor"),
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

export const matchingRuns = pgTable("matching_runs", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  candidatesCount: integer("candidates_count"),
});

export const matchingCandidates = pgTable("matching_candidates", {
  id: id(),
  matchingRunId: uuid("matching_run_id").notNull().references(() => matchingRuns.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  score: numeric("score", { precision: 5, scale: 2 }).notNull(),
  matchType: varchar("match_type", { length: 20 }).notNull(), // exact|probable|new_opportunity
  explanation: text("explanation").notNull(),
  breakdown: jsonb("breakdown").notNull().default({}),
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
