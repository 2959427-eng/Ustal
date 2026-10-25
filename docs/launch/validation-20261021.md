> Исторический отчёт исходной ветки. Актуальный результат объединения и совместных проверок: [store-consent-integration-20261024.md](store-consent-integration-20261024.md).

# Проверки store-compliance candidate

Ветка `codex/store-compliance-20261021`, base db335874. Проверка2026-10-21. Никаких commit/push/merge/deploy/build/upload/legal publication/store form changes. Consent OFF не изменён.

## Результаты

- API legal publication/rendering/escaping/header/approval boundary:4/4.
- Web deletion client:8/8 —204 success only, repeated password/checkbox, identity mismatch, single-flight, session cleanup,403/409/429/500/401, timeout uncertainty, no automatic DELETE replay. HTTP contract mocked intentionally; это не повторный destructive production E2E.
- Retention configuration:3/3 —6категорий, неутверждённое правило не может считаться действующим, нет default duration или cleanup scheduler.
- Mobile legal URL:2/2.
- Android explicit/transitive broad permission guards:2/2. Offline Expo57 mod introspection:PASS (baseline active READ_MEDIA_IMAGES; candidate tools:node=remove image/video). Не AAB/Gradle merge verification.
- Локальный фактический HTTP:7/7 responses200 для5страниц, CSS и deletion JS; header/CSP подтверждены. Browser rendering удаления просмотрен; никакой реальный аккаунт не вводился/удалялся.
- Typecheck новых API modules/tests:PASS (strict NodeNext).
- Full mobile source typecheck:PASS через внешнюю dependency resolution config.
- Full API source typecheck:PASS через внешнюю dependency resolution config с едиными ESM declarations Drizzle. Не выдаётся за новый `npm ci && npm run typecheck` в этом checkout.
- Diff check:PASS с корректным учётом CRLF.
- Matching/AI/worker/full existing suites не повторялись: их исходники и зависимости не изменены; новый SQL/deletion lifecycle отсутствует.

## Ограничение среды и воспроизведение

Свободно около1GiB наC. В новой ветке нет собственного установленного node_modules. Использованы существующие toolchains: API `ustal-consent-integration-20261020`, mobile `ustal-ios-review-db335874-20261021`. Новые checkout не связаны symlink/junction и чужие файлы не менялись. Все runtime tests читают новые файлы; pure mobile test запускается из побайтной внешней копии из-за Expo extends resolution. Набор зависимостей/lockfiles продукта не менялся.

Внешние configs, logs, screenshot, HTTPJSON: `C:/Users/User/Desktop/ustal-release-candidates/store-compliance-20261021/`. API run: установленный `vitest.mjs run --config .../vitest-api.mjs`; mobile аналогично `vitest-mobile.mjs`. Source tests расположены в обычных app src directories и будут выполняться штатными workspace commands после `npm ci`. На машине с достаточным местом перед интеграцией выполнить стандартные affected workspace suites/typecheck без внешних resolver aliases. Новый EAS build не запускался.

Generated draft Markdown: `node scripts/render-legal-drafts.mjs` (Node24). Это локальные документы, не публикация. API preview запускался отдельным read-only harness на127.0.0.1:4187 без подключения к DB или production.

## Native / publication acceptance ещё требуется

1. Утверждённые документы безTBD, рабочий контакт и постоянный HTTPS origin; проверить5URL без login из целевых стран, правильные response types, TLS/redirects, мобильный экран.
2. Login/account ссылки на iOS/Android, small screen+keyboard scroll, browser back/offline/error, без передачи access token в URL.
3. Отдельный разрешённый build2; текущая IPA1.0.0(1) не меняется.
4. Camera/photo/mic/push allow/deny; Android Photo Picker на поддерживаемых OS, настоящее release merged manifest/AAB без broad image/video и лишних release permissions. Системный picker не подтверждён здесь physical-device тестом.
5. До UGC — действительное versioned принятие утверждённых правил. Текущие acceptedRulesAt/acceptedPdnAt, автоматически записанные сервером, не доказывают принятие конкретного текста.
6. Утверждённое AI disclosure и отдельно разрешённое включение consent enforcement, deny/revoke до outbound; OFF в этом scope сохранён.
7. Жалобы/блок, admin action и removal на всех UGC surface; если AI policy применяется — in-app flag результата без выхода из приложения.
8. Deletion на disposable test account через app и browser: правильный account, password403, active work409, support resolution/lost access identity, success204, session invalidation и media cleanup proof. S3 IAM permission проверить до обещания физического удаления.

## Независимый self-review изменённого scope

Проверены: same-origin fetch, no-cookie bearer auth, no persistent browser tokens, explicit deletion confirmation, no fallback GET credential leak (inputs безname и CSP form-action none), no error→success conversion, escaped operator content, CSP without inline code, publication fail-closed, no changes to existing deletion/password/permission enforcement on server. Подтверждённых новых correctness/security blockers не найдено. Это self-review, не отдельный внешний аудитор и не store approval.

Публичные legal URLs на production остаются404; jurisdiction/legal adequacy, основание хранения retained content, внешние processors/training/retention и фактические IAM/backups не подтверждены. Именно поэтому статусBLOCKED, а не «готово к submission».
