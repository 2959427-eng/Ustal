# USTAL — Модель данных (ER, MVP)

Все цены — `*_minor` (копейки), валюта — RUB. Время — `timestamptz` в UTC, отображение — по `cities.timezone`. Все AI-результаты версионируются, исходный ввод пользователя никогда не перезаписывается.

## Справочники и пользователи

```
cities
  id, name, region_name, federal_district, timezone, is_active

users
  id, phone (unique, E.164 +7...), password_hash (argon2id),
  phone_verified_at nullable, verification_level default 'none',
  status ('active' | 'blocked' | 'deleted'), created_at

user_profiles
  user_id (FK users, 1:1), name, city_id (FK cities),
  whatsapp_phone nullable,               -- добавлено, см. architecture.md п.5
  accepted_rules_at, accepted_pdn_at,     -- согласия при регистрации
  avatar_media_id nullable, created_at, updated_at

user_sessions
  id, user_id, refresh_token_hash, device_info, issued_at,
  expires_at, revoked_at nullable

device_installations
  id, user_id, expo_push_token, platform ('ios'|'android'),
  last_seen_at, is_active
```

## AI-профиль возможностей

```
profile_source_inputs
  id, user_id, input_type ('text'|'voice'), raw_text nullable,
  audio_media_id nullable, transcript nullable,
  transcript_corrected nullable, created_at

capability_profiles
  id, user_id, summary, profile_version, extraction_version,
  embedding_model nullable, created_at
  -- append-only: новая правка = новая версия, а не UPDATE поверх старой

user_capabilities
  id, capability_profile_id, ontology_node_id, label,
  proficiency ('unknown'|'basic'|'experienced'|'professional'),
  evidence_type ('explicit'|'inferred'|'completed_order'|'behavior'),
  confidence numeric

user_resources
  id, capability_profile_id, ontology_node_id, label,
  resource_type ('vehicle'|'tool'|'equipment'|'property'|'space'|
                 'audience'|'digital_asset'|'other'),
  attributes jsonb, evidence_type ('explicit'|'inferred'), confidence numeric

learned_preferences
  id, user_id, ontology_node_id, signal ('positive'|'negative'),
  source ('wants_similar'|'hide_similar'|'response'|'completed_order'),
  weight numeric, created_at, revoked_at nullable
```

## Онтология

```
ontology_nodes
  id, canonical_key, name_ru, description, node_type
    ('action'|'object'|'capability'|'resource'|'condition'|'risk'),
  parent_id nullable, risk_level, regulated bool,
  requires_verification bool, status ('active'|'deprecated'), version

ontology_synonyms
  id, ontology_node_id, phrase_ru

ontology_relations
  id, from_node_id, to_node_id, relation_type

ontology_candidates
  id, raw_phrase, suggested_node_ids (jsonb), embedding_similarity nullable,
  status ('pending'|'merged'|'rejected'), created_at, resolved_by_admin_id nullable
```

## Заказы

```
orders
  id, author_id, city_id, source_text, normalized_title,
  normalized_description, price_minor, currency default 'RUB',
  desired_at nullable, status, risk_level, moderation_status,
  created_at, published_at nullable, closed_at nullable
  -- НЕТ: required_executors_count, confirmed_executors_count,
  --      price_per_executor, agreed_price, team_size

order_media          id, order_id, media_id, position
order_requirements   id, order_id, ontology_node_id, requirement_type
                      ('required_capability'|'desired_capability'|
                       'required_resource'|'desired_resource'), is_mandatory
order_ai_extractions id, order_id, extraction_version, raw_result jsonb,
                      created_at
order_embeddings     id, order_id, embedding vector, embedding_model
```

## Отклики, контакты, назначения

```
responses
  id, order_id, executor_id, offered_price_minor nullable,
  comment nullable, availability_text nullable,
  status ('active'|'withdrawn'|'not_selected'), created_at, updated_at
  -- constraint: один активный response на (order_id, executor_id)

contact_unlocks
  id, order_id, customer_id, executor_id, response_id, unlocked_at
  -- создаётся только для существующего активного response

order_assignments
  id, order_id, executor_id, response_id,
  status ('selected'|'completed'|'not_completed'|'cancelled'),
  selected_at, completed_at nullable
  -- constraint: (order_id, executor_id) уникален — нельзя выбрать дважды
  -- количество записей не ограничено
```

## Отзывы

```
reviews
  id, from_user_id, to_user_id, last_order_id, rating, text nullable,
  created_at, updated_at
  -- UNIQUE(from_user_id, to_user_id) — обновление вместо нового insert
  -- backend проверяет наличие completed order_assignment между парой
  --   в любом направлении (заказчик↔исполнитель) перед созданием/обновлением
```

## Уведомления, безопасность, служебное

```
notifications      id, user_id, type, payload jsonb, read_at nullable, created_at
push_deliveries     id, notification_id, device_installation_id, status,
                    provider_message_id nullable, sent_at, error nullable
reports             id, reporter_id, target_type, target_id, reason, comment nullable,
                    status, created_at
blocks              id, blocker_id, blocked_id, created_at   -- взаимная проверка при matching
moderation_cases    id, order_id nullable, user_id nullable, decision
                    ('allow'|'allow_with_warning'|'manual_review'|'reject'),
                    reason, created_at, resolved_by_admin_id nullable
ai_runs             id, operation_type, provider, model, prompt_version,
                    schema_version, started_at, completed_at, latency_ms,
                    status, error nullable, tokens_input, tokens_output,
                    estimated_cost_minor, trace_id
matching_runs       id, order_id, started_at, completed_at, candidates_count
matching_candidates id, matching_run_id, user_id, score, match_type
                    ('exact'|'probable'|'new_opportunity'), explanation, breakdown jsonb
audit_logs          id, actor_type ('user'|'admin'|'system'), actor_id nullable,
                    action, target_type, target_id, metadata jsonb, created_at
background_jobs     -- тонкий слой поверх pg-boss для читаемого статуса/аудита
  id, job_type, status, payload jsonb, attempts, last_error nullable,
  created_at, started_at nullable, finished_at nullable
```

## Ключевые constraints на уровне БД (не только в коде)

- `users.phone` — один номер = максимум один активный аккаунт.
- `responses`: автор заказа не может откликнуться на свой заказ (проверка `author_id <> executor_id`); один активный response на пару (order, executor).
- `contact_unlocks`: только для существующего активного `response`; вставка допускается только пользователем `orders.author_id`.
- `order_assignments`: `Договорились` возможно только при наличии `contact_unlock` для той же пары; уникальность (order_id, executor_id).
- `orders.status = 'closed'` — триггер/проверка блокирует новые `responses`.
- `reviews`: UNIQUE(from_user_id, to_user_id); INSERT/UPDATE только при наличии `order_assignments.status = 'completed'` между этой парой (в любом направлении ролей).
