#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RELAY_DIR="$REPO_ROOT/infra/timeweb/relay"

cd "$REPO_ROOT"
git pull --ff-only

cd "$RELAY_DIR"
if [ ! -f .env ]; then
  echo "Missing $RELAY_DIR/.env. Copy .env.example to .env and fill RELAY_DOMAIN, RELAY_CLIENT_TOKEN, OPENAI_API_KEY." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${RELAY_DOMAIN:?RELAY_DOMAIN is required}"
: "${RELAY_CLIENT_TOKEN:?RELAY_CLIENT_TOKEN is required}"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"

docker compose config >/dev/null
docker compose up -d
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
curl -fsS "https://${RELAY_DOMAIN}/health" >/dev/null

echo "Relay deployed and health check passed: https://${RELAY_DOMAIN}/health"
