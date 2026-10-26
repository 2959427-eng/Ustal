# Consent infrastructure — local draft implementation

This scope does **not enforce consent on outbound AI calls**. The routes are deliberately not registered in app.ts. No registration, profile, matching, age, territory or production configuration behavior changes. Runtime dispatch gates and UI are a separate audited scope; deploying these tables alone does not close the explicit AI permission launch gap.

## Registry and decisions

- Migration 0028 follows cleanup migration 0027. Additive tables/functions/triggers only; no existing data updates and no seeded approved disclosures or fabricated historical grants. Registry starts empty.
- Registry: immutable purpose/version/content/content hash, draft/approved/retired status, at most one current version per purpose. Trusted publication tooling must calculate disclosureHash(content), review recipients/purpose/text and obtain owner approval; there is deliberately no public policy approval API. Tests create clearly synthetic approved fixtures only in an isolated local test database.
- Content hash uses sorted object keys and ordered arrays. Grant requires the exact stored content hash, independently recomputed from JSON content, and an approved current policy. Draft, stale, unknown and mismatched policies return controlled 409.
- POST /me/consents requires policyId, policyHash, decision grant/revoke and expectedRevision. Identity comes only from authenticated request.userId; extra body fields are rejected. GET /me/consents returns current disclosures, latest decision per purpose and overall revision. Both responses are no-store.
- User row locking serializes grant/revoke against each other and account deletion. Current revision is max per-user seq; each changed decision appends exactly the next sequence. Repeated identical decisions are no-ops when expectedRevision is current; stale concurrent requests return 409, not a silent overwrite. Revoke remains available after a policy is retired.
- Evidence includes subject=actor, policy/hash, server timestamp and sequence. DB triggers independently enforce active-user, sequential ordering, grantability, immutability and append-only evidence. Current API supports self-service actors only, not administrator impersonation.

## Retention and compatibility

Consent evidence remains linked to the anonymized users row after logical account deletion. It is not exposed through this API after deletion; direct late inserts also fail. This is a proposed pseudonymous audit record, **not an approved retention/legal basis**. Owner must approve the retention/deletion matrix before launch; no duration is invented. Append-only guards require a separately authorized maintenance/migration path for any approved erasure policy, not disabling them during ordinary deletion.

Schema is additive and old binaries do not access these tables. Do not automatically down-migrate or drop collected evidence on application rollback. No actual migration or production publication is authorized by this draft.

## Remaining integration

Root integration must register the route with real authenticate/rateLimit plugins and run real JWT/route smoke before enabling it. Existing-user disclosure UI, approved content publication, immediate provider-boundary guards for all paths in consent-boundaries inventory, background jobs, both-party review, revocation handling and whole-run revision invalidation remain unimplemented. A grant in this infrastructure alone cannot prove any provider is gated; no provider-call acceptance is claimed.

## Local evidence

Tests were authored before implementation; initial run failed because the route module did not exist. Targeted unit/integration tests exercise real PostgreSQL, with a test-only authentication hook to isolate the unregistered route. Tests fail closed unless NODE_ENV=test and DATABASE_URL names a local *_test database. Dedicated test evidence rows are intentionally retained (append-only); no production or user database is touched.

## Notice binding (2026-10-26)

The app shows a fixed owner-approved notice (`AI_CONSENT_TEXT`, apps/mobile/src/lib/ai-consent-flow.ts). A grant is bound to it:
- the approved disclosure must carry `content.notice` — an array of paragraphs equal, character for character, to `AI_CONSENT_TEXT`; `content.humanText` holds the full terms, shown in the app before the decision ("Полные условия"). Both are covered by `content_hash`;
- the app grants only when the current approved policy's notice matches, and re-reads `/me/consents` right before sending; if policy, version, hash or revision changed, nothing is sent;
- a grant body carries `policyVersion` and `notice`; under the existing user/advisory locks `decideConsent` rejects a different version (`consent_policy_changed`) and, for a policy with a notice, a missing/different notice or version (`consent_notice_mismatch`), as well as a notice sent for a policy without one;
- revoke/refusal needs no notice; `policyVersion` on revoke is checked when present. Old clients without these fields keep the previous behaviour only for policies without `content.notice`; once the published policy has a notice, an old client's grant is rejected (fail-closed) and the user must update the app.
