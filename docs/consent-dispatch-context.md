# Dormant AI dispatch/context infrastructure — 2026-10-20

This bounded slice adds **no actual production consent enforcement**. Default mode is off; no env flag or worker startup activates it, no DB authorizer exists, no trusted worker contexts are integrated and no approved real disclosure is created. It is not deploy-ready as an enforced feature and does not close public-launch consent readiness. Registration, age, territory, matching/profile algorithms, prompts, ontology, thresholds and jobs are unchanged.

## Implemented boundary

- AsyncLocalStorage carries server-resolved subject UUIDs, purpose, operation and trace. Frozen identifiers are canonicalized/deduplicated. Never build the context from a client userId or AI output.
- Explicit bootstrap-only configureConsentDispatch accepts off/enforced. Configuration can be set only once per process; callers cannot toggle off after enabling. This is a code integration API, not production authorization.
- Enforced requires a syntactically complete approved publication descriptor, exact provider/endpoint/purpose binding and a configured trusted authorizer. An old stored grant or arbitrary approved DB row is not enough: the future authorizer must verify the current operator-approved policy/hash, actual recipient/relay binding, active users and latest permissions for ALL subjects in ONE fresh committed snapshot. A single batch callback receives the immutable sorted subject set; sequential per-subject callbacks would allow read skew and are deliberately not supported. This slice supplies no real DB authorizer and cannot enforce a future callback's correct snapshot implementation by itself.
- Every public OpenAI provider method has a high-level precheck, including before STT downloads remote media. Actual OpenAI SDK fetch checks immediately before EACH transport request/retry, so nested verifier, repair, embedding and audio upload cannot rely on an earlier positive check.
- Enforced SDK transport uses redirect:error: native fetch redirects never get a second guard and must not forward POST data to another origin/path. Mode off retains existing redirect behavior. Actual loopback HTTP307/308 tests proved the initial leak RED, then zero unapproved receiver calls after correction; no real AI endpoint is used.
- Permission checks are not memoized. Missing context/publication, mismatch and denied permission produce typed sanitized AiConsentDenied. Check unavailability/malformed authorizer output produces policy_unavailable, never ordinary technical AI failure. Errors retain no source, subject identifiers, credentials or underlying error cause.
- Per-context denial is sticky. Public boundary rethrows it even when SDK wraps the thrown fetch error or a nested verifier catches it and produces degraded success. Denied operations cannot return a cacheable provider result. The wrapper does not modify prompts or healthy granted results.
- Global mode off preserves ordinary provider output. Mock providers remain offline; this slice does not claim to gate all future provider implementations. Any new real provider must use the central dispatcher before activation.

## Important remaining limits

Worker matching/general-access catch paths still classify arbitrary exceptions technically. They MUST explicitly handle AiConsentDenied before any technical fail-open when integrating enforced mode. Queued/recovery/rebuild/refresh/CLI sources need server-owned contexts; no blocked-work state/outbox0029 or resume semantics is implemented here. Current whole-run hash does not include consent revision/publication state. Do not enable this feature before those scopes are independently reviewed and implemented.

Revocation cannot recall a request already dispatched. The authorizer must use a fresh committed view before each attempt; do not share an old matching transaction snapshot or hold user locks across HTTP. Legal approval and real provider/relay inventory are separate from syntactic publication validation.

## Offline proof

Tests use the actual installed OpenAI SDK with fake fetch and fixture credentials only. They cover default off, missing context/authorizer/publication, both-party checks, endpoint mismatch, sanitized authorizer failure, 500-to-SDK-retry with revocation (no second network call), genuine scope-verifier catch returning degraded internally but typed denial externally, remote audio denied before download, healthy authorized output and parallel ALS isolation. Review fingerprint imports and mutation tests prove dispatch-source changes are included automatically.

Tests-first run was RED for missing module. Final raw AI/typecheck logs are outside the repo in release-candidates. Tests make no external AI calls; transport is fake except synthetic loopback HTTP for redirects. No production access, registration changes or deployment occurs in this slice.

Independent root re-review after redirect/read-skew corrections: targeted SDK/fingerprint35/35 PASS and AI typecheck PASS. Keep this feature branch separate from launch preparation until complete consent integration: importing the new dispatcher changes the review pipeline fingerprint even with mode off and would create cold-cache cost without providing real consent enforcement.
