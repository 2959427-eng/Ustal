# Integration of deployed security fixes — 2026-10-24

Candidate branch: `codex/security-integration-20261024`.
Base: GitHub `main`, `f8b610db7b27c156600fa5dea32e4c4236d9b876`, verified with
`git ls-remote`. The older local main checkout and other agents' uncommitted
work were preserved. This branch contains only the two deployed fixes and
their tests/documentation. No commit, push, merge or production mutation.

## Sources and parity

- Original admin patch SHA-256:
  `24af74de6840d1636810e36b184227d38d227d9ebc454eca08a32fed404433cf`.
- Original relay patch SHA-256:
  `24d36c585387ff6b3c4d6d281f61c30a2d8b411006d10274f23b1a14c4235080`.
- Both patches passed `git apply --check` against the base. Only relay code and
  tests were selected from its patch; the old deployment diary was excluded.
- All ten changed runtime admin files match `/repo/apps/admin` in the installed
  production container byte for byte. Test files come from the original patch.
- Caddyfile matches the mounted production file byte for byte, SHA-256
  `4a820c7501d6471ac08edba0b6afed71e17c46f34ce1ce15fad8cbd13c4259f1`.
  LF was retained for this file; no routing logic was rewritten.

## Included files

Admin:

- `apps/admin/app/(protected)/layout.tsx`
- `apps/admin/app/(protected)/moderation/actions.ts`
- `apps/admin/app/(protected)/ontology-candidates/actions.ts`
- `apps/admin/app/(protected)/reports/actions.ts`
- `apps/admin/app/(protected)/users/actions.ts`
- `apps/admin/app/login/actions.ts`
- `apps/admin/lib/admin-access.ts`
- `apps/admin/lib/admin-access.test.ts`
- `apps/admin/lib/admin-auth.ts`
- `apps/admin/lib/session.ts`
- `apps/admin/package.json`
- `scripts/verify-admin-security-e2e.mjs`

Relay:

- `infra/timeweb/relay/Caddyfile`
- `infra/timeweb/scripts/verify-relay.sh`
- `infra/timeweb/scripts/test-relay-allowlist.mjs`

## Verification

- Admin: 14 unit tests, lint and typecheck passed.
- Docker build of the integrated admin succeeded. As in the deployed build,
  prerender emitted missing DATABASE_URL diagnostics without failing the build;
  protected pages are dynamic and were subsequently tested against a local DB.
- The original browser E2E passed against that integrated Docker image and the
  existing isolated local test DB: login, privileged actions, moderator denial,
  deleted-user protection, disabled/deleted admin revocation, password changes
  and rejection of legacy cookies. No production DB or migration was used.
- Relay: 209 local checks passed on Caddy 2.8.4 with a mock upstream and real
  OpenAI SDK, including the actual verify-relay.sh; Linux Caddy 2.8.4 Docker
  validation also passed. No real OpenAI inference was required.
- Existing CRLF in admin source is preserved. Whitespace verification uses
  `git -c core.whitespace=cr-at-eol diff --check`.

## How the next release retains the fixes

1. Save this exact scoped candidate to GitHub and integrate it into main before
   releasing. Until that happens, GitHub main still does not contain these fixes.
   Do not deploy the older dirty local main or an unrelated worktree.
2. Build admin from the reviewed release SHA. Its unchanged Dockerfile copies
   `apps/admin` into the build/runtime image; the added auth/role code is therefore
   part of the default image, without depending on the temporary production
   candidate image tag. Existing CI runs admin tests through workspace scripts.
3. `deploy-app.sh` already rebuilds admin from the selected checkout. Do not reuse
   an old cached/tagged admin with `--no-build` as a substitute for that rebuild.
   Preserve a rollback image and verify login/legacy-cookie rejection after the
   separately authorized release. No deployment script was run in this task.
4. The relay Compose file mounts the repository Caddyfile, so fresh containers
   and future checkouts use the allowlist. For an existing individual-file bind
   mount, compare host/container hashes, preserve the inode when copying staged
   configuration, validate, then reload Caddy without restarting. Never assume
   git replacement of a mounted file made its new bytes visible in the container.
5. Run verify-relay.sh and confirm four allowed routes before accepting a release.
   Do not replace the relay configuration from an older checkout.

No API, worker, matching, mobile, DB schema, dependencies, Dockerfiles or deploy
scripts were changed. No conflicts needed manual resolution. Saving this branch
does not itself deploy anything or authorize another production release.
