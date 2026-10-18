# Production preparation — 2026-09-24

Scope: local preparation only. No commit, push, deploy, external resource creation, or real credentials.
Prerequisites: Docker Engine with Compose v2.24+; Node 22+ for operator-side smoke.

Canonical production target: Timeweb VPS Docker Compose, client → Caddy → API. App Platform/load balancer is a different topology and is not covered by this proxy setting.

## Environment contract

Copy `infra/timeweb/app/.env.example` to `infra/timeweb/app/.env` on the application host; replace every `<SET_ME>`. Do not commit it. Permissions 0600. The template is the complete deploy env list; constants may be retained.

- JWT_ACCESS_SECRET / JWT_REFRESH_SECRET / ADMIN_SESSION_SECRET: three distinct password-manager secrets, at least 32 characters. No development or placeholder values.
- POSTGRES_PASSWORD: strong URL-safe value (letters, digits, `_`, `-`), because Compose interpolates it into DATABASE_URL. DATABASE_URL is set by Compose for API/worker/admin/migrations; do not override it with a localhost URL.
- ADMIN_SEED_EMAIL: real operator email; ADMIN_SEED_PASSWORD: unique password, at least 16 characters. Only used by first seed-admin; existing accounts are not reset. Remove seed credentials from host env after first initialization, then recreate runtime containers.
- AI_PROVIDER=openai. OPENAI_BASE_URL=https://<relay-domain>/v1. Application OPENAI_API_KEY is the **relay client token**, not an OpenAI account key. Actual OpenAI key exists only in `infra/timeweb/relay/.env` on the relay host. Relay token and real key must differ. Both hosts need outbound HTTPS; only relay needs OpenAI access.
- MEDIA_STORAGE_PROVIDER=s3: private S3 bucket with scoped PutObject/GetObject access (the verification probe also needs HeadBucket/ListBucket and DeleteObject on its health/ prefix). No public bucket required; reads use expiring signed URLs. Existing local files need a separately verified migration before switching an existing deployment to S3. This preparation does not move production media.
- OBJECT_STORAGE_ENDPOINT / OBJECT_STORAGE_BUCKET / OBJECT_STORAGE_ACCESS_KEY / OBJECT_STORAGE_SECRET_KEY: use actual Timeweb values. Endpoint uses HTTPS; default SDK signing region is us-east-1, path-style addressing. Bucket must already exist.
- PHONE_VERIFICATION_MODE=disabled, SMS_PROVIDER=mock: intentional MVP registration without verified phone. Mock SMS endpoints are unavailable in this mode. Enabling required_for_new is blocked in production until a real SMS provider is implemented. PHONE_VERIFICATION_SECRET is unnecessary while disabled.
- PUSH_PROVIDER=expo. EXPO_ACCESS_TOKEN may remain empty unless enhanced push security is enabled in the Expo project; then supply its token. Mobile Expo/EAS credentials and the mobile public API URL are a separate release step.
- TRUST_PROXY_HOPS=1 is forced by Compose for API. Caddy is the only public entry; API/DB/admin ports are not published. Incoming client X-Forwarded-For is not trusted by Caddy. Do not expose API directly or add another proxy without revisiting trusted hops and spoofing tests.

Production rejects mock AI, default/placeholder auth secrets, direct/non-HTTPS OpenAI URLs, local media, and missing S3 config. API `/health` checks DB reachability, not external provider credentials; wrong relay/S3 credentials require the provider checks below. Worker heartbeat checks successful queue startup and recent dispatcher progress; Docker reports unhealthy but does not automatically restart an unhealthy running process. Set monitoring/alerting on unhealthy containers and failed jobs.

## Exact first-deploy order (operator, not executed here)

1. Integrate the reviewed work into a clean release `main`, preserve previous production ancestry, rerun CI, and publish only with authorization. Record OLD_SHA and TARGET_SHA. Do not deploy this dirty working tree or lose another agent's changes. Server: verify `git merge-base --is-ancestor OLD_SHA TARGET_SHA`; stop on dirty Git state or unexpected mounts. Check disk space, DNS, firewall 80/443, and backup capacity.
2. Provision/confirm application VPS, relay VPS, private S3 bucket and DNS. Fill the two env templates using secure host storage. No external resources were created here.
3. On relay host at the reviewed SHA: `DEPLOY_SHA=<TARGET_SHA> bash infra/timeweb/scripts/deploy-relay.sh`, then `bash infra/timeweb/scripts/verify-relay.sh`. Confirm unauthorized requests return 401 and authorized requests succeed. These checks do not print tokens.
4. On app host at the reviewed SHA: `DEPLOY_SHA=<TARGET_SHA> FIRST_DEPLOY=1 bash infra/timeweb/scripts/deploy-app.sh`. The script builds and validates env, waits for DB, stops writers, runs migrations, then initial reference seed and admin seed, and starts services with health checks. It never git-pulls implicitly. Compose itself gates API/worker/admin on successful migrations. No migration generation on deploy.
5. Run `bash infra/timeweb/scripts/verify-app-ai-route.sh` and `bash infra/timeweb/scripts/verify-app-storage.sh`. The storage probe writes, reads back and deletes its own health/ object using the runtime signing region. Check HTTPS `/health`, admin login, worker health/logs. Remove first-deploy seed credentials and recreate application containers. Future releases omit FIRST_DEPLOY.
6. Run the smoke command below from a trusted machine with Node 22+. Use two NEW operator-owned QA phone numbers, same chosen city, and a dedicated QA password supplied in the process environment. It registers real QA users, publishes a real order, invokes paid AI, writes both ratings and retains records. Schedule this knowingly; it is not a read-only probe.
7. Verify actual mobile media upload/read and Expo push on a device; update its API URL/build separately if necessary. Confirm alerting and restore drill before opening traffic widely.

