#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
APP_DIR="$REPO_ROOT/infra/timeweb/app"

cd "$REPO_ROOT"
git pull --ff-only

cd "$APP_DIR"
if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env. Copy .env.example to .env and fill production values." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${API_DOMAIN:?API_DOMAIN is required}"
: "${ADMIN_DOMAIN:?ADMIN_DOMAIN is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${OPENAI_BASE_URL:?OPENAI_BASE_URL is required in production}"
: "${OPENAI_API_KEY:?OPENAI_API_KEY must contain RELAY_CLIENT_TOKEN, not the real OpenAI key}"

if printf '%s' "$OPENAI_BASE_URL" | grep -q 'api\.openai\.com'; then
  echo "OPENAI_BASE_URL must point to the protected Timeweb EU relay, not api.openai.com." >&2
  exit 1
fi

docker compose -f docker-compose.prod.yml config >/dev/null
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec -T api npm run db:migrate
docker compose -f docker-compose.prod.yml exec -T api npm run db:seed
docker compose -f docker-compose.prod.yml exec -T api npm run db:seed-admin
curl -fsS "https://${API_DOMAIN}/health" >/dev/null

echo "App deployed and health check passed: https://${API_DOMAIN}/health"
