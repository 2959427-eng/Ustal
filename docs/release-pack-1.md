# Release Pack 1 — 2026-09-29

Рабочая папка: `C:\Users\User\Desktop\ustal-codex`, ветка `codex/work`.
Статус: код и локальные проверки подготовлены; подписанная iOS-сборка и production E2E не выполнялись.
Ни commit/push, ни build/upload/deploy, ни миграции не выполнялись.

## Что исправлено

- EAS: production/store/Release, физический iPhone, remote buildNumber с autoIncrement. `ios.buildNumber=1` — начальное значение; `version=0.1.0` меняется вручную перед согласованным релизом. Для существующего ASC приложения сначала синхронизировать remote build number выше последнего загруженного.
- Expo SDK 57 / React Native 0.86.3 / React 19.2.3: установленные версии сверены с Expo bundledNativeModules и lockfile. Зависимости не обновлялись.
- Образ `macos-tahoe-26.5-xcode-26.6` опубликован Expo для SDK 57: [Expo infrastructure](https://docs.expo.dev/build-reference/infrastructure/). Xcode 26.6 удовлетворяет минимуму Xcode 26 + iOS 26 SDK для загрузок с 28.04.2026: [Apple requirements](https://developer.apple.com/news/upcoming-requirements/?id=04282026a). Это проверка конфигурации, не доказательство успешной native сборки.
- Production API проверяется и при вычислении Expo config, и в release runtime. Разрешён только существующий origin `https://api.104-171-139-154.sslip.io`. HTTP, localhost, private IP, IPv6 loopback/private, IP aliases, посторонние домены, credentials/query/path отклоняются. Новый домен требует изменения allowlist после проверки. Dev LAN сохранён; `.env.local` не менялся.
- Production требует настоящий `EAS_PROJECT_ID`; при отсутствии конфигурация падает с понятной ошибкой. Значение не выдумано и не сохранено.
- Logout отменяет транспортные запросы, query observers и очищает QueryClient; поколения сессий не допускают поздние данные/refresh A в B. SecureStore сохраняет пару токенов атомарно в одном ключе; старые ключи читаются для совместимости и удаляются на logout. Native записи сериализованы, включая запоздавшую запись A.
- Logout сначала подтверждает DELETE /devices для текущего владельца и токена. При сетевой ошибке выход не объявляется успешным: пользователь повторяет его после восстановления сети. B может зарегистрировать тот же токен. Поздний DELETE от A не выключит устройство B.
- Списки собственных заказов/откликов загружают все страницы, а не первые 20/50. Ключи учитывают параметры и разделяют список/один заказ. `/my/responses?orderId=...` фильтруется на сервере по пользователю и заказу до LIMIT, сохраняя assignment/actions у старых записей.
- Исполнитель загружает `/orders/:id/view`: канонические разрешённые поля, а не переданные title/price/photos. API проверяет доступ, активность автора и блокировки. Экран открывается по одному orderId; ошибки имеют повторную загрузку.
- Startup имеет loading/retry UI и общий предел 35 секунд после инициализации taps (до 3 секунд). Обычный HTTP — 20 секунд, multipart — 60 секунд, SecureStore — 5 секунд. Offline/временная ошибка не стирают сессию; явно отозванная сессия очищается; ошибка Keychain предлагает повтор.
- expo-notifications plugin, explicit projectId, token detach/re-register, orderId в payload, обработка warm/cold notification taps. Production worker использует Expo provider; mock в production отклоняется. Expo HTTP ограничен 15 секундами, DeviceNotRegistered деактивирует токен; accepted tickets проверяются через receipts jobs (через 15 минут, ограниченные повторения). Receipt A ограничен владельцем и временем регистрации и не должен выключать новый B.

## Доказательства и ограничения тестов

До исправлений воспроизведено 19 падающих случаев: небезопасная config/timeout, первые 50, cache/Keychain, push detach, Expo errors, orderId/invalid token в worker. Дополнительные тесты гонок и новых API добавлены после реализации.

| Проверка | Результат |
|---|---|
| mobile typecheck | PASS |
| mobile lint | PASS: 0 errors, 5 существовавших warnings unused imports |
| mobile suite | 73/73, 13 файлов |
| API route contracts | 3/3: Fastify inject + mocked DB, реальные Drizzle WHERE выражения |
| notification worker unit | 4/4, включая stale owner и receipt constraints |
| notifications provider | 2/2 |
| API, worker, api-client, notifications, admin typecheck | PASS |
| matching package | 112/112; файлы/тесты совпадают с SHA256 в начале задачи |
| git diff --check по Release Pack | PASS |
| полный root npm run test | FAIL — интеграционная БД недоступна, не all-green |

Полный suite: API 16 passed / 6 failed / 104 skipped (22 failed suites); worker 73 passed / 8 failed / 72 skipped (6 failed suites); ontology 4 failed: ECONNREFUSED на локальном PostgreSQL. Blind evaluation 14 passed / 1 failed: EACCES в pg-pool/verifyRuntimeIsolation; isolation tests сообщают отсутствие тестовой БД. Отдельно прошли AI 133, config 19, domain 7, matching 112, storage 4, validation 5. На момент полного запуска mobile было 68, worker notification unit — 2; последующие дополнительные тесты прошли отдельно (финальные числа выше).

Лог полного запуска: `release-pack-1-suite.log` (локальный ignored artifact). Docker engine/PostgreSQL сейчас недоступны. Они не запускались, БД/миграции не создавались. Новые API-тесты проверяют контракты и фильтры, но не заменяют интеграцию с реальным PostgreSQL, блокировки строк и pg-boss. Полный suite необходимо повторить на подготовленной изолированной тестовой БД перед релизом.

## Что должен предоставить/сделать владелец

1. Expo account/organization, существующий или новый реальный EAS project. Его UUID задать как `EAS_PROJECT_ID` локально при config/build и в EAS production environment (обычная видимость, это не секрет). При необходимости указать настоящий `expo.owner`. Конфигурация специально не проходит production без этого значения.
2. Apple Developer Program/team; подтвердить владение `ru.ustal.app` и создать/проверить App ID и App Store Connect app. Apple credentials вводить только через штатный EAS/Apple workflow, не в исходники/чат.
3. Distribution signing certificate/provisioning profile, Push Notifications capability и APNs authentication key для этого EAS проекта. ASC app ID нужен для последующей submission; submit credentials/автоматическая submission здесь не настроены.
4. Подтвердить marketing version и начальный remote build number с учётом существующих загрузок. API origin должен иметь действующий TLS и доступный production backend; доступность/содержимое production не проверялись этим пакетом.
5. Перед мобильным rollout выпустить совместимый API (GET /orders/:id/view, DELETE /devices, orderId filter), worker и Expo provider. На старом backend новый logout/detail не считаются совместимыми. Worker должен иметь PUSH_PROVIDER=expo; EXPO_ACCESS_TOKEN требуется при включённой Expo enhanced push security, хранится только на сервере.
6. Повторить DB suite, затем отдельно разрешить build/upload. Этот пакет не требует собственных миграций. Миграции Claude не запускались и не оценивались как выполненные.

## Обязательная проверка на iPhone/TestFlight

- Чистая установка и обновление существующей: launch без пустого бесконечного экрана; login/register, Keychain persistence, kill/relaunch, airplane mode, refresh timeout/401/revoked, восстановление сети и повтор.
- A: профиль/заказы/отклики/фото → задержанные запросы → logout → B. Ни cache A, ни поздний refresh A не должны появляться/перенаправлять B. Повторить после обновления со старым форматом SecureStore.
- A: разрешить push → подтвердить device row → logout → проверить isActive=false → создать новое событие A: отправка на эту установку отсутствует. B login: тот же token теперь B, B уведомления приходят. Повторить отказ в permission, перезапуск, timeout DELETE и его повтор. Уведомление, уже переданное APNs до logout, нельзя отозвать; проверять отдельно новые отправки после ACK detach.
- Tap в foreground/background/killed app: только orderId, без title/price params. Проверить холодный запуск, logged-out tap → login → нужный заказ, недоступный/удалённый/заблокированный заказ без утечки данных.
- 121+ собственных заказов/откликов, старый активный заказ за пределами 50: переговоры, контакты, договорились, report completion/issue, завершение и отзыв в доступных ролях.
- Фото/multipart на медленной сети, 401→refresh→retry, отмена при logout; проверить UI ошибки и повтор. Физически проверить camera/photos/microphone и notification permissions.
- Реальные Expo tickets→receipts и DeviceNotRegistered после переустановки/удаления приложения; delayed receipt A после регистрации B не выключает B. Проверить PostgreSQL row-lock race отправка↔detach, pg-boss receipt retries.

## Статус пунктов readiness audit

Пункты указаны по содержанию, без присвоения новых номеров старому аудиту.

| Приоритет / проблема | После Release Pack 1 |
|---|---|
| P0 production EAS/store/version strategy | Конфигурация подготовлена; аккаунт, подпись и фактическая сборка ещё обязательны |
| P0 release с локальным/HTTP API | Закрыто в коде и regression tests; нужен production config с реальным projectId |
| P1 данные A после logout/login B | Исправлено и проверено локально; device acceptance остаётся |
| P1 push остаётся за A | Detach/ownership/race/receipt guards реализованы; APNs/DB/device acceptance остаётся |
| P1 первые 20/50 скрывают свои активные заказы/отклики | Исправлено, 121-record regression и response61 contract PASS |
| P1 detail зависит от navigation params | Исправлено, orderId-only и access contracts PASS; native taps остаются |
| P1 startup/network/Keychain hang | Исправлено и unit-tested; native Keychain/offline acceptance остаётся |
| Остальные P0/P1 audit (account/data deletion, AI consent, policy/store content и др.) | В этом пакете не закрывались |

Opportunity/vacancies/feed UI, matching, profile_facts, AI-profile/extraction, account deletion, AI consent не редактировались. В дереве есть другие незакоммиченные изменения до задачи и параллельные изменения Claude. SHA256 matching package и Opportunity screen остались прежними; профильные файлы изменялись внешним процессом. В app.ts добавлены только import/register orderViewRoutes с сохранением регистрации Claude.

Короткий путь: **сегодня** реальные EAS/Apple настройки + изолированная DB-проверка + интеграция согласованного кода → **TestFlight** отдельное разрешение на build/upload, совместимый backend, device matrix выше → **App Store review** оставшиеся compliance/metadata/account requirements исходного аудита → **production** согласованный main, поэтапный rollout и мониторинг. Не откатывать API ниже новых контрактов пока установлен новый клиент; при откате worker учесть pending receipt jobs. Полный инфраструктурный rollback этим пакетом не реализован.

## Файлы Release Pack 1

Это список файлов с изменениями этого пакета, а не весь dirty git status. В общих файлах могут быть сохранённые чужие изменения.

- `apps/mobile/eas.json`
- `apps/mobile/app.json`
- `apps/mobile/app.config.js`
- `apps/mobile/config/api-url.js`
- `apps/mobile/config/api-url.d.ts`
- `apps/mobile/app/_layout.tsx`
- `apps/mobile/app/(auth)/login.tsx`
- `apps/mobile/app/(auth)/register.tsx`
- `apps/mobile/app/(tabs)/account.tsx`
- `apps/mobile/app/(tabs)/orders.tsx`
- `apps/mobile/app/(tabs)/responses.tsx`
- `apps/mobile/app/archive.tsx`
- `apps/mobile/app/order/[id].tsx`
- `apps/mobile/src/api/auth.ts`
- `apps/mobile/src/api/auth.test.ts`
- `apps/mobile/src/api/client.ts`
- `apps/mobile/src/api/session.ts`
- `apps/mobile/src/api/session.test.ts`
- `apps/mobile/src/api/startup.ts`
- `apps/mobile/src/api/startup.test.ts`
- `apps/mobile/src/api/my.ts`
- `apps/mobile/src/api/my.test.ts`
- `apps/mobile/src/api/order-view.ts`
- `apps/mobile/src/api/order-view.test.ts`
- `apps/mobile/src/api/release-regressions.test.ts`
- `apps/mobile/src/lib/deadline.ts`
- `apps/mobile/src/state/query-client.ts`
- `apps/mobile/src/notifications/push.ts`
- `apps/mobile/src/notifications/push.test.ts`
- `apps/mobile/src/notifications/navigation.ts`
- `apps/mobile/src/notifications/taps.ts`
- `apps/api/src/app.ts`
- `apps/api/src/routes/devices.ts`
- `apps/api/src/routes/my.ts`
- `apps/api/src/routes/order-view.ts`
- `apps/api/src/routes/release-pack.test.ts`
- `apps/worker/src/handlers/notification-dispatch.ts`
- `apps/worker/src/handlers/notification-dispatch.test.ts`
- `packages/api-client/src/index.ts`
- `packages/notifications/src/index.ts`
- `packages/notifications/src/types.ts`
- `packages/notifications/src/providers/expo.ts`
- `packages/notifications/src/providers/expo.test.ts`
- `infra/timeweb/app/docker-compose.prod.yml`
- `docs/release-pack-1.md`
- `AI_HANDOFF.md`
