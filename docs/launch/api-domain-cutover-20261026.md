# API domain preparation — 2026-10-26

Preparation only: no DNS changes, production edits/reload, mobile build, OTA update,
store release or deployment have been performed. Target: `https://api.ustal.site`.

## Source and compatibility

- PR base: published `release/ustal-1.0.0` at
  `b5d191180002235aecbfb4974738cdc348c360d4`.
- Reviewed `main`: `5d5e63d9f280a1ca05a52d8b9b1f6cac1dc70e3b`.
  The branches diverge. This patch must target release, not merge all release work
  into main. A main backport requires a separate reviewed integration.
- The canonical Desktop release checkout has additional local legal-document WIP;
  it was read only and is excluded from this patch.
- The committed `release-baseline.json` describes the historical pre-commit
  `db335874` integration, so its path/branch/HEAD/hash verifier does not pass in
  this isolated branch. It has not been weakened or overwritten. This change is
  identified by the exact published base above and the PR commit/diff. The
  integrator must issue the next canonical baseline when accepting the patch.
- New builds accept exactly the public HTTPS origin `https://api.ustal.site`.
  Credentials, paths, query/fragment, private/dev hosts and other origins remain
  rejected. `app.config.js` already uses the same validator for release profiles;
  it does not need an additional URL fallback or a broader allowlist.
- Installed binaries keep their embedded sslip origin and existing token/session
  storage. The server must continue serving that hostname directly, without a
  cross-host redirect. API/worker/database contracts are unchanged. Do not push
  this JS as an OTA update into an old binary with an old embedded API setting.

## Read-only production findings

- `ustal.site` A: `104.171.139.154`; authoritative nameservers:
  `ns1.hosting.reg.ru`, `ns2.hosting.reg.ru`.
- `api.ustal.site`: NXDOMAIN via public DNS at inspection time; HTTPS is not ready.
  Apex has no AAAA or CAA record in the public lookup.
- Legacy API `/health` and apex HTTPS returned 200 with verified public TLS from
  the VPS. Legacy certificate SAN matches the old API hostname (expires
  2026-12-04); apex certificate expires 2027-01-19. A Windows HTTPS probe timed
  out during TLS handshake, so external client reachability must be rechecked
  from an independent network before approving cutover. No TLS checks were bypassed.
- App VPS `ustal-app-msk` owns `104.171.139.154` (SSH also reachable at
  `147.45.141.94`); current source checkout is `f8b610d`.
- Caddy 2.8.4 proxies `{$API_DOMAIN}` to `api:4000`;
  `API_DOMAIN=api.104-171-139-154.sslip.io`.
- Production also has `ustal.site` / `www.ustal.site` website blocks not present in
  the repository app Caddyfile. **Do not replace the whole production file with
  the repository template.** Apply only the additional API hostname to its
  existing API block; preserve website/admin blocks and all other settings.
- Caddyfile is a read-only file bind mount from
  `/opt/ustal-foundation/infra/timeweb/app/Caddyfile`; `/data` and `/config` are
  persistent Docker volumes.

## Safe cutover — requires separate owner authorization

1. At reg.ru DNS create only `api` A → `104.171.139.154`, initial TTL 300.
   Keep apex/www/admin and the old sslip hostname intact. Do not add AAAA unless
   IPv6 reachability to Caddy is independently confirmed. Check effective CAA
   restrictions and ACME issuer compatibility before requesting a certificate.
2. Wait for authoritative and public resolvers to agree. Confirm external TCP
   80/443 reachability. No mobile build may use the new hostname before DNS and a
   trusted certificate are ready.
3. Back up the **actual** Caddyfile with restrictive permissions and record its
   hash/inode and the container-visible hash. Confirm the backup is readable and
   restoration will write the old content back to the same bound inode. If an
   inode-preserving update is not possible, stop rather than recreate Caddy.
4. Change only the existing API site address to
   `{$API_DOMAIN}, api.ustal.site`. Keep `API_DOMAIN` on the old hostname; no
   environment update or container recreation is needed. Write the content in
   place, not by replacing/renaming the bound file. Check the updated content and
   SHA-256 **inside** `app-caddy-1` before validating it.
5. Run in the existing container:

   ```sh
   docker exec app-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec app-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   Reload only after validation succeeds. Do not stop/recreate the container or
   run the application deployment script. Caddy obtains/renews public certificates
   after DNS and ACME reachability are correct. Do not use TLS bypasses or an
   internal/self-signed certificate for the mobile API.
6. Validate a trusted certificate, hostname/SAN and expiry for the new address;
   check `/health` on both HTTPS origins. Confirm the legacy origin does not
   redirect to the new one. Check expected unauthenticated 401 responses, a
   separately authorized synthetic-account login/refresh and media request, and
   absence of new API/worker/Caddy errors. Recheck admin and apex/www availability.
   Do not expose tokens or real user data in reports.
7. Only after both origins work, separately authorize the new mobile build/release.
   Check the resolved Expo/EAS production config uses the new origin and the same
   application identity/project. Keep the legacy hostname for the supported
   lifetime of installed clients and any stored absolute media/legal URLs.
   Domain readiness does not waive privacy/terms approval or other release gates.

## Rollback

Before mobile distribution, if validation/reload/new-host checks fail, immediately
write the saved Caddyfile content back to the original inode, verify the
container-visible hash, validate/reload, then verify legacy `/health`, admin and
website access. Do not rotate credentials, change databases or redirect old
clients. DNS may remain pointed at the VPS while troubleshooting, but the new
origin is not release-ready until HTTPS checks pass again.

After any new-origin mobile build is distributed, rollback must retain **both**
hostnames; removing `api.ustal.site` would strand those clients. Restore the
working upstream route/configuration while continuing to serve both origins.

## Validation

Run mobile tests/typecheck/lint. In a local disposable Caddy 2.8.4 container with
no network, validate/adapt the repository Caddyfile using synthetic API/admin
domain and ACME-email environment values. Confirm both API hostname matchers
route directly to the same `api:4000` upstream, without a cross-host redirect.
Actual certificate issuance, device networking and production cutover remain
unverified until the separately authorized DNS/Caddy step.

References: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[Caddyfile reload](https://caddyserver.com/docs/quick-starts/caddyfile).
