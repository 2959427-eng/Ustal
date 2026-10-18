#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
: "${DEPLOY_SHA:?Set DEPLOY_SHA to the reviewed release commit}"
[ -z "$(git status --porcelain)" ] || { echo "Dirty release tree: stop and preserve changes." >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$DEPLOY_SHA^{commit}")" ] || { echo "HEAD differs from DEPLOY_SHA" >&2; exit 1; }
# No implicit git pull: deploy exactly the reviewed checkout.
cd infra/timeweb/app
[ -f .env ] || { echo "Fill the production .env first" >&2; exit 1; }
chmod 600 .env
compose=(docker compose -f docker-compose.prod.yml)
"${compose[@]}" config --quiet
"${compose[@]}" build api worker admin migrate
# Validate without logging values or contacting external providers.
"${compose[@]}" run --rm --no-deps api node --import tsx --input-type=module -e 'import {loadEnv} from "@ustal/config"; loadEnv(); console.log("Production env valid")'
"${compose[@]}" up -d --wait db
# On upgrades: take and verify a backup BEFORE this point; stop writers for migrations.
"${compose[@]}" stop api worker admin
"${compose[@]}" run --rm --no-deps migrate
if [ "${FIRST_DEPLOY:-0}" = "1" ]; then
  "${compose[@]}" run --rm --no-deps api npm run db:seed
  "${compose[@]}" run --rm --no-deps api npm run db:seed-admin
fi
"${compose[@]}" up -d --wait
printf 'Services started at %s. Run relay/storage verification and production-smoke.mjs.\n' "$(git rev-parse HEAD)"
