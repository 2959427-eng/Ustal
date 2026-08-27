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
- **Фаза 4 — Matching. ✅ Готово и проверено локально.** Публикация заказа
  (`POST /orders/{id}/publish`) сразу ставит `matching_run` job. Worker
  (`apps/worker/src/handlers/matching-run.ts`, docs/matching.md §13):
  13.1 жёсткие фильтры (город — не входит в кандидатский SQL вообще; автор,
  заблокированные аккаунты — исключены явно; отсутствие обязательного
  требования — `matchRequirements().missingMandatoryRequirement`, кандидат
  пропускается, а не штрафуется; регулируемый+неверифицированный — `regulated`
  ⇒ 0 кандидатов, в норме недостижимо через обычный флоу, т.к. регулируемый
  заказ не проходит модерацию, но защита на месте и для будущего admin
  override); 13.2 candidate retrieval — canonical capability/resource match +
  pgvector semantic similarity (cosine, `profile_embeddings`/`order_embeddings`)
  + learned_preferences + история завершённых заказов; full-text по
  `normalized_description` сознательно не реализован в MVP (см. ниже и
  matching.md) — embedding similarity уже покрывает поиск по смыслу, а
  canonical-match — точные совпадения, full-text был бы дублирующим
  усложнением без данных для оценки его пользы на этом этапе; scoring
  (`packages/matching/src/scoring.ts`, без платёжных полей) → risk gate →
  классификация exact/probable/new_opportunity
  (`packages/matching/src/index.ts`, регулируемый+неверифицированный никогда
  не проходит классификацию — жёсткий инвариант) → человекочитаемое
  объяснение без технических деталей (`buildExplanation`) →
  `matching_runs`/`matching_candidates`. `GET /feed` (пагинация, только свои
  кандидаты, только опубликованные заказы) читает из persisted-кандидатов, а
  не пересчитывает на лету.
  Добавлено/исправлено при реализации (см. architecture.md §5 п.12):
  `minimumRelevanceScore` был некалиброван (35, взято "с потолка" в Фазе 0) —
  выше максимума одного сильного сигнала (explicit capability match = 30),
  из-за чего пайплайн не мог выдать ни одного кандидата ни при каких
  обстоятельствах; пересчитан до 10. pgvector `<=>` между двумя нулевыми
  векторами возвращает `NaN` (не ошибку) — MockAIProvider отдавал нулевые
  embedding'и; заменено на детерминированный ненулевой `pseudoEmbedding`,
  плюс defensive `Number.isFinite`-guards в scoring и matching-run. Mock
  order extraction всегда возвращал пустые requirement-массивы (matching
  был непроверяем) — добавлена keyword-эвристика по русским словам.
  Learned preferences (`GET/DELETE /profile/preferences`, Фаза 2) читаются
  matching-раном как позитивный/негативный сигнал — сами они пока не
  создаются автоматически (появится в Фазе 6-7 из истории откликов/оценок).
  Проверено сквозным сценарием (`scripts/verify-phase4.ts`): автор + 4
  кандидата (подходит / без профиля / другой город / заблокирован автором)
  → заказ → extraction (populates `order_requirements`) → публикация →
  автоматически поставленный `matching_run` job → ровно 1 кандидат в
  `matching_candidates` (остальные 3 отсеяны каждый своим фильтром) →
  `GET /feed` показывает заказ только подходящему кандидату, скрыт у
  остальных и у автора → отмена заказа убирает его из ленты → отдельно:
  `regulated`-заказ (вставлен напрямую в БД, т.к. через модерацию не может
  дойти до `published`) → 0 кандидатов.
