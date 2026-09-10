# USTAL: commit accumulated work into logical commits.
# Run this whole block in PowerShell from C:\Users\User\Desktop\ustal-foundation
# No push at the end - local commits only.

git add package-lock.json
git commit -m "chore: refresh package-lock.json"

git add .gitignore
git commit -m "chore: ignore accidental artifacts and local scratch files"

git add "apps/mobile/src/api/orders.ts" "apps/mobile/src/api/feed.ts" "apps/mobile/src/api/my.ts" "apps/mobile/src/api/contacts.ts" "apps/mobile/src/api/responses.ts" "apps/mobile/src/api/reviews.ts" "apps/mobile/src/api/assignments.ts" "apps/mobile/app/order/" "apps/mobile/app/(tabs)/orders.tsx" "apps/mobile/app/(tabs)/responses.tsx"
git commit -m "mobile: order feed, my orders/responses, and order detail screens"

git add "apps/api/src/routes/orders.ts" "apps/api/src/routes/profile.ts" "apps/worker/src/handlers/order-extraction.ts" "apps/worker/src/handlers/profile-extraction.ts" "apps/worker/src/handlers/order-transcribe.ts" "apps/worker/src/handlers/profile-transcribe.ts" "apps/worker/src/index.ts" "packages/queue/src/index.ts" "packages/database/src/schema.ts" "packages/database/src/migrations/0005_dashing_anthem.sql" "packages/database/src/migrations/meta/0005_snapshot.json" "packages/database/src/migrations/meta/_journal.json" "packages/validation/src/orders.ts" "packages/validation/src/profile.ts" "packages/api-client/src/index.ts" "apps/mobile/app/(tabs)/create.tsx" "apps/mobile/app/(tabs)/index.tsx" "apps/mobile/app/(tabs)/profile.tsx" "apps/mobile/src/components/AiInputField.tsx" "apps/mobile/src/components/VoiceRecorder.tsx" "apps/mobile/src/components/PhotoPicker.tsx" "apps/mobile/src/api/profile.ts" "apps/mobile/src/api/media.ts" "apps/mobile/src/lib/"
git commit -m "mobile+backend: split voice pipeline into transcription review before AI extraction"

git add "apps/mobile/src/api/blocks.ts" "apps/mobile/src/api/me.ts" "apps/mobile/src/api/reports.ts" "apps/mobile/app/blocked-users.tsx" "apps/mobile/src/components/ReportModal.tsx" "apps/api/src/routes/blocks.ts"
git commit -m "mobile: user blocking and reporting"

git add "apps/mobile/src/api/notifications.ts" "apps/mobile/app/notifications.tsx" "apps/mobile/app/settings.tsx"
git commit -m "mobile: notifications and settings screens"

git add "apps/api/src/routes/my.ts" "apps/api/src/routes/responses.ts"
git commit -m "backend: enrich order/response read models for mobile client (orderAuthorId, assignmentStatus, assignmentId)"

git add "apps/api/src/routes/media.ts"
git commit -m "backend: reject uploads with dangerous file signatures regardless of declared mime type"

git add "apps/api/src/app.ts" "apps/api/src/routes/auth.ts" "apps/admin/app/login/actions.ts" "apps/admin/lib/login-rate-limit.ts"
git commit -m "security: rate-limit login attempts, restrict CORS/Swagger to non-production, hide 5xx error details from clients"

git add "apps/mobile/app.json" "apps/mobile/babel.config.js" "apps/mobile/tsconfig.json"
git commit -m "mobile: point at production API URL and fix Babel/TS build config"

git add ".ai-bridge/" "scripts/codex-bridge.ps1" "AGENTS.md" "AI_HANDOFF.md"
git commit -m "chore: add Claude<->Codex file-bridge tooling and AI handoff log"

git log --oneline -15
git status --short