## Smoke

Set these process variables (do not commit a credentials file):

```dotenv
SMOKE_BASE_URL=https://<SET_ME>
SMOKE_CUSTOMER_PHONE=<SET_ME>
SMOKE_EXECUTOR_PHONE=<SET_ME>
SMOKE_PASSWORD=<SET_ME>
SMOKE_ALLOW_WRITES=yes
# optional: otherwise first active city and 240 seconds per asynchronous stage
SMOKE_CITY_ID=<SET_ME>
SMOKE_TIMEOUT_MS=240000
```

Run from repo root: `node scripts/production-smoke.mjs`.
Health → register/login both users → profile extraction/apply → create/moderate/publish order → worker matching appears in feed → response → unlock → negotiations → agreement → completion → bilateral API rating → both archives. Failure is nonzero with stage/HTTP code and no tokens. Fresh QA numbers are required per run (no silent reuse/reset). Local verification uses the existing fixture normalizer in `scripts/ui-e2e-server.ts`; it does not prove real AI/S3 credentials. Current API supports bilateral ratings; executor archive does not depend on the executor rating, and this API check does not certify mobile rating controls.

## Database, backup and restore

Migrations 0000–0015 are versioned and tracked by Drizzle migration journal; a second serial migrate on the same database is a no-op (verified on fresh local pgvector/Postgres16). Never run multiple migrators concurrently. Never edit already-applied SQL. `db:seed` supplies cities, ontology and reviewed relations, no demo users; run on first install, not automatically each deploy (it can update labels). `db:seed-admin` creates one admin if absent and does not rotate existing passwords.

Named volume `ustal_db_data` persists across container recreation; never use `down -v`. S3 media survives app redeploy independently of containers. Preserve Caddy data volume (certificates). Back up before schema changes and daily, encrypted off-host with retention and restore tests. Back up S3 separately/version it; a DB backup alone does not contain media.

Example from `infra/timeweb/app` on Linux, to a protected backup location:

```sh
umask 077
docker compose -f docker-compose.prod.yml exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /secure-backups/ustal.dump
docker compose -f docker-compose.prod.yml exec -T db pg_restore --list < /secure-backups/ustal.dump > /secure-backups/ustal.list
```

Restore drill: use a **separate empty PostgreSQL16+pgvector instance/database**, run `pg_restore --exit-on-error --no-owner --no-acl -d <RESTORE_DATABASE_URL> ustal.dump`, check migration journal/counts, run health/QA against the restored target, verify corresponding S3 objects. Never practice restore over production. For incompatible migration rollback, restore DB plus matching old image/SHA and media snapshot under maintenance; restarting an old image alone is not a database rollback.

## Evidence / limits

See local `production-*.log` for commands (ignored, no credentials). Tracked-file scan found no real env filenames or common private-key/OpenAI/GitHub credential patterns; this is a bounded scan, not a claim about all history or external secrets. Docker context excludes env files, node_modules, dumps and local media. Final results are recorded in AI_HANDOFF.md and the task report. Production DNS/TLS/relay/OpenAI/S3/mobile/push and server restore are not live-verified in this preparation.

### Local verification results

- Full workspace test suite exit 0 (`production-tests-complete.log`); matching 74/74 unchanged. Subsequent final env guard tests 19/19 include malformed URL and direct-key rejection.
- Full workspace typecheck exit 0; final config typecheck exit 0.
- Root lint exit 0, 8 existing mobile warnings, no errors; backend package lint scripts remain no-ops as before.
- Node22 Docker builds for API, worker and admin; `npm ci` from lockfile, no local env/media baked in.
- App and relay Caddy validation and Compose model validation pass. Bash syntax checked in Linux; `.gitattributes` keeps shell scripts LF.
- Runtime API health returns 200 with DB; worker heartbeat fresh. All three runtime images reject missing production env with exit 1; seed-admin rejects default production credentials with exit 1.
- Fresh local Postgres16/pgvector: migrate twice, seed; custom-format pg_dump restored to a separate database with all 16 migration records.
- Full network API smoke passes with local fixture AI, including bilateral ratings and both archive flags. Real external integrations remain operator checks.

Local QA resources: task-owned Docker images `ustal-prep-{api,worker,admin}:local`, stopped API/worker check containers, and stopped isolated DB container `ustal-production-prep-test` (port 55439). Its source and restore databases contain only QA data; no existing DB was migrated or reset. Logs and QA artifacts are retained, not deleted.
