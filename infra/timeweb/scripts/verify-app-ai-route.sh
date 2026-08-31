#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../app" && pwd)"

cd "$APP_DIR"
if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${OPENAI_BASE_URL:?OPENAI_BASE_URL is required}"

if printf '%s' "$OPENAI_BASE_URL" | grep -q 'api\.openai\.com'; then
  echo "OPENAI_BASE_URL must point to the protected Timeweb EU relay, not api.openai.com." >&2
  exit 1
fi

docker compose -f docker-compose.prod.yml exec -T api node -e "
const baseUrl = process.env.OPENAI_BASE_URL;
const token = process.env.OPENAI_API_KEY;
if (!baseUrl || !token) throw new Error('OPENAI_BASE_URL and relay client token are required');
if (baseUrl.includes('api.openai.com')) throw new Error('direct OpenAI route is forbidden');
fetch(baseUrl.replace(/\\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + token } })
  .then(async (res) => {
    if (!res.ok) throw new Error('relay /models failed: ' + res.status + ' ' + await res.text());
    const json = await res.json();
    if (!json.object) throw new Error('unexpected OpenAI-compatible response');
    console.log('App container reached OpenAI-compatible API through relay:', baseUrl);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
"
