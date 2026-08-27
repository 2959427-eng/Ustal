# Timeweb Cloud deployment

Цель: основной USTAL API/worker/admin может жить на текущем Timeweb сервере, а AI relay поднимается как отдельный маленький VPS в том же кабинете Timeweb, но с локацией Frankfurt или Amsterdam.

## 1. AI relay server

Создать отдельный Cloud Server:

- location: Frankfurt или Amsterdam;
- OS: Ubuntu 22.04/24.04 LTS;
- size: минимальная конфигурация с 2 GB RAM достаточна для Caddy reverse proxy;
- firewall: открыть `80/tcp`, `443/tcp`, `22/tcp`; закрыть всё остальное.

DNS:

- `ai-relay.<domain>` A-record на публичный IP relay-сервера.

На сервере:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git docker.io docker-compose-plugin
sudo systemctl enable --now docker

git clone <repo-url> ustal-foundation
cd ustal-foundation/infra/timeweb/relay
cp .env.example .env
nano .env
docker compose up -d
curl -fsS https://ai-relay.<domain>/health
```

В `.env` relay-сервера хранится настоящий `OPENAI_API_KEY` и отдельный `RELAY_CLIENT_TOKEN`. Основной app-сервер не должен знать реальный OpenAI-ключ: в его `OPENAI_API_KEY` кладётся только `RELAY_CLIENT_TOKEN`. Caddy принимает запросы к `/v1/*` только с этим клиентским токеном и сам заменяет `Authorization` на настоящий OpenAI-ключ при проксировании на `https://api.openai.com`.

## 2. Main app server

DNS:

- `api.<domain>` A-record на публичный IP app-сервера;
- `admin.<domain>` A-record на публичный IP app-сервера.

На app-сервере:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git docker.io docker-compose-plugin
sudo systemctl enable --now docker

git clone <repo-url> ustal-foundation
cd ustal-foundation/infra/timeweb/app
cp .env.example .env
nano .env
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api npm run db:migrate
docker compose -f docker-compose.prod.yml exec api npm run db:seed
docker compose -f docker-compose.prod.yml exec api npm run db:seed-admin
curl -fsS https://api.<domain>/health
```

Ключевые prod-переменные:

- `AI_PROVIDER=openai`
- `OPENAI_BASE_URL=https://ai-relay.<domain>/v1`
- `OPENAI_API_KEY=<RELAY_CLIENT_TOKEN>` — это не реальный OpenAI-ключ, а общий секрет между app-сервером и relay.
- `MEDIA_STORAGE_PROVIDER=s3`
- `OBJECT_STORAGE_ENDPOINT=https://s3.timeweb.cloud`

## 3. Operational notes

- Relay не должен публиковать endpoint без TLS. Caddy автоматически получает Let's Encrypt сертификат, если DNS уже указывает на сервер и порты 80/443 открыты.
- Relay не должен быть открытым публичным прокси: `/v1/*` возвращает `401`, если `Authorization` не равен `Bearer <RELAY_CLIENT_TOKEN>`.
- Не добавлять Redis/BullMQ для MVP: очередь уже работает через PostgreSQL.
- Не хранить `.env` в git.
- После смены `OPENAI_API_KEY` на relay достаточно `docker compose restart caddy`.
- Перед Android/iOS сборкой задать mobile API URL на `https://api.<domain>` в клиентской конфигурации.
