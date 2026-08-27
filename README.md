# USTAL — монорепозиторий MVP

AI-платформа услуг и поручений: один аккаунт, роль определяется действием,
без комиссии, MVP только для городов РФ. Полная архитектура — в `docs/`.

## Структура

- `apps/mobile` — Expo (React Native) приложение, единственный пользовательский клиент
- `apps/api` — REST API (Fastify + TypeScript)
- `apps/worker` — фоновые задачи: AI-вызовы, matching, уведомления (pg-boss)
- `apps/admin` — веб-админка (Next.js), для сотрудников
- `packages/*` — общий код (domain, database, validation, ai, matching, ontology, config, api-client)
- `docs/` — architecture.md, data-model.md, api.md, matching.md, screens.md, plan.md

## Быстрый старт (локально)

```bash
cp .env.example .env
docker compose up -d db          # PostgreSQL 16 + pgvector
npm install
npm run db:generate               # сгенерировать SQL-миграции из схемы Drizzle
npm run db:migrate                # применить миграции
npm run db:seed                   # города + demo-пользователи
npm run db:seed-admin             # dev-администратор (ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD, см. .env.example)
npm run dev:api                   # http://localhost:4000
npm run dev:worker
npm run dev:admin                 # http://localhost:4100
npm run dev:mobile                # Expo Dev Tools (Android/iOS/эмулятор)
```

## Сквозная проверка (E2E)

Каждая фаза проверена вручную реальным HTTP-стеком (Fastify `app.inject()`,
реальная Postgres, реальная очередь pg-boss — без моков фреймворка, `AI_PROVIDER`
можно оставить `mock`):

```bash
npx tsx scripts/verify-phase2.ts   # ... по phase7.ts — auth, профиль, заказы, matching, отклики, отзывы
npx tsx scripts/verify-phase8.ts   # жалобы, блокировки, security-фикс /auth/refresh
node scripts/verify-admin-e2e.mjs  # headless Chromium (playwright-core): логин админки, мутирующее действие
                                    # требует npm run build -w @ustal/admin && npm run start -w @ustal/admin (порт 4100)
```

## Проверка перед коммитом

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Деплой

`GitHub Actions` (`.github/workflows/ci.yml`) → сборка Docker-образов
`api`/`worker`/`admin` → деплой на Timeweb Cloud (App Platform) → PostgreSQL с
расширением `pgvector` (self-hosted на том же облаке, если managed PostgreSQL
Timeweb не даёт подключить кастомные расширения — см. `docs/architecture.md`).
Мобильное приложение собирается отдельно через EAS Build (Android/iOS), не
через этот хостинг.

Практический VPS-вариант для Timeweb Cloud находится в `infra/timeweb/`:
`infra/timeweb/app` поднимает API/worker/admin/Postgres за Caddy, а
`infra/timeweb/relay` поднимает маленький EU relay для OpenAI. Подробный порядок
настройки DNS, `.env` и запуска — в `docs/timeweb-deploy.md`.

## Статус

Фазы 0-8 из `docs/plan.md` реализованы и проверены локально (реальный HTTP +
реальная Postgres + реальная очередь; для админки — headless-браузер). Вне
скоупа разработки в песочнице: Android/iOS сборки через EAS (нужен Apple/Google
developer аккаунт), реальный деплой на Timeweb Cloud (нужен аккаунт), реальный
ключ OpenAI (`AI_PROVIDER=mock` работает без него для разработки) — см.
`docs/plan.md` за деталями каждой фазы и `docs/architecture.md` §5 за всеми
найденными по ходу реализации гэпами/решениями.
