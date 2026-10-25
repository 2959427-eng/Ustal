#!/usr/bin/env bash
set +x
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(cd "$SCRIPT_DIR/../relay" && pwd)"
cd "$RELAY_DIR"
test -f .env || { echo 'Missing relay .env' >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${RELAY_DOMAIN:?RELAY_DOMAIN is required}"
: "${RELAY_CLIENT_TOKEN:?RELAY_CLIENT_TOKEN is required}"
[[ "$RELAY_CLIENT_TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]] || { echo 'Unsupported token syntax' >&2; exit 1; }
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
probe() {
  local expected="$1" method="$2" path="$3" credential="$4" status
  local -a args=(--silent --show-error --path-as-is --globoff --connect-timeout 10 --max-time 30
    --output "$body" --write-out '%{http_code}' --request "$method")
  if [ "$credential" = yes ]; then
    status="$(printf 'header = "Authorization: Bearer %s"\n' "$RELAY_CLIENT_TOKEN" |
      curl --config - "${args[@]}" "https://${RELAY_DOMAIN}${path}")"
  else
    status="$(curl "${args[@]}" "https://${RELAY_DOMAIN}${path}")"
  fi
  [ "$status" = "$expected" ] || { echo "FAIL: $method $path expected $expected got $status" >&2; exit 1; }
}
probe 200 GET /health no
for path in /v1/models /v1/chat/completions /v1/embeddings /v1/audio/transcriptions /v1/files; do
  probe 401 POST "$path" no
done
for path in /v1/files /v1/responses /v1/models/extra /v1/embeddings/ /v1//embeddings \
  /v1/./embeddings /v1/files/../embeddings /v1/%65mbeddings /v1%2fembeddings \
  /%76%31/embeddings '/v1/files?path=/v1/embeddings' /v1/embeddings%3Ffoo; do
  probe 403 POST "$path" yes
done
for method in PUT PATCH DELETE OPTIONS; do
  for path in /v1/models /v1/chat/completions /v1/embeddings /v1/audio/transcriptions; do
    probe 403 "$method" "$path" yes
  done
done
probe 403 POST /v1/models yes
for path in /v1/chat/completions /v1/embeddings /v1/audio/transcriptions; do
  probe 403 GET "$path" yes
done
# Only models probes reach OpenAI; no generation or paid inference.
probe 200 GET /v1/models yes
grep -q '"object"' "$body" || { echo 'Invalid OpenAI models response' >&2; exit 1; }
probe 200 GET '/v1/models?limit=1' yes
echo 'PASS: relay authentication, method/URI allowlist and OpenAI models connectivity'
