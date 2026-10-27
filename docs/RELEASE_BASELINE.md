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