- **Фаза 5 — Отклики и обсуждение. ✅ Готово и проверено локально.**
  `POST /orders/{id}/responses` (executor-роль: любой не-автор; встречная цена
  `offeredPriceMinor`, комментарий, доступность; автор не может откликнуться
  на свой заказ — 403; один активный отклик на пару (заказ, исполнитель) —
  частичный unique index в БД, не только проверка в коде, повтор → 409).
  `GET /orders/{id}/responses` (только автору, чужой заказ скрыт за 404) —
  список с `isContactUnlocked` и статусом assignment на каждый отклик.
  `PATCH /responses/{id}` / `DELETE /responses/{id}` (владелец; правка/отзыв
  доступны, только пока отклик `active`, заказ не закрыт/не отменён и
  исполнитель ещё не выбран через `order_assignments`; `DELETE` — мягкий
  перевод в `withdrawn`, не физическое удаление, освобождает executor'а для
  нового отклика на тот же заказ). «Обсудить заказ» →
  `POST /orders/{id}/contact-unlocks` (только автор, требует активный
  `responseId`; идемпотентно — повтор для уже раскрытой пары возвращает
  существующий unlock без нового списания лимита; технический anti-abuse
  rate limit `CONTACT_UNLOCKS_PER_HOUR`, не видимый пользователю как
  ограничение продукта, см. architecture.md §5 п.8) →
  `GET /orders/{id}/contacts/{userId}` (телефон и `whatsappPhone` — только
  сторонам существующего unlock'а, посторонний — 404; звонок и WhatsApp —
  чисто клиентские действия поверх этих данных, WhatsApp-кнопка показывается
  только если `whatsappPhone` не пуст). Push: новый пакет `@ustal/notifications`
  (та же provider-абстракция, что и `@ustal/ai`/`@ustal/storage`) — `mock`
  (без сети, по умолчанию) и `expo` (настоящий Expo Push API, не требует
  Apple/Google developer-аккаунтов на этом шаге, но нужен реальный push-токен
  с устройства, которого в этой сессии нет) через `PUSH_PROVIDER`. Новая
  in-app сущность `notifications` (`GET /notifications`,
  `POST /notifications/{id}/read`) создаётся синхронно при отклике/unlock'е
  (`apps/api/src/lib/notify.ts`), доставка push — асинхронно через
  `notification_dispatch` job (worker) с записью каждой попытки в
  `push_deliveries`. `POST /devices` — идемпотентная регистрация push-токена
  (upsert по `expo_push_token`, добавлен уникальный индекс — см.
  architecture.md §5 п.17). `GET /my/orders`, `GET /my/responses` — свои
  списки по обеим ролям одного аккаунта.
  Найдено и исправлено при реализации (см. architecture.md §5 пп.15-17):
  Postgres error code из drizzle-orm лежит на `err.cause.code`, а не на
  `err.code` напрямую (первая попытка ловить дубликат отклика роняла 500
  вместо 409); технический IP rate limit и бизнес-лимит `CONTACT_UNLOCKS_PER_HOUR`
  — независимые механизмы, которые нельзя проверять одним и тем же
  сквозным сценарием без калибровки; `device_installations` не имела
  уникального индекса для upsert'а, хотя api.md требовал идемпотентность.
  Проверено сквозным сценарием (`scripts/verify-phase5.ts`): отклик →
  уникальность активного отклика → автор не может откликнуться на свой
  заказ → список автора / скрыт от чужих → PATCH/DELETE только владельцем →
  contact-unlock (идемпотентность, обе стороны видят контакт, посторонний —
  404, rate limit) → push через мок-провайдер (`notification_dispatch`,
  `push_deliveries`) → `/my/orders`, `/my/responses` → `/notifications`
  (список, пометка прочитанным) → отмена заказа блокирует новые и
  существующие отклики.
- **Фаза 6 — Договорённость и закрытие. ✅ Готово и проверено локально.**
  `POST /orders/{id}/assignments` (автор; требует существующий активный
  `responseId` С раскрытым контактом — иначе 409 `contact_not_unlocked`;
  уникальность (order, executor) на уровне БД, повтор → 409
  `already_selected`) создаёт `order_assignments` со статусом `selected` и
  уведомляет выбранного исполнителя («Договорились!»). Первое назначение
  переводит заказ `published` → `negotiating`; НЕТ
  required/confirmed_executors_count (см. docs/data-model.md) — сколько
  угодно назначений на один заказ, каждое отдельным вызовом, без счётчика ни
  в БД, ни в UI. Принципиально: `negotiating` сам по себе НЕ блокирует новые
  отклики (`responses.ts` принимает их в `published` и `negotiating`) — автор
  может продолжать выбирать исполнителей по мере поступления новых
  откликов; блокирует новые отклики только явное `POST /orders/{id}/close`.
  Закрытие — транзакционно (docs/data-model.md): заказ → `closed` +
  `closed_at`, все ещё `active`, но не выбранные (нет `order_assignments`)
  отклики → `not_selected`, каждому уведомление; уже выбранные (`selected`)
  назначения не трогаются — их завершение («выполнено/не выполнено») это
  Фаза 7. PATCH/DELETE `/responses/{id}` теперь дополнительно блокируются,
  если по этой паре (заказ, исполнитель) уже есть `order_assignments` — тот
  же guard, что уже был написан в Фазе 5 для будущего использования, здесь
  впервые реально сработал.
  Проверено сквозным сценарием (`scripts/verify-phase6.ts`): назначение без
  раскрытого контакта → 409 → назначение → `negotiating` → повторное
  назначение того же исполнителя → 409 → новый отклик всё ещё принимается в
  `negotiating` → множественные назначения без счётчика (3 на один заказ) →
  PATCH выбранного отклика → 409 → список откликов автора с корректными
  `isContactUnlocked`/`assignmentStatus` → закрытие → невыбранный активный
  отклик становится `not_selected` с уведомлением, выбранные остаются
  `active` → новый отклик/повторное закрытие/новое назначение после
  закрытия → 409 → авторство назначения/закрытия проверяется (404 чужому).
