# Dormant consent blocked-work primitives (0029)

Separate branch `codex/consent-blocked-review-20261020`, based on cached SDK closure `f7924aa`.
No worker/index/handler/CLI/API consent decision wiring, queue dispatch, real jobs, approved disclosure or activation.
This sidecar does not protect actual outbound requests and is not a deploy-ready consent feature.

## Data and intent

Only server-trusted kind/source UUID/execution UUID/version hash/sorted subject UUIDs/purpose/publication UUID/hash/recipient binding.
No copied profile/order text, media URL, exception text, credentials or mutable client-supplied logical key.
`blockedWorkIntent` picks the documented fields, validates bounded IDs, canonicalizes subject sets and hashes the full intent.
Publication change creates a different intent; the later dispatcher must obsolete old versions after resolving current state.
Identity columns are immutable in SQL. Subject/source changes require a new intent, so no state update ever locks all users.
Kinds are internal operation identifiers, not legal purposes or approval. `profile_transcribe` and `order_transcribe`
remain distinct from extraction so future queue reconstruction cannot accidentally skip STT.
No retention TTL or automatic evidence deletion.

## Pause / resume protocol (not connected yet)

`pauseConsentWork` is idempotent INSERT / ON CONFLICT DO NOTHING, followed by canonical committed-winner read.
Duplicate deliveries cannot reset a lease, reopen completed work or overwrite captured intent.
The required `executionId` is the stable server queue-job UUID: retries reuse it; a resumed new job uses its new UUID.
A new execution denied after revoke creates a distinct pause rather than colliding with completed work.
Never generate a new execution UUID on each pause/retry.
In the deletion race its returned ID can be null after winner cleanup: future handlers MUST re-resolve deleted state,
and must never acknowledge original queued work as durably paused merely from `inserted:false`.
Caller-supplied SQL transaction supports source-state + pause atomicity; no HTTP belongs inside it.
Ordinary postgres READ COMMITTED semantics are required (not a preexisting long matching transaction).

Every new pause enters `ready` for one fresh authorization probe (immediate for missing grant, five seconds for policy unavailability), closing grant-before-insert lost wakes. After that probe, missing grant enters `waiting` without periodic retry;
each failed probe backs off 10/20/... seconds, capped at 900 seconds, without making any grant decision.
`wakeConsentWork` is an atomic signal that can later run in the SAME decision/publication transaction; it never grants,
authorizes, enqueues or changes consent evidence. No API integration is present now.

`claimConsentWork`: one short SQL statement, `FOR UPDATE SKIP LOCKED`, maximum25, lease5–120seconds.
Expired leases are reclaimable after crash. Every ack requires matching token + unexpired DB-time lease.
Wakes increment a monotonic row signal sequence even during a lease: a stale missing-grant ack returns ready,
so a grant arriving during a check is not lost. No user locks during claim/ack/wake, no network while locks are held.
`obsoleteConsentWork` fences old in-flight acknowledgements when source disappears or its version changes.

These are at-least-once primitives. Enqueue-before-ack crash can repeat an external enqueue.
Future dispatcher MUST re-resolve active users/current source/current publication, authorize fresh all-party state,
use existing queue singleton/idempotency keys and fence handler application/delivery. No exactly-once external claim.
A known configured expected publication UUID/hash may be absent, draft or retired in the registry: pausing is NOT
approval, and deliberately has no policy foreign key. Only a truly unconfigured bootstrap (no expected publication
identity) needs a separately reviewed pause strategy; never fabricate a policy UUID, approved text or vendor permission.

## Deleted-user and lock ordering

INSERT guard canonicalizes UUID subjects, then locks active user rows in sorted order BEFORE inserting a sidecar row.
Status=deleted transition deletes all matching sidecar rows (waiting/leased/completed) in the same transaction.
Concurrent insert either commits first and is removed, or sees deleted status and fails UX001.
State-only UPDATE validates identity immutability but takes NO user lock. This avoids own-user grant -> wake-row
versus all-subject locks inversion. Physical user deletion remains outside account anonymization scope.
Metadata cleanup is not consent-evidence cleanup: existing append-only decisions and backups remain untouched.

## Migration and evidence

0029 strictly follows0028, additive table/indexes/functions/triggers only. No DROP or legacy-data rewrite.
GIN subject membership, partial ready-due and lease-expiry indexes, unique logical key and source lookup.

Offline tests: canonical identity/dimension changes, rejected metadata, bounded backoff.
Real isolated DB tests: concurrent insertion, two claimers, crash/reclaim/expiry fencing, lost-wake prevention,
atomic wake rollback/no queue write, outage recovery, source obsoletion, deletion cleanup/concurrency,
identity mutation rejection and state updates while another subject is locked.
Migration-forward external fixture applies actual0028, inserts user/publication/append-only evidence, applies0029
and compares preserved evidence JSON. Fixture/evidence outside release tree.

Local DB only: `ustal_consent_blocked_20261020_1201_test` (through0029),
`ustal_consent_forward_20261020_1202_test` (explicit0028→0029 proof).
Run with NODE_ENV=test and local DATABASE_URL ending `_test`:

```
npx vitest run packages/database/src/consent-blocked-work.test.ts packages/database/src/consent-blocked-work.integration.test.ts
npm run typecheck -w @ustal/database
# From packages/database:
npx drizzle-kit check
```

No changes to matching/profile/registration/age/territories, prompts, ontology, embeddings or production.

## Independent review

Two real isolated-DB regressions were RED before correction: grant-before-insert and revoke-after-resume.
Updated fixture `ustal_consent_blocked_review_v2_20261020_test`: 17/17 PASS. Database typecheck and Drizzle check PASS.
Logs are outside Git. These primitives remain disconnected from actual workers and do not establish feature readiness.

Fresh root verification: 0028 -> updated 0029 preserves existing user/publication/append-only evidence; targeted account-deletion and consent API regressions 16/16 PASS. All DB fixtures are local and synthetic. No production migration applied.
