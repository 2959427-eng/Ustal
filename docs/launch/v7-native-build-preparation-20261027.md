# USTAL v7 — подготовка нативного перевыпуска, 2026-10-27

## Состояние интеграции
Каноническая папка: C:/Users/User/Desktop/ustal-release-1.0.0, release/ustal-1.0.0.
Текущий HEAD синхронизирован с remote release: 53b2fe0be256a2364a807b7246f642c874bf04b3. Полный snapshot/WIP до синхронизации: C:/Users/User/Desktop/ustal-release-candidates/v7-final-prep-20261027 (701 файл, SHA256, staged/unstaged/combined patches, HEAD.zip, index.backup). Все файлы после синхронизации побайтно совпали, удаления сохранены.
Содержимое согласованного 53b2fe0 и v7 подготовлено в рабочем дереве без commit/merge/push. v7 остаётся незакоммиченным поверх согласованного baseline.
Патч SHA256: d9ff302b69d1078379b8cfa380d1e48b1b8c74f922525f88252e0ac70dddad3e.
Сравнение с независимой проверкой v7: все исходники совпадают; намеренные дополнительные изменения — только конфигурация native/OTA и release-документация/manifest/guard.
API/worker/database/infra совпадают с 53b2fe0, включая уже проверенные исправления baseline. AI Consent OFF и production не менялись.
Полные тесты не повторялись: перенесён точно проверенный код (212 unit +24 navigation +18 independent PASS). Серверная media-ownership integration проверка и физические устройства ранее не проверены.

## Фактические данные EAS (read-only)
Project: 89ebf4b0-85c8-499a-907c-44e2a5f8f5a0, kimkos1980/ustal.
Remote version:get: iOS buildNumber=2; Android versionCode=4.
Production profile: appVersionSource=remote, autoIncrement=true, distribution=store, environment=production.
Следующий build: iOS 1.0.0 (3), Android 1.0.0 (5), если до запуска никто не повысит remote counters. Повторно прочитать counters непосредственно перед согласованным запуском; не снижать. Локальный устаревший ios.buildNumber=1 удалён, поскольку EAS его игнорирует. Remote counters не менялись.
Build:list вернул 4 сборки, 3 finished и 1 errored; последние finished: iOS a17f8f22-4ef7-410c-8ce1-21cff9bec874 (2), Android 3912960c-f781-4dd2-b002-6773affe868d (4). Их git SHA db335874fee03d8ef472a617f8054ac79d34ff5d; runtimeVersion=null, channel=null. Channel:list пуст.
Исходники app.json/app.config.js/eas.json/package.json этого build SHA проверены: expo-updates/URL/runtime/channel не настроены. Сам IPA/AAB не распаковывался: это граница доказательства, а не утверждение о независимой проверке каждого распространённого файла.

## OTA и native
expo-crypto требует новых нативных бинарников обеих платформ. Новые app.json: updates.enabled=false; runtimeVersion=1.0.0-v7-expo57-crypto57; production profile без OTA channel. Версия приложения 1.0.0 сохранена.
Доставка v7 только внутри новых binaries; никакого eas update. Новые бинарники используют bundled JS. Новый runtime не совпадает с пустым runtime старых сборок. Старые каналы, remote конфигурация и бинарники не изменялись.
Если позже понадобится OTA, это отдельное решение: отдельный совместимый runtime/channel и повторная проверка, без публикации v7 в старые runtimes. Текущая ручная runtime-метка должна меняться при следующем native изменении.

