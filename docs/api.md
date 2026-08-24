# USTAL — API-контракт (сводка)

Полный OpenAPI 3.1 генерируется из Fastify-схем в `apps/api` (Zod → JSON Schema).
Здесь — сводка эндпоинтов, статусов и требований к каждому. Формат ответа об ошибке
единый: `{ error: { code, message, details? } }`.

## Аутентификация
| Endpoint | Auth | Идемпотентность | Заметки |
|---|---|---|---|
| `POST /auth/register` | нет | нет | rate limit по IP; телефон уникален среди активных |
| `POST /auth/login` | нет | нет | rate limit + защита от перебора (лок по счётчику неудач) |
| `POST /auth/refresh` | refresh token | нет | rotating refresh, отзыв старого при использовании |
| `POST /auth/logout` | access token | нет | ревокация текущей сессии |
| `GET /me` | access token | — | |
| `GET /cities` | нет | — | справочник, кешируется на клиенте |

## Профиль
| Endpoint | Auth | Идемпотентность | Заметки |
|---|---|---|---|
| `GET /profile` | access token | — | текущая версия `capability_profiles` |
| `POST /profile/inputs` | access token | **да, `Idempotency-Key`** | text/voice → ставит job в очередь, инициирует AI-вызов; rate limit N/час на free-form правки (конфигурируемо) |
| `PATCH /profile` | access token | нет | точечные правки без AI (например смена города) |
| `GET /profile/preferences` | access token | — | learned_preferences |
| `DELETE /profile/preferences/{id}` | access token, владелец | — | отмена «не показывать подобное» |

## Заказы
| Endpoint | Auth | Идемпотентность | Заметки |
|---|---|---|---|
| `POST /orders` | access token | **да, `Idempotency-Key`** | создаёт draft, ставит job на extraction |
| `GET /orders/{id}` | access token, автор (чужой заказ — 404, не 403) | — | контекстные чипы — из `order_ai_extractions.raw_result` |
| `POST /orders/{id}/publish` | access token, автор | нет | из `processing`→`published`, при `moderation_status` ∈ {`allow`, `allow_with_warning`} (см. architecture.md §5 п.11) |
| `POST /orders/{id}/cancel` | access token, автор | нет | допустимые исходные статусы: `processing`, `moderation_hold`, `published`, `negotiating` (расширено в Фазе 3, см. architecture.md §5 п.11) |
| `POST /orders/{id}/close` | access token, автор | нет | транзакционно: closed + `responses` без assignment → `not_selected` + уведомления |
| `GET /orders/{id}/responses` | access token, автор | — | только своему заказу |
| `POST /orders/{id}/responses` | access token, не автор | нет (но max 1 активный per user проверяется в транзакции) | executor role |
| `POST /orders/{id}/contact-unlocks` | access token, автор | нет (soft rate-limit, см. architecture.md п.8) | требует существующий активный `response_id` |
| `GET /orders/{id}/contacts/{userId}` | access token, сторона существующего `contact_unlock` | — | телефон отдаётся только сторонам unlock'а, не по голому ID |
| `POST /orders/{id}/assignments` | access token, автор | нет | требует `contact_unlock` для пары; уникальность (order, executor) |
| `POST /orders/{id}/assignments/{assignmentId}/complete` | access token, автор | нет | открывает форму оценки на клиенте |
| `POST /orders/{id}/assignments/{assignmentId}/not-completed` | access token, автор | нет | опциональная причина, matching не получает позитивный сигнал |

## Лента и мои списки
`GET /feed`, `GET /my/orders`, `GET /my/responses` — access token, пагинация,
без раскрытия чужих контактов, без агрегированных чисел исполнителей в payload'ах,
адресованных исполнителям.

## Отклики (правка/отзыв)
`PATCH /responses/{id}`, `DELETE /responses/{id}` — access token, владелец, только
до выбора кандидата или закрытия заказа.
`POST /reviews`, `PATCH /reviews/{id}` — access token; backend проверяет
completed `order_assignment` между парой перед записью; UNIQUE(from,to) → повторный
вызов обновляет, а не дублирует.

## Уведомления и устройства
`GET /notifications`, `POST /notifications/{id}/read`, `POST /devices`,
`POST /push-tokens` — access token; идемпотентность по `expo_push_token` при
повторной регистрации устройства (upsert, не дубли).

## Медиа и жалобы
`POST /media` (фото/аудио → object storage, возвращает `media_id`).
`POST /reports` — access token; `targetType` ∈ {`order`, `user`, `response`}, проверка
существования цели (404, если не найдена), self-report → 400.
`POST /blocks` — access token; идемпотентно (повторный вызов той же пары
возвращает существующую запись с 200, а не создаёт дубль/409), self-block → 400.
`GET /blocks` — список блокировок текущего пользователя. `DELETE /blocks/{id}` —
только владелец (чужой/несуществующий id → 404).

## Админка (отдельная авторизация admin_users, не пересекается с users)
**Архитектурное решение (Фаза 8, architecture.md §5 п.22): у `apps/admin` НЕТ
REST-контракта `/admin/*` через `apps/api`.** Next.js Server Components и
Server Actions обращаются к Postgres напрямую через `@ustal/database` — своего
клиента (мобильного или стороннего) у админки нет, поэтому versioned REST-слой
между ней и БД не нужен; таблица ниже — не HTTP-эндпоинты, а страницы/actions.

| Страница (`apps/admin/app/(protected)/...`) | Server Action(s) | Что делает |
|---|---|---|
| `/` (дашборд) | — | live-счётчики: пользователи, заказы, ожидающая модерация, ожидающие ontology candidates, открытые жалобы |
| `/users` | `setUserStatusAction` | список (100 последних), блокировка/разблокировка (`users.status`) |
| `/orders` | — | список заказов со статусами |
| `/moderation` | `resolveModerationAction(orderId, "allow" \| "warn" \| "reject")` | новая запись в `moderation_cases` (не перезаписывает старую), `reject` переводит заказ в `rejected`; `allow`/`warn` не требуют смены `orders.status` (`moderation_hold → published` уже валидный переход); уведомляет автора |
| `/ontology-candidates` | `mergeOntologyCandidateAction(candidateId, nodeId)`, `rejectOntologyCandidateAction` | merge добавляет фразу синонимом к существующему узлу (не создаёт новый узел — вне MVP-скоупа), reject помечает `rejected` |
| `/ai-costs` | — | агрегация `ai_runs` по `operation_type`/provider за 30 дней, без отдельной BI-платформы |
| `/reports` | `resolveReportAction(reportId, "resolved" \| "dismissed")` | очередь открытых жалоб + read-only список последних блокировок |
| `/login`, `/` (logout-форма) | `loginAction`, `logoutAction` | argon2-проверка `admin_users`, httpOnly cookie-сессия (`ADMIN_SESSION_SECRET`, 12ч) |

## Общие правила для каждого endpoint (закреплены в коде и тестах)
request/response schema (Zod, единый источник для валидации и OpenAPI), явная
авторизация, конечный список допустимых статусных переходов, единый формат ошибок,
идемпотентность там, где endpoint инициирует AI-вызов, audit-лог для критичных
операций (contact-unlocks, assignments, close, admin-actions). Ответы никогда не
включают персональные данные сверх необходимого для данного вызывающего (например
телефон — только сторонам unlock'а).