- **Фаза 7 — Результат и отзывы. ✅ Готово и проверено локально.**
  `POST /orders/{id}/assignments/{assignmentId}/complete` (автор; только из
  статуса `selected`, повтор → 409) → `order_assignments.status =
  'completed'` + `completed_at`; уведомление исполнителю. Позитивный сигнал
  для matching (`similarCompletedWork`, docs/matching.md §13.3) не требует
  отдельной записи — worker (`matching-run.ts`) уже читает
  `order_assignments.status = 'completed'` напрямую при каждом новом
  matching_run. `POST /orders/{id}/assignments/{assignmentId}/not-completed`
  (автор; опциональная `reason`, только из `selected`, повтор → 409) →
  `status = 'not_completed'` (`completed_at` намеренно не заполняется — это
  не про завершение); matching не получает позитивный сигнал автоматически,
  просто потому что worker считает только `status = 'completed'`.
  `POST /reviews` / `PATCH /reviews/{id}`: backend проверяет наличие
  `order_assignments.status = 'completed'` между парой по указанному заказу
  в любом направлении ролей (автор↔исполнитель) перед созданием — иначе 403;
  себе — 400. `reviews` — не по заказу, а по ПАРЕ пользователей
  (`UNIQUE(from_user_id, to_user_id)`, docs/data-model.md): повторная
  совместная работа обновляет существующую запись (`rating`/`text`/
  `last_order_id`), а не создаёт новую — сознательное решение модели данных,
  профиль показывает один агрегированный отзыв от каждого контрагента.
  Найдено при реализации (см. architecture.md §5 п.19): api.md требовал
  «опциональную причину» для not-completed, но модель данных не давала ей
  места — добавлено `order_assignments.not_completed_reason` (миграция
  0004).
  Проверено сквозным сценарием (`scripts/verify-phase7.ts`): complete →
  `completed` (+уведомление, повтор → 409) → not-completed с причиной →
  `not_completed` (`completed_at` не заполняется, повтор → 409) → авторство
  проверяется (404 чужому) → отзывы в обе стороны — независимые записи →
  повторный отзыв той же паре обновляет, а не дублирует → PATCH только
  владельцем → отзыв без завершённой совместной работы / постороннему /
  себе → 403/400.
- **Фаза 8 — Админка и проверка. ✅ Backend + админка готовы и проверены
  локально; EAS-сборки и боевой деплой — вне скоупа песочницы (нужны ваши
  аккаунты/доступы, см. ниже).**
  Backend: `POST /reports` (заказ/пользователь/отклик, проверка существования
  цели, self-report → 400), `POST /blocks` (идемпотентно — повтор возвращает
  существующую запись с 200, а не дубль/409; self-block → 400; `GET`/`DELETE
  /blocks/{id}` с проверкой владения). Security-фикс, найденный при
  проектировании блокировки пользователя (architecture.md §5 п.20):
  `POST /auth/refresh` теперь проверяет `users.status`, отзывая сессию
  заблокированного вместо молчаливого продления доступа.
  Админка (`apps/admin`, Next.js App Router, отдельная авторизация
  `admin_users`/`ADMIN_SESSION_SECRET`, обращается к БД напрямую через
  `@ustal/database` — архитектурное решение, зафиксированное в
  architecture.md §5 п.22, а не REST через `apps/api`): дашборд со счётчиками,
  список пользователей с блокировкой/разблокировкой, список заказов,
  модерация (allow/warn/reject поверх `moderation_cases`, уведомление автору),
  ontology candidates (merge в существующий узел синонимом / reject),
  `/ai-costs` (агрегация `ai_runs` за 30 дней по типу операции и провайдеру),
  жалобы и блокировки (resolve/dismiss).
  matching-evaluation (`packages/matching/src/evaluation.test.ts`, 27
  сценариев ≥ требуемых 25): полный pure-function пайплайн
  `matchRequirements → computeScore → classifyMatchType → buildExplanation`
  на реальных весах из `@ustal/config`, а не только изолированные юнит-тесты
  формул — покрывает exact/probable/new_opportunity/null-классификацию,
  regulated+unverified инвариант, штрафы (missing requirement/negative
  preference/risk) в одиночку и в комбинации, пороговые случаи вплотную к
  `minimumRelevanceScore`, отсутствие payment-полей на уровне типов.
  E2E: `scripts/verify-phase8.ts` (backend, Fastify `app.inject()`, тот же
  паттерн, что и Фазы 2-7) + `scripts/verify-admin-e2e.mjs` (headless
  Chromium через `playwright-core` — логин админки идёт через React Server
  Actions "flight"-протокол, не обычный form POST, обычный REST-скрипт
  здесь неприменим, см. architecture.md §5 п.23; проверяет полный цикл
  логин → дашборд → все защищённые страницы → реальное мутирующее действие
  (блокировка пользователя, что действительно меняет `users.status` в БД) →
  logout). Полная регрессия: `verify-phase2.ts`…`verify-phase7.ts` — всё ещё
  зелёные после изменений Фазы 8; `npm run typecheck`/`lint`/`test` по всем
  workspace'ам — чисто.
  Dockerfile для `apps/api`/`apps/worker`/`apps/admin` и `docker-compose.yml`
  существовали с Фазы 1 и не требовали изменений (кроме уточняющего
  комментария в `apps/admin/Dockerfile` про полный список транспилируемых
  пакетов) — реальную сборку образов в этой сессии проверить не удалось
  (Docker CLI присутствует, демон недоступен в песочнице), сама структура
  Dockerfile'ов и команды `npm run build`/`npm run start`, которые они
  вызывают, проверены напрямую.
  Вне скоупа песочницы (см. «Что нужно от вас» ниже): Android/iOS сборки
  через EAS (нужен Apple/Google developer аккаунт), реальный деплой на
  Timeweb Cloud (нужен аккаунт), реальный ключ OpenAI (`AI_PROVIDER=mock`
  работает без него для разработки).
