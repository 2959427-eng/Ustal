# AI Consent v3 independent integration review — 2026-10-26

## Source and boundary

Original Claude patch SHA-256 verified: `3fc6f22f2b97d96b6e95bd1d40513e368ea3b4dfc6149ff4208374a5cf1b73c1`.
Applied unchanged directly to clean `e9816629da6da62728e0038b73867cc78ef9a054` in isolated `codex/ai-consent-v3-review-20261026`; no v1/v2 overlay. Review/integration destination explicitly authorized by owner. Canonical baseline path guard is preserved, not weakened or represented as a release authorization. No changes to main, other WIP/worktrees, production or enforced mode. No mobile/EAS build or deploy.

## Results

- `git apply --check`, reverse applicability, whitespace and secret-pattern scan PASS.
- Full tests on newly created local PostgreSQL 16/pgvector database, loopback-only port 15439; migrated/seeded synthetic fixtures only: database **33/33**, API **265/265**, worker **433/433**, mobile **191/191**.
- Additional complete matching **229/229**, AI **244/244** tests PASS.
- Mobile typecheck with locally installed Expo 57 / TypeScript 6 dependencies PASS. API/worker/database typecheck PASS.
- Mobile lint: 0 errors, 8 warnings in unchanged files. API/worker/database lint scripts are no-ops; typecheck/tests provide actual coverage.
- Independent assertions compare four notice paragraphs and both labels against supplied owner-approved TXT (not a rewritten test fixture): exact match. Missing/changed/reordered notice makes client grant unavailable. Policy version/hash identity changes rejected; full server humanText is available inline via the versioned full-terms control.
- New API integration tests cover notice/version/hash mismatch, direct POST without required binding, off-mode revoke, duplicate calls and concurrent version change. Database/AI/worker suites exercise missing consent, revoke before execution and in-flight revoke, result fences, durable pause/regrant/retry, both-party permissions, recipient mismatch and actual OpenAI SDK with synthetic transport. No real OpenAI endpoint/data used.
- Full suites include registration, login, profile, order, matching, revocation and legacy request regressions. No matching implementation or dependency changes.

## Compatibility and release gates (not authorized by this PR)

1. Publish only the approved AI policy with exact `content.notice`, reviewed full `content.humanText`, correct purpose/version and canonical content hash; bind the actual provider/relay recipient configuration to that same publication. Tests use synthetic policies and do not certify any production policy is published.
2. Policies without notice retain legacy request behavior. For a new notice-bearing policy, legacy grants without notice/version fail closed (409); legacy revoke remains supported. Old mobile binaries therefore need an update path before enforced/new-policy activation. This PR must not be treated as transparent enforced activation for every old client.
3. Prior refusal is not automatically re-prompted; user can decide from account. Earlier grants remain revocable in off/unavailable and enforced modes.
4. Owner/legal reviewer must approve full conditions, actual recipients/processing locations/data categories, retention/deletion and withdrawal description, and consistency with published privacy/terms. No legal facts or approval status invented.
5. Coordinate API plus worker versions, approved policy/publication, old-client handling and a rollback plan under a separate production authorization. Off-mode revoke records the decision but does not claim server outbound enforcement is enabled.
6. Physical-device navigation/accessibility and full end-user device E2E are not certified by unit/integration tests. No Expo export or mobile build was requested/performed.

PR targets only `release/ustal-1.0.0`. No merge authorized.
