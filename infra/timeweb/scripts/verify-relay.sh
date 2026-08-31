#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(cd "$SCRIPT_DIR/../relay" && pwd)"

cd "$RELAY_DIR"
if [ ! -f .env ]; then
  echo "Missing $RELAY_DIR/.env." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${RELAY_DOMAIN:?RELAY_DOMAIN is required}"
: "${RELAY_CLIENT_TOKEN:?RELAY_CLIENT_TOKEN is required}"

curl -fsS "https://${RELAY_DOMAIN}/health" >/dev/null

unauthorized_status="$(
  curl -sS -o /dev/null -w '%{http_code}' "https://${RELAY_DOMAIN}/v1/models" || true
)"
if [ "$unauthorized_status" != "401" ]; then
  echo "Expected unauthorized /v1/models to return 401, got $unauthorized_status." >&2
  exit 1
fi

authorized_status="$(
  curl -sS -o /tmp/ustal-relay-models.json -w '%{http_code}' \
    -H "Authorization: Bearer ${RELAY_CLIENT_TOKEN}" \
    "https://${RELAY_DOMAIN}/v1/models" || true
)"
if [ "$authorized_status" != "200" ]; then
  echo "Expected authorized /v1/models to return 200, got $authorized_status." >&2
  exit 1
fi

if ! grep -q '"object"' /tmp/ustal-relay-models.json; then
  echo "Authorized relay response did not look like an OpenAI API response." >&2
  exit 1
fi

rm -f /tmp/ustal-relay-models.json
echo "Relay e2e check passed: unauthorized blocked, authorized request reached OpenAI through relay."
