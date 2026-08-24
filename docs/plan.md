# USTAL — План реализации MVP по фазам

Соответствует разделам ТЗ и задачам в трекере сессии. После каждой фазы: lint,
typecheck, тесты, сборка, короткий отчёт; переход к следующей фазе только при
рабочем основном сквозном сценарии.

- **Фаза 0 — Проектирование. ✅ Готово.** architecture.md, data-model.md, api.md,
  matching.md, screens.md.
- **Фаза 1 — Foundation. ✅ Готово и проверено локально.** monorepo (12 workspaces),
  mobile shell (Expo Router, дизайн-токены, навигация из 5 вкладок), API (Fastify +
  OpenAPI) со сквозным auth (Argon2id, access/rotating refresh, revoke), 34 таблицы
  БД (Drizzle) применены к реальному PostgreSQL 16 + pgvector, seed городов и
  стартовой онтологии, admin (Next.js) собирается, CI-пайплайн (lint/typecheck/
  test/build) зелёный по всем 12 пакетам. Хостинг — Timeweb Cloud (App Platform),
  не Amvera (решение изменено в ходе разработки).
  Проверено вручную: регистрация → дубликат номера (409) → /me → логин →
  refresh-ротация → неверный пароль (401) — всё через реальный HTTP, реальную БД.
- **Фаза 2 — AI-профиль. ✅ Готово и проверено локально.** `POST /profile/inputs`
  (текст/голос) с обязательным `Idempotency-Key` (общая таблица `idempotency_keys`,
  повтор с тем же ключом/телом → тот же ответ, другое тело → 409) и rate limit
  `PROFILE_FREEFORM_EDITS_PER_HOUR`; `POST /media` (multipart, фото/аудио, provider-
  абстракция `packages/storage`: local для разработки, s3-заготовка на боевые
  credentials); worker-пайплайн — STT (голос) → structured extraction
  (MockAIProvider локально, OpenAI-заготовка на Фазу дальше) → JSON-валидация
  Zod-схемой → ontology mapping (совпало → `user_capabilities`/`user_resources`,
  не совпало → `ontology_candidates`, не теряется — остаётся в `summary`) →
  новая append-only версия `capability_profiles` → embedding (`profile_embeddings`,
  1536 измерений) → `ai_runs` лог каждого AI-вызова. `GET /profile`,
  `PATCH /profile` (без AI), `GET/DELETE /profile/preferences`.
  Добавлено при реализации (см. architecture.md §5 п.10): таблицы `media`,
  `idempotency_keys`, `profile_embeddings`, пакеты `@ustal/queue` (общий для
  api/worker) и `@ustal/storage`.
  Проверено сквозным сценарием (`scripts/verify-phase2.ts`, реальный HTTP +
  реальная Postgres + реальная очередь pg-boss + MockAIProvider): регистрация →
  пустой профиль → 400 без Idempotency-Key → 202 с ключом → идемпотентный повтор
  → 409 на конфликт тела → job из очереди → extraction+ontology+версия+embedding
  → GET /profile с capabilities → голосовой вход (STT записал transcript) →
  rate limit на 15-й попытке (429) → PATCH /profile → GET /profile/preferences
  → POST /media (400 без файла, 201 с файлом) → voice-вход со ссылкой на media.
- **Фаза 3 — Заказы. ✅ Готово и проверено локально.** `POST /orders` (текст/голос,
  фото и голос через `media`/`order_media`, цена, `Idempotency-Key`) — сразу
  draft→processing, задача в очередь; worker: STT (голос) → AI extraction →
  Zod-валидация → ontology mapping (`order_requirements`, mandatory/desired) →
  risk classification (regulated > requiresQualification > обычная) →
  модерация (сначала детерминированные правила — работают одинаково для
  любого AI-провайдера, затем `regulated` ⇒ жёсткий manual_review, иначе
  AI-модерация для пограничных случаев) → `moderation_cases` → embedding.
  `GET /orders/{id}` (только автору, чужой заказ — 404, не 403), контекстные
  чипы отдаются из `order_ai_extractions.raw_result`. `POST /orders/{id}/publish`
  (явное действие автора, требует `moderation_status` allow/allow_with_warning
  И status=processing) и `POST /orders/{id}/cancel` (в т.ч. из `processing`/
  `moderation_hold` — расширение машины состояний, см. architecture.md §5 п.11).
  Проверено сквозным сценарием (`scripts/verify-phase3.ts`): обычный заказ до
  публикации → идемпотентный повтор → 409 на преждевременную публикацию →
  job из очереди → extraction+ontology+risk+moderation+embedding →
  публикация → повторная публикация (409) → отмена; рискованный заказ
  (жёсткое правило) → `moderation_hold` → публикация заблокирована (409), но
  отмена всё равно доступна; голосовой заказ → STT заполняет `source_text`.
- **Фаза 4 — Matching.** жёсткие фильтры, candidate retrieval (canonical match + resources
  + pgvector + full-text + история + preferences), scoring без платёжных полей, risk
  gate, exact/probable/new_opportunity, объяснения, лента, learned preferences.
- **Фаза 5 — Отклики и обсуждение.** отклики, встречная цена, кандидаты, «Обсудить
  заказ» → contact_unlock, звонок, WhatsApp (условно по `whatsapp_phone`), push.
- **Фаза 6 — Договорённость и закрытие.** «Договорились» (множественные assignments
  без счётчиков в UI), ручное закрытие заказа, блокировка новых откликов,
  уведомления невыбранным.
- **Фаза 7 — Результат и отзывы.** выполнено/не выполнено, независимые двусторонние
  оценки, UNIQUE(from,to) с обновлением при повторной совместной работе.
- **Фаза 8 — Админка и проверка.** модерация, жалобы, блокировки, ontology
  candidates, `/admin/ai-costs`, unit/integration/matching-evaluation (25+ кейсов)
  /E2E тесты, Android/iOS сборки (EAS), деплой по вашей схеме, документация.

## Что нужно от вас, чтобы двигаться дальше

Репозиторий `2959427-eng/Ustal` подключён — код Фазы 0-1 запушен вручную с
вашего компьютера (песочница не может пушить в произвольный GitHub-репозиторий
из-за собственного egress-ограничения). Код Фазы 2 живёт в этой сессии и уже
реально запускался (БД, миграции, API, очередь, worker) — доставка изменений
до GitHub идёт тем же способом (архив/бандл + git push с вашей стороны), пока
не появится альтернативный канал. Для боевого включения остаются нужны:
аккаунт Timeweb Cloud (хостинг + Object Storage) и ключ OpenAI (сейчас
`AI_PROVIDER=mock` — работает без него, для разработки этого достаточно).