## Минимальная приёмка на физическом iPhone и Android
Использовать новые native builds, не Expo Go. Тестовые A/B, согласованный тестовый backend; production не менять. При OFF окно согласия при отправке не ожидается, ИИ может выполняться по текущему режиму сервера. Для проверки блокировки/отказа нужен отдельный локальный/тестовый enforced backend с утверждённой fixture-политикой; не включать enforced в production.
1. A: ввести профиль, затем заказ (текст, цену, фото). Переходы по вкладкам и экрану согласия сохраняют ввод в одной сессии. Проверить отказ/разрешение на тестовом enforced backend: возврат без автоматической отправки; отказ блокирует; после разрешения одна явная отправка.
2. A → выход → B: профиль/заказ/цена/фото/композер пусты; старый callback/завершившееся фото не добавляет данные A и не отправляет запросы токеном B. B может создать собственный заказ с собственной ценой и фото.
3. Сохранить тестовый старый маршрут A с prefillSession, полностью завершить процесс, войти B и открыть маршрут: A prefill не появляется; legacy id=1 тоже отклоняется. В обычной новой сессии пустые поля ожидаемы: drafts только в памяти.
4. С действующей сессией пройти refresh access token: своё содержимое не теряется; повторного заказа нет. Отложенный refresh A после входа B не восстанавливает A.
5. Подтвердить в native runtime ненулевой 32-hex session ID (без вывода токенов/текста в логи), обе платформы не падают при старте, ExpoCrypto присутствует; лог генератора не должен использовать Math.random. Проверить номер установленной сборки 3/5 (или фактический больший).

## Перед разрешённым запуском
1. Синхронизация истории уже выполнена без commit: HEAD=remote=53b2fe0, index соответствует baseline, WIP сохранён. Следующий commit должен включать точный snapshot v7 и подготовленную native конфигурацию; commit/push требуют отдельного разрешения.
2. Повторно проверить counters и отсутствие параллельного build/release. Signing проверен read-only: iOS certificate/profile active, expiration2027-04-14; Android default JKS назначен. Apple Portal login не выполнялся, live revocation validation не заявляется. Использовать актуальную EAS CLI, совместимую с Expo57 (локальная 18.1.0 устарела).
3. После явного разрешения EAS Build: из apps/mobile — eas build --platform ios --profile production и отдельно --platform android; без --auto-submit. Здесь команды НЕ запускались.
4. Пройти физическую приёмку выше до публикации. Store/TestFlight/Play загрузка требует отдельного разрешения.

Осталось: закрепить snapshot после разрешения; нативная компиляция; физическая приёмка. Старые артефакты не распакованы, OTA отсутствие подтверждено EAS metadata+исходниками их build SHA. Ни build, ни OTA, ни публикация, ни изменение production не выполнялись.

Документация: https://docs.expo.dev/build-reference/app-versions/ ; https://docs.expo.dev/versions/latest/config/app/ ; https://docs.expo.dev/eas-update/runtime-versions/


## Финальная проверка 2026-10-27
READY для отдельно разрешённых commit/push и двух native builds. HEAD=remote=53b2fe0; весь snapshot/WIP сохранён. npm ci, mobile typecheck, 11 затронутых тестов и autolinking crypto57/core57 обеих платформ PASS. Counters iOS2/Android4, next3/5; credentials read-only найдены. Отчёт: C:/Users/User/Desktop/ustal-release-candidates/v7-final-prep-20261027/RESULT.md. Физическая приёмка и native compilation остаются последующими проверками до распространения. Commit/push/EAS Build/deploy/OTA не выполнялись.

## Разрешённый commit/push и API gate — 2026-10-27
Владелец разрешил commit/push только release/ustal-1.0.0. Allowlist40 файлов проверен; постороннего WIP нет. API gate PASS: Google/Cloudflare DNS api.ustal.site ->104.171.139.154; strict TLS/SAN PASS (new certificate2026-10-26..2027-01-24). Новый и legacy api.104-171-139-154.sslip.io: /health200 локально и независимые Globalping узлы Hetzner(DE)/HostPapa(US), /me401 без redirect. Legacy strict TLS PASS до2026-12-04. Production Caddy/DNS не менялись. EAS counters повторно2/4 -> target3/5; production API=https://api.ustal.site; OTA OFF; signing из read-only проверки текущего сеанса пригоден (без live Apple revocation login). READY для отдельно разрешённого EAS Build; запуск не выполнялся.
Внешние measurement IDs: new2gqNy7KB62wuaECJg00021OHy; legacy2qYGmPCH4xjCrfrzL00021OHy. Raw evidence: C:/Users/User/Desktop/ustal-release-candidates/v7-final-prep-20261027/*-domain-globalping.json.
