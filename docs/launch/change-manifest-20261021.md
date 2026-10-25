# Store-compliance change manifest

Base: db335874fee03d8ef472a617f8054ac79d34ff5d. No commit/push/deploy.

- `AI_HANDOFF.md`
- `apps/api/src/app.ts`
- `apps/api/src/legal/pages.ts`
- `apps/api/src/legal/publication.ts`
- `apps/api/src/legal/retention-policy.test.ts`
- `apps/api/src/legal/retention-policy.ts`
- `apps/api/src/routes/legal.test.ts`
- `apps/api/src/routes/legal.ts`
- `apps/api/src/web/account-deletion.test.ts`
- `apps/api/src/web/account-deletion.ts`
- `apps/mobile/app.json`
- `apps/mobile/app/(auth)/login.tsx`
- `apps/mobile/app/(tabs)/account.tsx`
- `apps/mobile/src/components/LegalLinks.tsx`
- `apps/mobile/src/lib/legal-links.test.ts`
- `apps/mobile/src/lib/legal-links.ts`
- `docs/android-photo-permissions-20261020.md`
- `docs/launch/change-manifest-20261021.md`
- `docs/launch/data-inventory-20261021.md`
- `docs/launch/legal/community-guidelines.md`
- `docs/launch/legal/delete-account.md`
- `docs/launch/legal/privacy.md`
- `docs/launch/legal/support.md`
- `docs/launch/legal/terms.md`
- `docs/launch/retention-policy.template.json`
- `docs/launch/store-compliance-20261021.md`
- `docs/launch/store-declarations-20261021.md`
- `docs/launch/validation-20261021.md`
- `scripts/android-photo-permissions.test.cjs`
- `scripts/render-legal-drafts.mjs`

No matching/AI/worker/database source changes. New files are code/tests/docs/scripts, not credentials or raw production data. Secret-pattern scan PASS (not an absolute proof against all secrets).