- **Найдено и исправлено после Фазы 8 (при подключении боевого
  OpenAI-ключа): `packages/ai/src/providers/openai.ts` и
  `packages/storage/src/providers/s3.ts` были заготовками с Фазы 1-2 —
  каждый метод бросал `notImplemented()`, и это оставалось незамеченным
  все 8 фаз, потому что вся проверка шла через `AI_PROVIDER=mock`/
  `MEDIA_STORAGE_PROVIDER=local`.** Подробности — architecture.md §5 п.24.
  Кратко: реализованы настоящие вызовы `whisper-1` (STT), `gpt-4o-mini`
  через Structured Outputs (`response_format: json_schema`, без
  `strict: true` — несовместимо с `z.record()` в схеме атрибутов ресурса,
  реальная валидация — `zodSchema.parse()`), `text-embedding-3-small`
  (эмбеддинги), rule-based + AI-модерация с принудительным
  `manual_review` для regulated-категорий; и настоящий S3-клиент для
  Timeweb Cloud Object Storage (`forcePathStyle: true`, `resolvePath()`
  теперь асинхронный — возвращает presigned GET URL, а не путь на диске;
  оба места вызова в `apps/worker` обновлены на `await`). Добавлены
  юнит-тесты (`packages/ai/src/providers/openai.test.ts`,
  `packages/storage/src/index.test.ts`) — покрывают явную ошибку при
  отсутствии `OPENAI_API_KEY`/`OBJECT_STORAGE_*`, а не сетевые вызовы.
  Проверено: `npm run typecheck`/`lint`/`test` по всем workspace'ам чисто,
  полная регрессия `verify-phase2.ts`…`verify-phase8.ts` зелёная на
  `AI_PROVIDER=mock`. **Не проверено в этой песочнице (нет боевого ключа):
  реальные вызовы Structured Outputs/Whisper/embeddings и реальный S3-
  эндпоинт Timeweb — это должно быть первым, что проверяется вручную
  после того, как это исправление окажется в вашем окружении** (см.
  `AI_HANDOFF.md`).
- **Подготовлена инфраструктура Timeweb Cloud для боевого включения AI через
  EU relay без нового провайдера:** `OPENAI_BASE_URL` добавлен в общий env-
  контракт и OpenAI SDK, `infra/timeweb/relay` поднимает Caddy relay на
  отдельном VPS Frankfurt/Amsterdam, `infra/timeweb/app` поднимает основной
  backend/admin/Postgres за Caddy, инструкция — `docs/timeweb-deploy.md`.

## Что нужно от вас, чтобы двигаться дальше

Репозиторий `2959427-eng/Ustal` подключён — код Фазы 0-1 запушен вручную с
вашего компьютера (песочница не может пушить в произвольный GitHub-репозиторий
из-за собственного egress-ограничения). Код Фазы 2 живёт в этой сессии и уже
реально запускался (БД, миграции, API, очередь, worker) — доставка изменений
до GitHub идёт тем же способом (архив/бандл + git push с вашей стороны), пока
не появится альтернативный канал. Для боевого включения остаются нужны:
аккаунт Timeweb Cloud (хостинг + Object Storage) и ключ OpenAI (сейчас
`AI_PROVIDER=mock` — работает без него, для разработки этого достаточно).
