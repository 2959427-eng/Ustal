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
npm run dev:api                   # http://localhost:4000
npm run dev:worker
npm run dev:admin                 # http://localhost:4100
npm run dev:mobile                # Expo Dev Tools (Android/iOS/эмулятор)
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

## Статус

Фаза 1 (Foundation) — в разработке. См. `docs/plan.md` за полным списком фаз
и `docs/architecture.md` за принятыми архитектурными решениями.
