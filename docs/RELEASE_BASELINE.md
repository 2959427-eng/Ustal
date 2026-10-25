# USTAL 1.0.0 — canonical integration baseline

Owner decision, 2026-10-25; integration verified 2026-10-26: Codex is the only release integrator. Claude implements only against an explicitly agreed snapshot and supplies a patch for independent review.

- Repository: `C:/Users/User/Desktop/ustal-release-1.0.0`
- Branch: `release/ustal-1.0.0`
- Base commit: `db335874fee03d8ef472a617f8054ac79d34ff5d`
- Reviewed upstream: `5d5e63d9f280a1ca05a52d8b9b1f6cac1dc70e3b`
- Production ancestor: `f8b610db7b27c156600fa5dea32e4c4236d9b876`
- Integration content: uncommitted; identified by `release-baseline.json` file hashes. The base commit alone does NOT identify this release.

Before any work run `node scripts/verify-release-baseline.mjs`. Stop on repository, branch, HEAD or file-hash mismatch. Do not fall back to another checkout or main. Do not edit until the integrator agrees a new baseline.

Claude must receive the same base commit and complete file-hash manifest, not just a branch name or old commit. Patches must record their base SHA and baseline manifest hash. Codex reviews and integrates only unique authorized changes, reruns affected checks, and issues a replacement manifest. Other worktrees remain preserved historical/WIP sources, not release sources.

No commit or push was authorized. After a separately authorized commit, record its real SHA and distribute that exact commit as the shared baseline; do not invent a future release commit SHA. Existing Git branches must not be rewritten. Production deployment and store submissions require separate authorization.

The unavailable `public-legal-pages-2026-10-25.patch` is excluded by the owner's explicit instruction. It has not been reconstructed or represented as reviewed.
