## Current approved unified mobile snapshot — 2026-10-30

HEAD `19fee21f9fa44f799879c8b840df0436bfdf0811`, canonical `release/ustal-1.0.0`. Owner authorized uncommitted integration of verified shipped Android1.0.0(7) and iOS1.0.0(9) common UI: bottom tabs, paginated feed, shared order composer, embedded responses, styling and expo-font57.0.3. iOS consent implementation remains the shipped default module; Metro resolves the exact shipped Android implementation via ai-consent-flow.android.ts. Account management link is retained on iOS and absent on Android, matching the shipped builds. No new consent policy, server mode or approved text. Cities, adapted empty-profile CTA and age-duration fix2 retained. All prior WIP preserved in external source archive. This manifest identifies the COMPLETE uncommitted snapshot, not clean HEAD alone. Prior notes below are historical. No commit/push/native build/deploy performed or authorized by this preparation.

Validation: all-workspace typecheck PASS plus final mobile typecheck; mobile Vitest243; navigation iOS62 and Android62; lint0 errors/9 existing warnings. Prior isolated DB76/76 gate retained: server/domain/matching/prompt files byte-identical to that validated candidate. New tests preserve all earlier assertions and add actual bottom-tab navigation and platform management-link checks. Android navigation is reproducible with npm run test:navigation:android -w @ustal/mobile -- --runInBand; iOS uses test:navigation. Physical-device acceptance remains unverified.

## Current approved snapshot — 2026-10-30

Owner-authorized uncommitted full snapshot on HEAD `19fee21f9fa44f799879c8b840df0436bfdf0811`, canonical release/ustal-1.0.0. Includes all original 18 WIP entries, support-v3, consent-once, city optimization, profile-empty CTA and committed legal-publication corrections. Exact source is release-baseline.json; HEAD alone is insufficient. Claude task "33 года" must start from this complete snapshot and record the manifest SHA256 in its patch handoff. Prior entries below are historical. No commit, push, builds or deploy authorized by this baseline refresh. Canonical UI differs from shipped iOS9/Android7; this snapshot is not authorization to replace those builds.

## Current approved snapshot — 2026-10-28

Base commit c09bcad5a1a1fb0323e1345e7c866c7e27e4fd6f; owner-authorized compact-registration patch SHA2569551ddfafb5c10fe204a898600c41ac9c51a64940972a34967a20950c467ccb0 plus minimal raw-phone-input fix and regression coverage. Normalized phone remains10 digits, outgoing format+7XXXXXXXXXX. Existing server contracts, v7 isolation, Expo lockfile and legal modals preserved. Commit/push only release/ustal-1.0.0; no builds, OTA or deploy. Earlier baseline notes below are historical.
## Current approved snapshot — 2026-10-27

Release merge: `9d7ec73039bd409481e17d78e451e2a7be7af5a2` (PR7 legal modals, CI PASS). This manifest anchors the iOS/TestFlight preparation to that merge. Owner authorized integration, a new iOS build and TestFlight upload only; no App Store publication, OTA, server or production changes. Earlier preparation notes below are historical.

# USTAL 1.0.0 — canonical integration baseline

Owner decision, 2026-10-25; integration verified 2026-10-26: Codex is the only release integrator. Claude implements only against an explicitly agreed snapshot and supplies a patch for independent review.

- Repository: `C:/Users/User/Desktop/ustal-release-1.0.0`
- Branch: `release/ustal-1.0.0`
- Base commit (local HEAD synchronized 2026-10-27): `53b2fe0be256a2364a807b7246f642c874bf04b3`
- Reviewed source baseline / remote release: `53b2fe0be256a2364a807b7246f642c874bf04b3`
- Reviewed upstream: `5d5e63d9f280a1ca05a52d8b9b1f6cac1dc70e3b`
- Production ancestor: `f8b610db7b27c156600fa5dea32e4c4236d9b876`
- Pending snapshot, authorized 2026-10-27: full reviewed 53b2fe0 source + SHA-verified v7 + native/OTA configuration. Owner authorized commit/push of this exact snapshot on 2026-10-27, only to release/ustal-1.0.0. EAS Build/OTA/publication/production changes are not performed. Build plan: `docs/launch/v7-native-build-preparation-20261027.md`. Exact content is identified by `release-baseline.json`; this is an uncommitted v7 working-tree snapshot on the agreed Git baseline 53b2fe0.

Before any work run `node scripts/verify-release-baseline.mjs`. Stop on repository, branch, HEAD or file-hash mismatch. Do not fall back to another checkout or main. Do not edit until the integrator agrees a new baseline.

Claude must receive the same base commit and complete file-hash manifest, not just a branch name or old commit. Patches must record their base SHA and baseline manifest hash. Codex reviews and integrates only unique authorized changes, reruns affected checks, and issues a replacement manifest. Other worktrees remain preserved historical/WIP sources, not release sources.

The canonical baseline above was committed and pushed with owner approval. The owner separately authorized this legal-publication change for commit/push and controlled API/Caddy deployment on2026-10-26. The guard accepts the anchored base or one direct child containing this exact committed manifest and matching every file; an unrelated/merge/later commit or changed content is rejected. Text hashes normalize CRLF to LF for Git checkout portability; binary hashes are unchanged. After a separately authorized commit, record and distribute its real SHA, never an invented future SHA. Existing Git branches must not be rewritten. Production deployment and store submissions require separate authorization.

The unavailable `public-legal-pages-2026-10-25.patch` is excluded by the owner's explicit instruction. It has not been reconstructed or represented as reviewed.

Owner accepted5defee9 on2026-10-26; previous legal WIP retained in archive and stash. New API-domain preparation is retained; shipped mobile builds remain unchanged and new-domain activation requires DNS/HTTPS readiness.



