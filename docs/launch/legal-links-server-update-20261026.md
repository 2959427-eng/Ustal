# Legal links for shipped iOS 1.0.0 (2) and Android 1.0.0 (4)

Base: `b5d191180002235aecbfb4974738cdc348c360d4`. Prepared locally only; no deployment, publication, commit, push or mobile rebuild.

## Verified build addresses

Both builds use `https://api.104-171-139-154.sslip.io` for all five LegalLinks: `/privacy`, `/terms`, `/community-guidelines`, `/support`, `/delete-account`. The AI Consent screen separately opens `https://ustal.site/privacy`.

The three original mobile source files match the saved iOS2/Android4 source-manifest hashes. Evidence: `C:/Users/User/Desktop/ustal-release-candidates/legal-links-b5d1911-20261026/build-url-evidence.json`. No mobile URL changes or new builds are needed for this fix. Source evidence does not replace native device acceptance.

Read-only production check: SHA `f8b610db7b27c156600fa5dea32e4c4236d9b876`; all five paths currently return404 on both origins. Local prepared behavior must not be represented as deployed.

## Exact update

1. API image from the approved baseline plus this change. Reuse existing `routes/legal.ts`, `legal/pages.ts`, `legal/publication.ts`, `web/account-deletion.ts`; do not create another renderer or deletion flow.
2. Owner-approved legal publication JSON, outside Git and mounted read-only using `infra/timeweb/app/docker-compose.legal.yml`. Set `USTAL_LEGAL_PUBLICATION_HOST_FILE` to its absolute host path; override supplies `USTAL_LEGAL_PUBLICATION_FILE=/run/ustal/legal-publication.json`. Missing host file must not be created automatically. Invalid content fails API startup. Approval of all five actual rendered pages is necessary; local draft Markdown alone is not published by this renderer. No approved bundle has been invented or installed.
3. Replace the complete application Caddyfile with the reviewed `infra/timeweb/app/Caddyfile`. Preserve existing API/admin upstreams, domain variables, ACME setting, site root and www redirect. Exact read-only legal paths on ustal.site proxy to the same API. `/legal.css` is included. `/delete-account` redirects302 to the existing API-origin page; its JS/auth/me/delete/logout calls remain same-origin. Do not expose `/auth/*` or `/me` on ustal.site or redirect API POST/DELETE requests.
4. API recreation and validated Caddy reload must be coordinated in one authorized update. An API-only update cannot change the currently deployed site404 handler. No worker/admin/mobile/DB migration or consent-enforcement change is needed for the link fix. Preserve DB volume and current consent/age configuration.

Changed implementation/config: Caddyfile + new Compose override. Test changes: existing API legal test + new local Caddy routing test. No production or secret changes.

## Checks before and after authorized publication

Local:18 actual Caddy routing checks;20 API/legal/deletion-client tests; full Caddy validation; Compose structural validation PASS. Checks use synthetic fixtures, never an approved production policy or real user deletion.

After publication, verify all five API-origin pages return200 HTML with nonempty title/body and no draft markers. Verify CSS and deletion JS return200 with correct MIME. Verify four informational site pages200, site deletion302 to API deletion200, www redirect, no TLS errors or redirect loops. Site auth/me paths remain404. Recheck API health and admin login unchanged.

On BOTH actual iPhone build2 and Android build4: open each of the five account links, read/scroll text, follow navigation, return to app, open AI Consent Privacy link at ustal.site/privacy. Check no blank page, download prompt, TLS warning, missing styles or404. For deletion use only an isolated synthetic account: validate login, password error, unchecked confirmation, logout and controlled active-work409; any actual deletion requires its scoped test approval. Do not infer whole product E2E or new production API functionality from link checks.

Android hardware is not currently available. iPhone access/installation does not yet prove these URL checks. No native-device PASS claimed.

## Remaining authorization

Approve the factual rendered documents and actual publication metadata, then separately authorize commit/push and the specific API+Caddy+read-only-file rollout. Existing legal approval/localization/transborder gaps are not marked complete by this routing change. No Google Play declarations or public store release are authorized.
