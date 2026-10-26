# USTAL 1.0.0 — canonical integration baseline

Owner decision, 2026-10-25; integration verified 2026-10-26: Codex is the only release integrator. Claude implements only against an explicitly agreed snapshot and supplies a patch for independent review.

- Repository: `C:/Users/User/Desktop/ustal-release-1.0.0`
- Branch: `release/ustal-1.0.0`
- Base commit: `f38ce4c360c65ff95878d9bc79587c533195d8bc`
- Reviewed upstream: `5d5e63d9f280a1ca05a52d8b9b1f6cac1dc70e3b`
- Production ancestor: `f8b610db7b27c156600fa5dea32e4c4236d9b876`
- Pending change: owner-authorized legal-page presentation corrections only; commit/push and API-only rollout authorized on 2026-10-26. Exact content is identified by `release-baseline.json` file hashes.

Before any work run `node scripts/verify-release-baseline.mjs`. Stop on repository, branch, HEAD or file-hash mismatch. Do not fall back to another checkout or main. Do not edit until the integrator agrees a new baseline.

Claude must receive the same base commit and complete file-hash manifest, not just a branch name or old commit. Patches must record their base SHA and baseline manifest hash. Codex reviews and integrates only unique authorized changes, reruns affected checks, and issues a replacement manifest. Other worktrees remain preserved historical/WIP sources, not release sources.

The canonical baseline above was committed and pushed with owner approval. The owner separately authorized this legal-publication change for commit/push and controlled API/Caddy deployment on2026-10-26. The guard accepts the anchored base or one direct child containing this exact committed manifest and matching every file; an unrelated/merge/later commit or changed content is rejected. Text hashes normalize CRLF to LF for Git checkout portability; binary hashes are unchanged. After a separately authorized commit, record and distribute its real SHA, never an invented future SHA. Existing Git branches must not be rewritten. Production deployment and store submissions require separate authorization.

The unavailable `public-legal-pages-2026-10-25.patch` is excluded by the owner's explicit instruction. It has not been reconstructed or represented as reviewed.

Owner accepted5defee9 on2026-10-26; previous legal WIP retained in archive and stash. New API-domain preparation is retained; shipped mobile builds remain unchanged and new-domain activation requires DNS/HTTPS readiness.
