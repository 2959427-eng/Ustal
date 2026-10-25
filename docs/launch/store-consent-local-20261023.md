> Исторический отчёт исходной ветки. Актуальный результат объединения и совместных проверок: [store-consent-integration-20261024.md](store-consent-integration-20261024.md).

# USTAL — local Store Compliance / AI consent preparation

Branch: codex/store-consent-launch-20261023. Base: db335874fee03d8ef472a617f8054ac79d34ff5d (reviewed iOS candidate; includes production f8b610db). No commit, push, merge, production access or configuration change.

## Approved owner parameters

18+ users; first target market Russia, international expansion later. https://ustal.site; support@ustal.site. No new technical country block. App Store age rating remains a separate questionnaire.

## Local implementation

Registration and legacy select-city route require an unchecked-by-default 18+ self-declaration. Mobile API rejects missing confirmation before sending credentials. Shared registration schema accepts true, rejects false/string/coercion, and accepts missing only for old-build compatibility. This is self-declaration, not verified age. The existing backend does not yet persist age evidence; old/existing users are not deemed adults automatically. A future mandatory server-wide age policy and durable evidence require a separate reviewed rollout; this preparation must not be represented as complete age enforcement.

Settings link opens /ai-consent. Only /me/consents registry data is used; no AsyncStorage/local grant or second ledger. Requests include existing policyId/hash/expectedRevision. Previous-version grants can be revoked. Concurrent submissions are blocked; failures/conflicts require explicit refresh, not optimistic success/retry. Refusal creates no grant. Registration never grants AI permission.

Server routes currently exist only with enforcement enabled. 404/offline/off-mode show an explicit warning, never a promise that AI stopped. No API/worker config or dispatch code was changed. No registry content seeded. No migration; reuse 0028–0029.

## Before activation

Approve final humanText (draft: legal/ai-consent.md), retention, processing locations, recipient conditions and legal grounds. Bind approved registry content to actual recipients/purpose and pipeline. Check web Privacy/deletion pages before publication. Consent API read/write availability and old-build controlled error UX must be prepared before activation. Pause AI writers for coordinated API/worker transition; queued/retry/in-flight and all matching subjects remain guarded by the existing infrastructure. Do not replay extraction.

UGC ownership: no community-guidelines or moderation code was copied/edited. Claude must confirm one shared outbound guard, no AI call without applicable permission, no automatic publication of unreviewed UGC, manual/pending path when AI is refused. This contract has NOT been confirmed with Claude in this task. No independent UGC policy is introduced.

## Tests and limits

Mobile full 136/136 PASS; validation full 8/8 PASS. Mobile/validation/API typecheck PASS. Tested request version/hash/revision, off-mode, draft/TBD refusal, old-policy revoke, double-submit, network failure, stale revision; age request and legacy schema compatibility. New screen not exercised on a physical device. Existing worker/DB pipeline was not changed or retested. No live AI, full matching/blind or production writes.

## Still requires approval/verification

Retention and backup periods; legal basis/cross-border/localization obligations for a Russian launch; exact processing locations and final processor disclosure; final Privacy/Terms and permission text; old-client mandatory-update policy; durable age evidence and existing-user confirmation rollout; photo access policy; UGC contract. S3 DeleteObject is already confirmed by a separate real test, not an open permission blocker. Legal pages remain drafts, not published documents.
