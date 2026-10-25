# Store Compliance + AI Consent: combined local candidate

Date: 2026-10-24. Branch: `codex/store-compliance-integration-20261024`. Base HEAD: `db335874fee03d8ef472a617f8054ac79d34ff5d`.

**Code integration: complete. Joint verification: PASS.** Changes are intentionally uncommitted. This record supersedes the earlier integration STOP in the external `store-integration-snapshots-20261023T142955Z/BLOCKED.md`; that historical report is preserved, not the current status.

## Integrated code

Both input snapshots were SHA256-verified against their manifests and their live source worktrees before transfer. Source worktrees remain unchanged. Combined legal API/page/deletion infrastructure, mobile login/account/registration links, Android permission guards, adult self-declaration and AI consent screen/API client. The shared account menu retains both LegalLinks and AI Consent. No staged files, merge commit, push, deployment or production access.

Public legal pages still require an explicitly approved publication bundle in production. Local previews and synthetic test fixtures are not published policies. Registration shows separate unchecked age/Terms/PDN controls; the client no longer fabricates acceptedRules/acceptedPdn. This does not invent versioned UGC acceptance or approve legal drafts. No UGC implementation owned by Claude was modified.

### Staged server age policy

`USTAL_REGISTRATION_AGE_MODE=compatibility` is the safe default and is documented in `.env.example`. It accepts the previous registration payload without asserting that the user is an adult. Explicit false/nonboolean declarations are rejected by the shared schema. New mobile registration requires the checkbox and sends literal true.

`USTAL_REGISTRATION_AGE_MODE=required` requires literal `acceptedAge18=true` at POST /auth/register; missing/false/string/number returns HTTP400 `age_confirmation_required` with an update/confirmation message. It does not gate existing login, refresh, profile reads or account deletion. No backfill or retrospective age assertion for existing users.

Explicit true is recorded as audit action `registration_age_confirmed`, method `self_declaration`, policy `18+`, source registration and enforcement mode. User/profile/session/evidence are committed atomically; failed registration leaves no partial user or invented event. No schema migration is needed. This is a self-declaration, not verified age.

Future staged rollout: ship server compatibility mode and the compatible mobile client first; inspect registration error rates and explicit declaration evidence; enable required for NEW registrations only in a separately authorized config/deploy operation. Old-build registration then receives the controlled error, while existing accounts keep login/refresh/deletion. Rolling registration mode back to compatibility does not erase recorded declarations or grant AI permission. Do not call compatibility mode mandatory age enforcement for all users.

### Consent surface during OFF

Authenticated GET /me/consents is always registered and reports actual `outboundEnforcement`. POST grant while off returns HTTP409 `consent_enforcement_inactive` without creating evidence. Revoke remains available for a prior grant even when off or its policy has been replaced. Existing revision/hash/identity checks and the append-only registry remain the only evidence ledger.

Mobile mirrors this contract: off mode disables grant, allows prior-grant revoke, displays an explicit warning that OFF does not stop AI, and requires refresh after conflicts/failures. Registration never grants AI consent. No worker/SDK configuration, matching or production mode was changed. Enforcement still requires a separate coordinated activation and approved disclosure/recipient binding.

## Fresh joint verification

Used a new own `npm ci --legacy-peer-deps --no-audit --no-fund` installation, not resolver aliases or symlinks to another agent's checkout. Tests/typechecks used the bundled supported Node runtime. Installation initially used the system Node20 and warned that OpenAI7 needs Node22+; test execution used the bundled newer runtime. Lockfile/dependency sources were not changed by installation.

Local PostgreSQL16/pgvector only, published on `127.0.0.1:55439`, synthetic credentials, database names ending `_test`, NODE_ENV=test, mock AI/push/SMS and no external AI keys/publication file. Migrations through0029 applied locally; canonical reference seed loaded locally without editing ontology sources.

| Check on combined sources | Result |
|---|---:|
| Full API | 226/226 PASS |
| Full mobile | 140/140 PASS |
| Full database consent/sidecar | 33/33 PASS |
| Worker consent integration | 16/16 PASS |
| Full validation | 8/8 PASS |
| Full config | 24/24 PASS |
| Android broad-permission config tests | 2/2 PASS |
| API, mobile, validation, config, worker typecheck | PASS |
| CRLF-aware diff check | PASS |

449 tests total across the above scopes; worker16 is a targeted suite, not a rerun of all worker tests. Full matching/AI/blind suites were not rerun and are not claimed. Existing source/API tests still cover account/media deletion, responses, negotiations, blocking, profile lifecycle and concurrency.

New full-app regressions cover legacy/default registration, invalid/missing required declaration rejection before writes, explicit evidence in both modes, no implicit AI grant, transaction rollback on failed registration, and existing-user login/refresh/profile/deletion in required mode. OFF API read and grant rejection plus grant-in-enforced/revoke-in-off are tested against actual local DB. Mobile tests reject missing legal acceptance before clearing an existing session and cover no implicit consent, old-policy revoke, conflicts and double submit. Legal rendering, publication gate, XSS/CSP, retention parser and web deletion client are included in the API suite.

Initial targeted test incorrectly expected local draft previews to be404; corrected to verify the documented test preview behavior, while existing production-gate tests continue requiring404 without approval. An initial unseeded full API run had three existing profile-item tests fail because they assume ontology reference nodes. No fixture/threshold was changed: a NEW database with the canonical seed passed the entire226-test API suite. Initial failed logs are retained separately; they are not acceptance evidence.

Evidence: `C:/Users/User/Desktop/ustal-release-candidates/store-consent-integration-20261024/` (`joint-results.json`, `joint-final-results.json`, full logs and final source manifest). Local disposable container `ustal-store-consent-integration-20261024` is dedicated to these synthetic tests. No production database, remote config or Apple/EAS resources were accessed.

## Review and boundaries

React checklist: legal/age checkboxes default unchecked and expose checkbox state; event guards prevent missing acceptance; consent mutations have a shared single-flight lock and no optimistic success; OFF/retry/error states do not claim permission or stopped transmission. Links never include auth tokens. Physical-device layout/keyboard/back-stack tests remain outstanding.

Input Store Compliance and Consent worktrees are hash-identical to the snapshots. Matching, ontology, worker, database schema/migrations and Claude source worktree are untouched. Config source changes can invalidate the existing source-based AI review fingerprint on a future rollout; this is a potential cold-cache cost, not a matching semantic change or permission to run rematch.

## Remaining release blockers, not integration STOPs

1. Final approved legal/retention/processor/location/disclosure content and separately authorized publication. Preserved drafts/fixtures are not legal approval; production URLs were not checked or changed in this task.
2. UGC owner integration/acceptance and pending/manual behavior when AI is refused, versioned agreement evidence and existing-user rollout. Claude's implementation was not edited; this record does not certify that separate contract.
3. Separately authorized coordinated consent enforcement rollout and required-age mode activation, plus a new mobile build/device acceptance, legal link availability and actual native permission verification before store release. No build, TestFlight submission or production activation performed.

There is no remaining technical blocker in this integrated code/test scope. Existing users are not locked out by the age rollout. Public/store release readiness remains distinct from this completed local integration.
