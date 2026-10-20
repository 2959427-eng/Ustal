# Consent worker lifecycle - local integration, not activation approval

## Invariant

In enforced mode each job resolves its owner from the database. Before storage preparation/provider invocation and every actual SDK request (including retry/verifier) the current approved disclosure, actual cached SDK recipient binding and latest decisions of ALL subjects must allow the operation. No positive permission cache. Matching reviews use fresh per-pair contexts; one denial cannot poison another candidate. Pure matching classification algorithms, thresholds, ontology and general-access policy are unchanged.

Permission at dispatch is an admission point. An already sent request cannot be recalled. Before derived profile/fact/transcript/vector/order/matching results commit, a short transaction checks the captured publication and exact decision revisions under shared permission/publication gates (and shared user locks for profile results). A committed revoke, replacement publication, or revoke-then-regrant invalidates an old result. No extra HTTP is performed under these result locks.

## Pause and resume

Typed policy denial never becomes technical review fail-open, extraction failure or recovery exhaustion. Original pg-boss job completes only after a durable0029 metadata pause exists (or its source/account is demonstrably obsolete). No copied source texts or credentials. Missing grant waits after one fresh probe; authorization outage uses bounded backoff. Existing recovery scanners avoid recreating paused owner work.

A grant atomically signals matching blocked rows in the same decision transaction. Dispatcher uses bounded SKIP LOCKED leases and reconstructs trusted current sources/current publication, not captured source text or old grants. New queue execution has a new stable job UUID; retries retain that UUID. Queue source singletons plus existing handler idempotency fence enqueue-before-ack crashes. Deleted/revoked/superseded sources cannot resurrect. Pair denial makes whole-run state nonreusable; full-pool permission revisions and publication metadata enter whole-run validity.

## Configuration boundary

USTAL_AI_CONSENT_MODE=off preserves existing behavior. USTAL_AI_CONSENT_MODE=enforced and USTAL_AI_CONSENT_PURPOSE=<approved purpose> are explicit coordinated API/worker configuration. No real legal text or consent is invented by code. Enforced startup without a current approved publication refuses job admission. Publication content must match the server-owned provider/endpoint/recipient fingerprint; a row marked approved alone is insufficient. No production configuration has been changed.

Public activation still requires an actually approved disclosure, final legal/contact decisions, and user-facing consent presentation. Synthetic local test publications are not permission for real users. This document does not certify public-launch readiness.

## Evidence

Evidence logs and local DB fixtures remain outside Git. Initial targeted worker13 plus sidecar17 =30/30 PASS; real STT and facts handler denial paths, actual concurrent matching jobs, fake SDK transport with an in-flight revoke barrier. AI241/241 PASS. Final full suites and independent audit are recorded below after completion. No live AI, push, main merge, deployment or production access.

## Final concurrency protocol

Consent decisions take the existing owner user lock then exclusive advisory permission gate17. Profile result transactions take user SHARE then shared gate17. Matching already holds order FK locks: it takes only shared permission gates, not an author user-row lock, avoiding delete-account user->order inversion. Matching pair pause writes flush after the main transaction releases its FK/order locks, before the queue handler returns. Failed pause persistence fails the job, never silently acknowledges lost work. Matching source identity excludes derived delivery bookkeeping; SQL to_jsonb snapshots prevent postgres/Drizzle timestamp parser changes from invalidating unchanged work.

Real separate-process acceptance on newly migrated local v5 DB: two actual worker index processes; missing consent0 outbound requests; worker restart plus real grant resumes exactly1 localhost fake AI request, total2 completed queue jobs, failed0. The first v4 attempt exposed unstable timestamp hashing and was stopped; its database was preserved. No production or external AI was used.

Independent read-only audit confirmed0 correctness/security blockers after the concurrency corrections, conditional on final full suites. Enforced HTTP API registration/auth/grant/revoke/wakeup tests2/2 PASS. Current targeted worker16/16 includes SDK retries/epoch changes, real STT/facts, actual matching/cache and author-deletion lock barrier. Final suite totals follow in the integration acceptance record.
