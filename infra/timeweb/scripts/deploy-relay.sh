#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RELAY_DIR="$REPO_ROOT/infra/timeweb/relay"

cd "$REPO_ROOT"
: "${DEPLOY_SHA:?Set DEPLOY_SHA to the reviewed release commit}"
[ -z "$(git status --porcelain)" ] || { echo "Dirty release tree: stop." >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$DEPLOY_SHA^{commit}")" ] || { echo "HEAD differs from DEPLOY_SHA" >&2; exit 1; }

cd "$RELAY_DIR"
if [ ! -f .env ]; then
  echo "Missing $RELAY_DIR/.env. Copy .env.example to .env and fill RELAY_DOMAIN, RELAY_CLIENT_TOKEN, OPENAI_API_KEY." >&2
  exit 1
fi

chmod 600 .env
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${RELAY_DOMAIN:?RELAY_DOMAIN is required}"
: "${RELAY_CLIENT_TOKEN:?RELAY_CLIENT_TOKEN is required}"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"

for name in RELAY_CLIENT_TOKEN OPENAI_API_KEY; do
  value="${!name}"
  if [[ "$value" == *change-me* || "$value" == *SET_ME* || ${#value} -lt 32 ]]; then
    echo "Invalid production value for $name" >&2; exit 1
  fi
done
[ "$RELAY_CLIENT_TOKEN" != "$OPENAI_API_KEY" ] || { echo "Relay token must differ from OpenAI key" >&2; exit 1; }
docker compose config --quiet
docker compose up -d
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
curl -fsS "https://${RELAY_DOMAIN}/health" >/dev/null

echo "Relay deployed and health check passed: https://${RELAY_DOMAIN}/health"
