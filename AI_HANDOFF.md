# AI_HANDOFF — 2026-09-14 — Claude Cowork: найден и исправлен реальный баг аватара — `Unsupported FormData part implementation`

Codex закончился лимит использования во время исправления (см. запись ниже) сразу после того, как пользователь на реальном телефоне репродуцировал точную ошибку с новой диагностикой «Этап: …»: **«Этап: загрузка на сервер. Unsupported FormData part implementation»**. Продолжаю за неё.

**Причина найдена и исправлена.** `apps/mobile/src/api/media.ts` на native (`Platform.OS !== "web"`) добавлял файл в `FormData` старым RN-шорткатом:
```ts
form.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
```
На нашей версии `react-native@0.86.3` глобальный `fetch` это больше не понимает — падает именно на этапе построения тела запроса, ДО того как что-либо уходит на сервер (это и объясняет, почему запрос не доходил до API вообще, что подтвердил и пользователь другому инстансу — сервер живой, прямая загрузка через API отдельно работает). Убрала ветвление `Platform.OS === "web"` целиком — теперь **везде** (web и native) файл сначала читается через `fetch(file.uri).then(r => r.blob())` (это работает и для `file://`/`content://`/`ph://` на native, не только для `blob:`/`data:` на web) и в форму добавляется уже настоящий `Blob`, как раньше было только в web-fallback-ветке. `Platform` из `react-native` в файле больше не импортируется — не используется.

Файл: `apps/mobile/src/api/media.ts`, сейчас 2892 байта, изменение закоммичено через file-bridge и перепроверено байт-в-байт (без отката).

**Пожалуйста:**
1. Прогони typecheck/lint/тесты mobile (я не могу их запустить без shell/git-доступа) и закоммить это вместе с диагностикой Codex (`AvatarPicker.tsx`, сейчас 6627 байт — стадии «Этап: …» с санитайзингом токенов/адресов, это хорошее постоянное улучшение, оставить).
2. Задеплой мобильный клиент (или просто убедись, что Metro раздаёт актуальный бандл — `exp://172.30.1.36:8081`) и попроси пользователя ЕЩЁ РАЗ повторить загрузку аватара прямо сейчас, пока он на связи в этом диалоге — если это была единственная причина, ошибка должна исчезнуть полностью (не просто смениться на другую «Этап: …»).
3. Заодно попроси пользователя перезагрузить приложение (полный reload Expo Go) и проверить город при регистрации — см. мою более раннюю запись ниже: сервер отдаёт 1160 городов, но пока не подтверждено, что это видно живьём на телефоне.

---

# AI_HANDOFF — 2026-09-13 — Codex: диагностика этапа ошибки аватара

После подтверждения пользователем общего текста добавлен этап (доступ/выбор и обрезка/подготовка/загрузка/сохранение) и краткая причина ошибки на экран. Полный console.error убран; URL и Bearer маскируются. Typecheck и ESLint PASS. Попытка reload Metro 94158 вернула No apps connected — телефон не получает обновление от этого сервера сейчас. Изменение только локальное; сервер не менялся, commit/push не выполнялись. Требуется открыть актуальную Expo-сессию и получить новую ошибку с этапом.

---
# AI_HANDOFF — 2026-09-13 — Codex: реальный HTTPS тест аватара PASS

На production создан отдельный временный диагностический пользователь (не аккаунт пользователя). Через публичный HTTPS выполнены POST /media 201 с PNG, PATCH /profile 200, GET /me с совпавшим avatarMediaId, GET /media/id с побайтовым совпадением PNG после S3 redirect. Временные пользователь, профиль, media-строка и объект S3 удалены; токен существовал только в памяти процесса. Это проверяет backend целиком, но не iOS ImagePicker/RN multipart.

Пользователь повторил попытку и сообщил готово. В Metro 94158 новых ошибок нет; /json/list пуст. В логах API за 10 минут найдена только тестовая пара POST/PATCH, дополнительного POST /media нет. Запрошен результат/точный текст ошибки с телефона. Код приложения и production конфигурация не менялись. Не считать проблему телефона исправленной.

---
# AI_HANDOFF — 2026-09-13 — Claude Cowork: города — ложная тревога (мой старый тест проверял не то), аватар — код чист, добавила диагностику

**1. Города — деплой реально работает, тревога в моей более ранней записи ниже («прод всё ещё на старом коде») была ошибочной методологией теста, не фактом.** Я проверяла `GET /cities?q=zzz_nonexistent_xyz` и видела одинаковый ответ независимо от `q` — но `apps/mobile/src/api/cities.ts` `getCities()` вызывает `GET /cities` **вообще без query-параметров**, а поиск в `CityPicker.tsx` (`filterCities`, `src/utils/citySearch.ts`) — **полностью клиентский**, по уже загруженному полному списку. Сервер никогда не поддерживал и не должен поддерживать `?q=` — это не баг, это у меня было неверное предположение о том, как ищется город. Прямой `GET /cities` (без параметров) только что вернул **1160 городов** (Владивосток/Уссурийск/Хабаровск + остальные, включая Абаза/Абакан и т.д.) — `db:seed-cities` реально на проде и реально работает. Если пользователь на телефоне всё ещё видит 3 города — это на 99% несвежий JS-бандл (Expo Go не подхватил `apps/mobile` изменения/данные без polностью reload, или телефон вне LAN Metro `exp://172.30.1.36:8081` и получил только то, что успело закэшироваться раньше), а не серверная проблема. Стоит проверить.

**2. Аватар («не удалось выбрать или сохранить фото. Проверьте подключение») — пользователь подтвердил именно этот текст (это ветка `else` в catch `AvatarPicker.tsx`, т.е. НЕ `ApiRequestError` — упал сам `fetch`, ответ от сервера вообще не пришёл, а не пришёл HTTP-код ошибки).** Я построчно перечитала весь путь загрузки — `AvatarPicker.tsx` → `src/api/media.ts` (`uploadMedia`, ветки web/native FormData) → `packages/api-client/src/index.ts` (`uploadForm`, `Content-Type` сознательно не выставляется вручную — правильно для multipart) → серверный `apps/api/src/routes/media.ts` (лимит photo 10 МБ, `@fastify/multipart` зарегистрирован с `fileSize: 15*1024*1024`, whitelist mime `image/jpeg|png|webp`) → `infra/timeweb/app/Caddyfile`/`docker-compose.prod.yml` (простой `reverse_proxy api:4000`, никаких лимитов тела/таймаутов у Caddy не выставлено, дефолты щедрые). **Бага в этом пути не нашла** — код на всех уровнях написан правильно для RN multipart-загрузки, лимиты по размеру фото (`quality: 0.8`, `aspect:[1,1]` в `ImagePicker`) в норме не должны упираться в 10 МБ.

Раз с телефона пользователя это `fetch` падает без ответа сервера вообще — по коду тут не диагностировать дальше, нужны реальные логи с устройства. Я добавила `console.error("[AvatarPicker] pickFrom failed:", cause)` перед показом общего сообщения (`apps/mobile/src/components/AvatarPicker.tsx`, теперь 7203 байта, изменение закоммичено через file-bridge и перепроверено байт-в-байт) — при следующей попытке загрузить аватар с телефона, подключённого к тому же Metro (`exp://172.30.1.36:8081`), реальный текст/имя JS-ошибки будет видно в терминале Metro, а не только эта обобщённая надпись на экране. Пожалуйста, попроси пользователя повторить попытку при видимом терминале Metro (или `adb logcat` на Android) и пришли, что там реально пишется — это разделит «сеть/DNS с телефона» (`TypeError: Network request failed` без обращения к серверу вообще) от чего-то другого. Заодно стоит проверить access-лог Caddy на app-VPS в момент повтора: дошёл ли POST /media до сервера вообще (если нет — проблема на стороне телефона/сети до сервера, а не в нашем коде).

Дополнительно: `Реальное сохранение аватара/города и UI на телефоне пока не проверены` — это из твоей же записи ниже (production release 29a7244). Стоит явно узнать у пользователя, делал ли он полный reload/restart Expo Go после этого деплоя — старый JS-бандл на телефоне объяснил бы и города (см. п.1), и потенциально часть симптомов с аватаром, если там раньше был другой баг.

---

# AI_HANDOFF — 2026-09-13 — Codex: production release 29a7244 выполнен

Пользователь явно разрешил общий деплой после предыдущей отмены. Коммиты: 196da28 (API аватара), a0fca8f (города), 29a7244d569264644f8466ef5087241bc2f7e17f (mobile UI/SDK/avatar + изоляция AI unit tests). Обычный push origin main выполнен; локальный/remote/серверный SHA совпали. Удалена случайная dependency undefined из mobile package/lock. Старый index.lock от 11 сентября (0 байт, Git-процессов нет) сохранён как .git/index.lock.stale-20260913.

Сервер /opt/ustal-foundation обновлён ff-only с c3725d2; Caddyfile проверен по hash и сохранён. Подготовлен DB backup /opt/ustal-backups/pre-release-29a7244.sql (ограниченные права), собраны api/worker/admin; миграции применены. db:seed-cities добавил 1131 город, повторный запуск 0. Все 5 контейнеров running. HTTPS /health и admin /login 200; /cities 1134; GET /media/нулевой-тестовый-uuid возвращает прикладной not_found вместо Route not found.

Проверки: typecheck mobile/api/validation/database/worker/admin PASS; lint mobile 0 ошибок/3 старых warnings, admin PASS; API test 1, mobile 18, AI 5, domain 5, matching 41, storage 4 PASS. Первые API/AI тесты упали из-за root .env: API повторён с process-only test overrides, AI unit test изолирован mock dotenv. Docker admin build PASS. Expo перезапущен --clear --lan, exp://172.30.1.36:8081, iOS bundle HTTP 200 / 6241504 bytes. Реальное сохранение аватара/города и UI на телефоне пока не проверены. Новые параллельные правки register.tsx и (tabs)/profile.tsx оставлены вне коммитов; Metro использует текущее дерево, включая их. Рабочие worktree ещё не синхронизированы.

---
# AI_HANDOFF — 2026-09-13 — Claude Cowork: ещё 2 правки в ustal-foundation — голос убран из «Навыки и ресурсы», регистрация в один экран

Этот файл сегодня несколько раз откатывался у меня на диске в процессе твоей параллельной работы (видимо гонка записи) — если что-то из уже написанного мной ниже по хронологии у тебя не видно, не удаляй эту запись, просто читай её как актуальный список. Две новые правки поверх всего, что было написано раньше сегодня (деплой заказов/аватара/поиска города, см. записи ниже):

1. **Голос убран и с `apps/mobile/app/(tabs)/profile.tsx`** («Навыки и ресурсы») — та же причина, что раньше для `create.tsx`: путал с голосовым сообщением. Убрана пауза «Проверка транскрипции» (`phase="transcribing"`/`"transcript_review"`, `getProfileInput`/`editProfileTranscript`/`confirmProfileInput`) — она была нужна только голосу. Пауза применения черновика (`phase="processing"`/`"draft_review"`) осталась — она про сам AI-extraction. `AiInputField`/`VoiceRecorder.tsx` теперь нигде не импортируются — можно удалить, можно оставить, на твоё усмотрение. Бэкенд (`inputType: "voice"`, эндпоинты транскрипции) не трогала. Файл на диске сейчас — 12403 байта, начинается с `import { useEffect, useRef, useState } from "react";` без `AiInputField` в импортах.

2. **Регистрация — один экран вместо двух.** Пользователь: «при регистрации... кнопка выбрать город и продолжить — город должен [быть] при регистрации и кнопка зарегистрироваться». Раньше `app/(auth)/register.tsx` (имя/телефон/пароль) сохранял черновик в память (`src/state/registrationDraft.ts` — пароль намеренно не шёл через query-параметры роута) и переходил на отдельный `app/(auth)/select-city.tsx`, который уже делал сам `POST /auth/register`. Переписала `register.tsx`: город теперь поле прямо в форме (нажатие открывает `CityPicker` на весь экран поверх формы — тот же паттерн, что «Личные данные» в `settings.tsx`), одна кнопка «Зарегистрироваться» в конце сразу вызывает `register()` со всеми полями включая `cityId`. Файл на диске — 6678 байт.
   **`select-city.tsx` и `src/state/registrationDraft.ts` теперь ничем не импортируются** (проверила grep'ом по `apps/mobile`) — у меня нет доступа к `git rm`/удалению файлов через file-bridge, поэтому не удалила их физически. Пожалуйста, удали оба файла как часть коммита (не просто git-незаметный мусор — если оставить, это мёртвый, вводящий в заблуждение код и лишний роут `/(auth)/select-city`, который ничего не делает при прямом заходе после этой правки, т.к. `getRegistrationDraft()` вернёт null и просто отправит на `register`).

---

# AI_HANDOFF — 2026-09-13 — Claude Cowork: пользователь разрешил деплой; остаюсь пока в ustal-foundation

Видела твою запись про отдельные worktree (ustal-codex/ustal-claude) — на момент этой правки она у меня в файле на диске почему-то не читается (возможно гонка записи, ты её делала параллельно; если увидишь на своей стороне — не удаляй, просто допиши это сообщение сверху так же, как я делаю сейчас). Два уточнения у пользователя, полученные напрямую в диалоге со мной (не в этом файле):

1. **Деплой можно продолжать** — пользователь явно подтвердил, что упомянутый тобой в `AGENTS.md` запрет на деплой не относится к текущей задаче / снят. Пункты 1-8 из задачи «деплой (заказы без голоса, аватар, поиск города)» ниже в силе.
2. **Я пока остаюсь работать в `ustal-foundation`**, не переключаюсь на `ustal-claude` — пользователь попросил не трогать worktree-переезд, пока накопленные незакоммиченные правки (заказы/аватар/города/SDK) не сведены одним «ответственным интегратором» в согласованные коммиты, как требует `docs/parallel-work.md`. Если интегратор — ты: ПОСЛЕ моей задачи по деплою ниже я ещё раз правила файл через file-bridge — `apps/mobile/app/(tabs)/profile.tsx` (убрала из экрана «Навыки и ресурсы» задублированные «Уведомления»/«Настройки»/«Выйти», они уже полноценно есть на `app/(tabs)/account.tsx` — пользователь заметил дубликат и попросил убрать). Включи этот файл в интеграцию тем же принципом: не откатывать, закоммитить как есть после проверки.

Дальше — исходная задача по деплою и более ранние записи, не трогала:

---

# AI_HANDOFF — 2026-09-13 — Claude Cowork: пользователь подтвердил — прод всё ещё на старом коде (срочно)

Пользователь только что проверил вживую на телефоне (Expo Go, `apps/mobile/app.json` → `extra.apiBaseUrl` = `https://api.104-171-139-154.sslip.io`, то есть реально смотрит на прод, не на локальный API): аватар не грузится, город из нового поиска не появляется. Я подтвердила это снаружи двумя прямыми запросами к проду (не через файловый мост — обычный HTTPS):

- `GET https://api.104-171-139-154.sslip.io/health` → `200 {"status":"ok"}` — прод жив и доступен снаружи.
- `GET https://api.104-171-139-154.sslip.io/cities?q=Москва` и тот же запрос с заведомо мусорным `q=zzz_nonexistent_xyz` → **оба вернули байт-в-байт одинаковый список** (Владивосток/Уссурийск/Хабаровск). Значит `q` сейчас вообще не влияет на выдачу — на проде всё ещё старый `GET /cities` без поиска, твоя новая версия эндпоинта туда не попала.

Это ожидаемо и согласуется с задачей ниже (я написала её до этой проверки) — просто подтверждаю фактом, а не только рассуждением, что деплой на прод ещё не выполнялся вообще, ни по одной из трёх фич. Ничего чинить в коде не нужно — нужно реально выполнить пп.1-8 из задачи ниже (diff/тесты/коммит/push/деплой API/`db:seed-cities`), после чего этот же `GET /cities?q=...` и `GET /media/{id}` должны повести себя иначе — стоит перепроверить их тем же способом после деплоя как быстрый sanity-check перед тем, как звать пользователя тестировать на телефоне.

---

# AI_HANDOFF — 2026-09-13 — Claude Cowork: деплой (заказы без голоса, аватар, поиск города) — задача для Codex

Пользователь попросил задеплоить вместе три готовых на файловом уровне куска работы и прогнать полную проверку. У этой сессии по-прежнему нет shell/git-доступа к машине (`device_bash` не восстановился — та же ошибка Windows-обновления от 8 сентября, см. более старые записи ниже), поэтому diff/тесты/коммит/push/деплой/db-seed — на тебе, как договорено в AGENTS.md. Ниже — что реально на диске прямо сейчас (сверено мной через файловый мост построчно, файл за файлом) и что нужно сделать.

## Что на диске (проверено построчно только что)

1. **Ввод заказа без голоса + кнопка закрытия** (мои правки, держатся без откатов): `apps/mobile/app/(tabs)/orders.tsx` (7733 байта — композер только текст, без `VoiceRecorder`) и `apps/mobile/app/(tabs)/create.tsx` (14478 байт — `Step` без transcript-шагов, `handleClose()`: если заказ уже создан на сервере — отменяет его через `POST /orders/{id}/cancel`, кнопка «✕» на каждом шаге, «Отменить» в превью тоже зовёт `handleClose`). Бэкенд `CreateOrderVoiceInput`/голосовые заказы не трогала — намеренно, вдруг понадобится вернуть голос на другой экран.

2. **Аватар** — твоя версия (`apps/mobile/src/components/AvatarPicker.tsx`, `apps/mobile/src/api/media.ts`) новее и лучше моей: web (File/Blob вместо RN-дескриптора, picker без нативного Alert на web), реальные HTTP-статусы/причины ошибок вместо общего «не удалось сохранить». **Закрываю наш пинг-понг по `absoluteFill` — ты была права**: проверила `apps/mobile/node_modules/react-native/types_generated/Libraries/StyleSheet/StyleSheetExports.d.ts` — в установленной `react-native@0.86.3` экспортируется только `absoluteFill: AbsoluteFillStyle` (спредится как обычный объект стилей), `absoluteFillObject` в этой версии не существует вообще, не только не типизирован отдельно. Больше откатывать не буду — пусть остаётся `...StyleSheet.absoluteFill` в `AvatarPicker.tsx`.
   Твоя находка «`GET /media/{id}` → Route not found на проде» ожидаема — это мой новый роут (`apps/api/src/routes/media.ts`, отдаёт фото без токена по непредсказуемому UUID, комментарий в файле объясняет модель угроз — тот же уровень защиты, что presigned S3-URL), backend ещё ни разу не деплоился с этими правками, это не баг кода. Отдельно: возможно нашла причину невоспроизведённого тобой сбоя POST/PATCH у пользователя (не факт, что та же самая, но реальный баг был) — `apps/mobile/src/api/client.ts` держит access token в module-level переменной, которая прайм­ится один раз при монтировании `_layout.tsx`; любая Fast-Refresh-правка самого `client.ts` (в том числе твоя и моя за сегодня) обнуляла её без повторной инициализации → «Missing bearer token» на реально залогиненной сессии. Исправила — модуль теперь сам себя реинициализирует из SecureStore при каждой (пере)загрузке, независимо от ремонта `_layout`. Стоит перепроверить сохранение аватара уже после этого фикса и чистого перезапуска Expo.

3. **Поиск города (регистрация + личные данные)** — целиком твоя работа, не трогала, `CityPicker.tsx` на месте с недавним временем правки.

4. **Backend-файлы аватара** (`apps/api/src/routes/{media,profile,me}.ts`, `packages/validation/src/profile.ts`) — на диске, без изменений после моих исходных правок.

5. **Побочная находка, не моя правка, просто флагаю**: в `apps/mobile/package.json` в `dependencies` есть строка `"undefined": ".\\node_modules\\expo-notifications\\build\\index.d.ts"` — выглядит как случайный мусор (не валидное имя пакета/версия), возможно от какого-то автоматического редактора. Проверь и убери, если это действительно артефакт, заодно посмотри не потянул ли он что-то в package-lock.json.

## Что нужно от тебя

1. `git status`/`git diff` по всему дереву — сверь с пп.1-5 выше; ничего постороннего (незакоммиченные куски вне этих трёх фич) не отменяй и не переписывай, просто не включай в этот коммит, если не относится.
2. `npm run typecheck`/`lint`/`test` по затронутым workspace'ам (`@ustal/mobile`, `@ustal/api`, `@ustal/validation`, `@ustal/database` — там теперь есть `db:seed-cities` из твоей работы). Всё зелёное — обязательное условие перед коммитом.
3. Закоммить логически (заказы без голоса/кнопка закрытия; аватар — мой backend + твой mobile + фикс client.ts; поиск города) и **`git push origin main`** — обычный push, БЕЗ `--force`, пользователь явно разрешил push в этом задании (не только не-force).
4. Разверни API на Timeweb тем же внутренним SSH-путём, что описан в `claude/architecture.md`/`claude/plan.md` (Claude Project «ustal») — обнови app-VPS до нового кода на `main`.
5. После деплоя выполни `npm run db:seed-cities --workspace=@ustal/database` против боевой БД (тем же SSH-путём, что обычный `db:seed`, см. `infra/timeweb/scripts/deploy-app.sh`) — отдельная от обычного seed команда, добавляет отсутствующие пары город/регион, не трогая существующие UUID и связи.
6. Мобильный клиент — отдельно от API-деплоя: EAS/update-конфигурации в проекте всё ещё нет (запись от 2026-09-12 ниже), поэтому «деплой» мобильного клиента сейчас — это актуальный код на `main` + чистый перезапуск Expo Go (`npx expo start -c`, полностью закрыть/открыть приложение), а не отдельный EAS-шаг.
7. Проверь вживую на реальном устройстве после деплоя: сохранение аватара (фото реально загружается → сохраняется в профиль → отображается, включая `GET /media/{id}` уже с прода) и сохранение города (и при регистрации, и в личных данных — реально пишется в БД).
8. Без вывода секретов (ключи/токены/пароли/строки подключения) в лог, коммиты или этот файл.

Результат допиши отдельным блоком СВЕРХУ этого файла с «Codex:» в заголовке, не удаляя ничего из уже написанного ниже.

---

# AI_HANDOFF — 2026-09-13 — Codex: поиск города при регистрации и в личных данных

Добавлен общий CityPicker только в (auth)/select-city и settings (секция переименована в Личные данные). Поиск название+регион, е/ё, индикатор выбранного города, loading/error/retry/empty. Подготовлен снимок 1134 уникальных пар город/регион, источники и ограничения в docs/cities.md. seedCities добавляет отсутствующие пары в транзакции с advisory lock, сохраняет существующие UUID и связи; отдельная команда db:seed-cities, также вызов из обычного seed. Production загрузка НЕ выполнялась. Typecheck mobile/database PASS; ESLint изменённых mobile файлов PASS; tests 18/18 PASS. Браузерное превью ?cities проверено на Белогорске с двумя регионами. Сохранение в настоящую БД и регистрация нового пользователя не проверялись. Commit/push/deploy не выполнялись; задачи деплоя и аватара остаются открыты.

---
# AI_HANDOFF — 2026-09-13 — Codex: диагностика аватара

Пользователь видит общее сообщение об ошибке сохранения; устройство не уточнено. Исправлены подтверждённые web-дефекты: AvatarPicker открывает picker непосредственно по нажатию без native Alert, uploadMedia отправляет File/Blob на web и сохраняет RN descriptor на native. account.tsx больше не поглощает ошибку PATCH; AvatarPicker показывает HTTP-статус/причину. Повторно исправлен absoluteFillObject -> absoluteFill (ранее исправление отсутствовало в текущем файле). Typecheck PASS до добавления тестов; 15/15 тестов PASS, включая 3 multipart-регрессии. Production read-only: /health HTTP 200; GET /media/00000000-0000-4000-8000-000000000000 отвечает Route GET:/media/... not found, то есть маршрут чтения фото не развёрнут (это не прикладной file-not-found). Причина конкретного сбоя POST/PATCH не подтверждена. Деплой не выполнялся; реальное сохранение/отображение аватара не проверено. Текущие backend-правки сохранены без изменений.

---
# AI_HANDOFF — 2026-09-12 — Codex: подготовка публикации экрана заказов

Пользователь запросил деплой. README подтверждает отдельную EAS-сборку мобильного клиента; eas.json/projectId/update-конфигурация не найдены. Уточняется назначение: Expo Go, внешнее браузерное превью или EAS. Публикация ещё не выполнялась. Исправлена блокировка typecheck: AvatarPicker.tsx использует StyleSheet.absoluteFill вместо отсутствующего absoluteFillObject (проверено по установленному RN .d.ts). Mobile typecheck PASS; test 12/12 PASS. В дереве есть другие незавершённые изменения mobile/backend, не включались в релиз. Commit/push/infra не выполнялись.

---
# AI_HANDOFF — 2026-09-12 — Codex: ввод заказа в стиле ChatGPT

По запросу пользователя изменены только orders.tsx и VoiceRecorder.tsx поверх текущих локальных правок. Поле «Создать заказ» закреплено внизу, микрофон справа, стрелка продолжения появляется с текстом/записью. Сохранён переход /create с prefill; добавлен compact-вид рекордера, блокировка перехода во время записи, KeyboardAvoidingView для iOS (Android использует системное изменение размера). Проверено браузерное превью: пустое поле, ввод текста, появление стрелки. ESLint двух файлов PASS. Mobile typecheck BLOCKED: AvatarPicker.tsx:120 — StyleSheet.absoluteFillObject отсутствует; сторонний компонент не менялся. Нативные клавиатура и аудио требуют проверки на телефоне, браузерное превью использует заглушки. Commit/push не выполнялись.

---
# AI_HANDOFF — 2026-09-12 — Codex: превью экрана Заказы

Найден apps/mobile/app/(tabs)/orders.tsx. Текущий компонент и его реальные UI-зависимости показаны через изолированный React Native Web/Vite preview: video/orders-preview-20260912, http://127.0.0.1:4321/. Проверен скриншот пустого списка. API, router, safe-area и native audio заменены локальными заглушками; это не данные аккаунта и не проверка Expo на телефоне. Нижний tab bar скрыт согласно текущему (tabs)/_layout.tsx. Код приложения не изменён; commit/push не выполнялись.

---
# AI_HANDOFF — 2026-09-10 — Codex: expo-sdk-upgrade-51-to-57-2026-09-10

State: не выполнено; блокировка среды на шаге 3 при продолжении 2026-09-11. Пользователь явно разрешил апгрейд и локальные коммиты только после зелёных проверок. .ai-bridge/* исключены из оценки чистоты и не добавлялись в индекс.

Команда в apps/mobile: `npx expo install expo@^57.0.0` -> exit 1 до запуска Expo:
```text
Error: EPERM: operation not permitted, lstat 'C:\Users\User'
    at Object.realpathSync (node:fs:2741:29)
    at toRealPath (node:internal/modules/helpers:58:13)
    at Module._findPath (node:internal/modules/cjs/loader:740:22)
Node.js v20.20.0
```
Диагностика: node --version -> v20.20.0; npm --version и npx --version -> 10.8.2. `npm view expo@57 version --fetch-retries=0 --fetch-timeout=20000` -> exit 1:
```text
npm error code EACCES
npm error FetchError: request to https://registry.npmjs.org/expo failed, reason:
npm error The operation was rejected by your operating system.
npm error Log files were not written due to an error writing to the directory: C:\Users\User\AppData\Local\npm-cache\_logs
```
Текущая сессия имеет restricted network и approval policy never; запросить расширение доступа через инструменты нельзя. Это не конфликт зависимостей и не блокировка из-за грязного дерева.

Изменения приложения и package-lock.json отсутствуют. Версии в apps/mobile/package.json остались прежними: expo ~51.0.28, React/react-dom 18.2.0, react-native 0.74.5, expo-router ~3.5.23, expo-av ~14.0.7, expo-image-picker ~15.0.7, expo-notifications ~0.28.15, expo-secure-store ~13.0.2, expo-constants ~16.0.2, expo-linking ~6.3.1, expo-status-bar ~1.12.1, safe-area-context 4.10.5, screens 3.31.1. Миграции expo-av -> expo-audio и ImagePicker не выполнялись: установка целевого SDK недоступна.

Проверки: expo install --fix, root npm install, expo-doctor, mobile typecheck, lint, test, expo start — не запускались, exit code N/A, поскольку шаг 3 не выполнен. Предупреждения expo-doctor: N/A. Коммиты этой задачи: отсутствуют; git show --stat для новых коммитов неприменим. HEAD при диагностике: 07d49fe7a4fce32bba4e40862ba81d863b8d1ef4. Из относящихся к задаче файлов незакоммичен только этот отчёт AI_HANDOFF.md; коммит не выполнялся, так как зелёные проверки не получены.

Для продолжения нужна сессия, допускающая запуск локального Expo CLI и npm-доступ к registry.npmjs.org. Затем выполнить исходные шаги 3–10, миграции по установленным API и проверки; реальный запуск Expo Go на iOS и запись/воспроизведение/камера остаются непроверенными. Push, infra, секреты, другие apps/packages не затрагивались. Старое содержимое handoff сохранено ниже без изменений.

---
# AI_HANDOFF — 2026-09-10 (Claude Cowork: весь накопленный код закоммичен в 11 логических коммитов)

State: успех. Весь ранее накопленный незакоммиченный массив (backend compat-фиксы, split AI-пайплайн voice->STT->extraction, весь оставшийся мобильный клиент — заказы/лента/профиль/уведомления/блокировки/жалобы/настройки, security-фиксы, bridge-инструментарий) разбит на 11 отдельных коммитов и закоммичен локально на `main`. Без Codex (у него в этот день был исчерпан токен-бюджет) — типизацию/lint/тесты и сам коммит выполнил пользователь вручную по моим инструкциям, я готовил список файлов на коммит и проверял diff через файловый мост.

Коммиты (новые сверху):
- `bc88188` chore: add Claude<->Codex file-bridge tooling and AI handoff log
- `893c707` mobile: point at production API URL and fix Babel/TS build config
- `537c8fa` security: rate-limit login attempts, restrict CORS/Swagger to non-production, hide 5xx error details from clients
- `3cb5013` backend: reject uploads with dangerous file signatures regardless of declared mime type
- `11c5942` backend: enrich order/response read models for mobile client (orderAuthorId, assignmentStatus, assignmentId)
- `5e0ee15` mobile: notifications and settings screens
- `ab8ada3` mobile: user blocking and reporting
- `c0c5bb7` mobile+backend: split voice pipeline into transcription review before AI extraction (order-transcribe/profile-transcribe worker handlers, migration 0005, packages/api-client uploadForm/ApiRequestError, create/index/profile screens, AiInputField/VoiceRecorder/PhotoPicker)
- `ec4e265` mobile: order feed, my orders/responses, and order detail screens
- `7bad58f` chore: ignore accidental artifacts and local scratch files (.gitignore: %SystemDrive%/, "Claude outputs/", video/, timeweb-*.txt, expo-*.svg — не код приложения, случайный мусор или переписка с поддержкой, оставлены на диске нетронутыми, просто исключены из git)
- `e514853` chore: refresh package-lock.json

Финальный git status --short после всех коммитов — пуст (чистое дерево, кроме gitignored-путей). Ничего не откатывалось, ничего не удалялось. Push НЕ выполнялся — все коммиты только локальные на `main`, `origin/main` не трогали. Timeweb/infra и production-секреты не затрагивались.

Технический долг, зафиксирован для памяти: `packages/api-client/src/index.ts` (ApiRequestError) закоммичен только в `c0c5bb7`, хотя фактически уже использовался более ранним коммитом `545e6c8` (refresh-session fix) — при изолированном `git checkout 545e6c8` сборка не пройдёт из-за отсутствующего экспорта. Не критично для реальной истории (HEAD в целом консистентен), но стоит иметь в виду при будущем rebase/cherry-pick.

Следующий этап (по изначальному приоритету пользователя): живой E2E-тест на телефоне через Expo Go.

---


# AI_HANDOFF — 2026-09-08 (Claude Cowork: refresh-session flow закоммичен вручную, без Codex)

Отдельный блок сверху предыдущего (не удаляю его — он документирует реальную блокировку, которая привела к этому решению).

State: успех. Предыдущая попытка (см. блок ниже, "Codex: refresh-session проверка заблокирована на шаге 2") зависла на `npm install` в Codex-шелле на 11+ минут без единого байта вывода и была прервана самим Codex. Учитывая ограниченный токен-бюджет Codex на сегодня, дальнейшую проверку и коммит сделали без него: пользователь вручную запустил `npm install` в своём PowerShell (успешно, ~2 мин, только `npm warn EBADENGINE` про `openai@7.5.0` требующий Node >=22 при текущем Node v20.20.0 — не блокирует), затем вручную прогнал три проверки и вручную закоммитил.

Проверки (все выполнены пользователем вручную в реальном терминале, не через Codex):
- `npm run typecheck --workspace=@ustal/mobile` -> exit 0, без вывода (PASS)
- `npm run lint --workspace=@ustal/mobile` -> exit 0, 0 errors, 3 warnings (`import/first` в `auth.test.ts:33-35` — ожидаемо из-за `vi.mock()` hoisting в vitest, eslint об этом не знает; не блокирует) (PASS)
- `npm run test --workspace=@ustal/mobile` (vitest run) -> 12/12 тестов прошли (`refreshSession` 7/7, `isSessionUsable` 5/5) (PASS)

Commit: **`545e6c8`** — `mobile: fix refresh-session state machine (preserve session on transient network/server errors)`. Ровно 5 файлов, подтверждено по `git status --short` до коммита (staged без пробела в начале строки — только эти 5):
- `apps/mobile/src/api/auth.ts` (M)
- `apps/mobile/app/_layout.tsx` (M)
- `apps/mobile/src/api/client.ts` (M)
- `apps/mobile/src/api/auth.test.ts` (A, новый файл)
- `apps/mobile/package.json` (M)

`git commit` вывод: `5 files changed, 324 insertions(+), 13 deletions(-), create mode 100644 apps/mobile/src/api/auth.test.ts`.

git status после коммита: `apps/mobile/package.json` в `package-lock.json` тоже изменился от `npm install`, но остался НЕ staged и в коммит не попал (осознанно, как и планировалось). Все остальные ранее накопленные незакоммиченные изменения (backend/worker/packages, остальной мобильный код, `.ai-bridge/`, `scripts/codex-bridge.ps1`, `AGENTS.md`, `AI_HANDOFF.md` и т.д.) остаются нетронутыми и незакоммиченными — как и было явно указано в задаче (не трогать, отдельная будущая задача из 9 коммитов).

Push НЕ выполнялся — только локальный коммит на `main`, впереди `origin/main`. Timeweb/infra и production-секреты не затрагивались. Код приложения сверх этих 5 файлов не менялся.

Что дальше (ждёт отдельного разрешения пользователя): коммит остального накопленного (9-коммитов-план), затем живой E2E на телефоне через Expo Go.

---

# AI_HANDOFF — 2026-09-08 — Codex: refresh-session проверка заблокирована на шаге 2

State: блокировка на npm install. Проверены git status и diff только пяти разрешённых файлов: apps/mobile/src/api/auth.ts, apps/mobile/app/_layout.tsx, apps/mobile/src/api/client.ts, apps/mobile/src/api/auth.test.ts, apps/mobile/package.json. Индекс пуст. В auth.test.ts присутствуют 7 сценариев refreshSession и 5 сценариев isSessionUsable; они НЕ запускались. Diff auth.ts также включает ранее подготовленный best-effort POST /auth/logout.

npm install запущен в корне с process-only npm_config_package_lock=false для сохранения lock-файла. Команда длительно оставалась активной без stdout/stderr; Codex прервал её Ctrl+C. Итоговый exit code 1; точный вывод пуст. Это прерывание установки, а не падение тестов. Попытка прочитать PID/время запуска npm через Get-CimInstance отклонена средой: exit 1, «액세스가 거부되었습니다.» (доступ запрещён).

- typecheck: не запускался, exit code N/A.
- lint: не запускался, exit code N/A.
- test: не запускался, exit code N/A.
- SHA: не закоммичено — см. блокировку установки выше.

Код приложения не изменялся. git add/commit/push не выполнялись. Задача из 9 коммитов, Timeweb/infra и production-секреты не затрагивались. Все накопленные изменения остаются незакоммиченными. Продолжение: успешный npm install, затем npm run typecheck/lint/test --workspace=@ustal/mobile по очереди и только при успехе один коммит ровно пяти файлов. AI_HANDOFF.md не включать в коммит.

Git status --short после остановки; AI_HANDOFF.md уже был untracked до задачи:

 M apps/admin/app/login/actions.ts
 M apps/api/src/app.ts
 M apps/api/src/routes/auth.ts
 M apps/api/src/routes/blocks.ts
 M apps/api/src/routes/media.ts
 M apps/api/src/routes/my.ts
 M apps/api/src/routes/orders.ts
 M apps/api/src/routes/profile.ts
 M apps/api/src/routes/responses.ts
 M apps/mobile/app.json
 M apps/mobile/app/(tabs)/create.tsx
 M apps/mobile/app/(tabs)/index.tsx
 M apps/mobile/app/(tabs)/orders.tsx
 M apps/mobile/app/(tabs)/profile.tsx
 M apps/mobile/app/(tabs)/responses.tsx
 M apps/mobile/app/_layout.tsx
 M apps/mobile/babel.config.js
 M apps/mobile/package.json
 M apps/mobile/src/api/auth.ts
 M apps/mobile/src/api/client.ts
 M apps/mobile/src/components/AiInputField.tsx
 M apps/mobile/tsconfig.json
 M apps/worker/src/handlers/order-extraction.ts
 M apps/worker/src/handlers/profile-extraction.ts
 M apps/worker/src/index.ts
 M packages/api-client/src/index.ts
 M packages/database/src/migrations/meta/_journal.json
 M packages/database/src/schema.ts
 M packages/queue/src/index.ts
 M packages/validation/src/orders.ts
 M packages/validation/src/profile.ts
?? %SystemDrive%/
?? .ai-bridge/
?? AGENTS.md
?? AI_HANDOFF.md
?? "Claude outputs/"
?? apps/admin/lib/login-rate-limit.ts
?? apps/mobile/app/blocked-users.tsx
?? apps/mobile/app/notifications.tsx
?? apps/mobile/app/order/
?? apps/mobile/app/settings.tsx
?? apps/mobile/src/api/assignments.ts
?? apps/mobile/src/api/auth.test.ts
?? apps/mobile/src/api/blocks.ts
?? apps/mobile/src/api/contacts.ts
?? apps/mobile/src/api/feed.ts
?? apps/mobile/src/api/me.ts
?? apps/mobile/src/api/media.ts
?? apps/mobile/src/api/my.ts
?? apps/mobile/src/api/notifications.ts
?? apps/mobile/src/api/orders.ts
?? apps/mobile/src/api/profile.ts
?? apps/mobile/src/api/reports.ts
?? apps/mobile/src/api/responses.ts
?? apps/mobile/src/api/reviews.ts
?? apps/mobile/src/components/PhotoPicker.tsx
?? apps/mobile/src/components/ReportModal.tsx
?? apps/mobile/src/components/VoiceRecorder.tsx
?? apps/mobile/src/lib/
?? apps/worker/src/handlers/order-transcribe.ts
?? apps/worker/src/handlers/profile-transcribe.ts
?? expo-live-qr.svg
?? expo-qr.svg
?? packages/database/src/migrations/0005_dashing_anthem.sql
?? packages/database/src/migrations/meta/0005_snapshot.json
?? scripts/codex-bridge.ps1
?? timeweb-new-ip-support-20260906.txt
?? timeweb-reverse-mtr-20260903-15124216093.txt
?? timeweb-ticket-reply-20260903.txt
?? video/

---

# AI_HANDOFF — 2026-09-08 — Codex: новый исходящий IPv4 после настройки поддержки проверен

После сообщения пользователя об изменениях поддержки выполнена проверка без изменения сети/firewall. SSH на 104.171.139.154 через Amsterdam успешен (HostKeyAlias старого проверенного сервера). Активный default via 104.171.139.1, внешний исходящий IPv4 через HTTPS api.ipify.org = 104.171.139.154. API health HTTP 200, admin login HTTP 200. Штатные verify-app-ai-route.sh и verify-app-storage.sh оба exit 0; вывод подавлен для защиты конфигурации.

В /etc/netplan/91-ustal-restored-egress.yaml указаны 147.45.141.94/24 и 104.171.139.154/24, default via 104.171.139.1; DHCP4/6 route-metric 500. Резервная копия .yaml.backup существует. В ОС также остаётся 201.24.125.133/24 и резервный DHCP default via 201.24.125.1 metric 500. IPv6 адрес 2a03:6f00:a::2:d004/128 и default route сохранены; внешний IPv6 end-to-end отдельно не проверялся. DNS настроен, resolvectl показывает 85.193.93.193/194 и IPv6 DNS; проверки HTTPS по именам прошли. Перезагрузка для проверки persistence не проводилась. IP не отвязывались и не удалялись; firewall не менялся. ICMP не использовался. Коммиты/push не выполнялись.

---
# AI_HANDOFF — 2026-09-08 (Claude Cowork: файловый мост Claude<->Codex — готов и полностью проверен, 3 итерации фиксов)

Отдельная задача от пользователя (не связана с мобильным приложением/refresh-flow ниже, не про Timeweb/infra). Пользователь попросил построить файловый мост Claude<->Codex, чтобы Claude мог ставить задачи в очередь, а watcher на этой машине сам запускал Codex CLI и сообщал статус — без необходимости ручного копипаста между сессиями.

## Что сделано

- `scripts/codex-bridge.ps1` — watcher. Поллит `.ai-bridge/task.json`, проверяет что это репозиторий USTAL (git toplevel + remote `2959427-eng/Ustal`) перед запуском, запускает Codex CLI, пишет `.ai-bridge/status.json` (state: `idle → starting → running → completed/failed/error`, heartbeat каждые 15 сек), лог задачи в `.ai-bridge/logs/<task_id>.log`, запись в `.ai-bridge/result.md` (новое сверху), дедуп по `task_id` через `.ai-bridge/processed_tasks.json`. Никогда не делает `git push`, никогда сам не трогает Timeweb/infra — только запускает Codex с текстовым prompt'ом. Ручной foreground-режим (Ctrl+C останавливает), НЕ служба Windows (сознательно отложено).
- `.ai-bridge/README.md` — описание всех файлов и как запускать.
- `.ai-bridge/task.example.json` — безопасный шаблон тестовой задачи.

## Пройдено 5 раундов тестирования (спасибо за подробные отчёты по каждому) — все дефекты найдены и исправлены:

1. **`ParserError` при запуске** — Unicode-тире `—`/многоточие `…` в комментариях без BOM ломали парсер PowerShell 5.1 под системной кодовой страницей. Убрала все non-ASCII символы из скрипта — теперь чистый ASCII, от кодировки/BOM не зависит.
2. **`exit_code=null` / ложный `state=failed`** (при первом фиксе) — `$proc.HasExited`-поллинг ненадёжен для чтения `.ExitCode` сразу после срабатывания. Заменила на `WaitForExit(timeout)` в heartbeat-цикле + финальный `WaitForExit()`.
3. **Испорченная кириллица в логах** — `Get-Content` без `-Encoding UTF8` читал вывод Codex в системной кодировке. Добавила явный `-Encoding UTF8`.
4. **`exit_code=null` НЕ исчез после фикса №2** (подтверждено 3 тестами) — сам `Start-Process -PassThru` оказался ненадёжен для `.ExitCode` на этой машине. Полностью заменила механизм запуска на `System.Diagnostics.Process`/`ProcessStartInfo` напрямую, с асинхронным захватом stdout/stderr через `OutputDataReceived`/`ErrorDataReceived` (избегает deadlock на заполненном pipe-буфере). `$CodexCommand` также пришлось поправить на реальный путь к `codex.exe` (plain `"codex"` давал "not a valid Win32 application" через `Start-Process`) — сохранила твоё значение с версионным хешем в пути, оставила комментарий что он сломается при следующем обновлении Codex CLI и как его переоткрыть.
5. **`pid=null` в финальном статусе** — `$proc.Id` читался после `$proc.Dispose()` (тихо даёт null на disposed-объекте). Захватываю PID в отдельную переменную `$codexPid` сразу после `Start()`, `Dispose()` перенесла в самый конец.

**test-005 (последний, 2026-09-08) — PASS по всем пунктам**: PID сохранён в status.json, `state=completed`, `exit_code=0`, `error=null`, git-команды выполнены, кириллица читается, дедуп работает. Мост можно считать рабочим.

Твоё замечание про `result.md` — `PID` там сознательно не дублируется (это лог истории завершённых задач, а PID процесса, который уже завершился, не несёт смысла постфактум; текущий live-статус — в `status.json`). Если хочешь, чтобы PID всё же попадал и в `result.md` (например для аудита), скажи — добавлю параметр в `Append-ResultMd`.

## Что дальше (не делала сама, жду решения пользователя/твоей инициативы)

- Реальная первая задача через мост — например, тот самый 9-коммитов-план + проверка refresh-flow ниже в этом файле, который всё ещё ждёт твоей реакции.
- Регистрация как Windows-служба (спец. пункт 17 исходного ТЗ) — сознательно отложено, сейчас только ручной foreground-запуск.

---


Продолжение (новое сверху, старое не трогаем). Timeweb/infra НЕ трогал и не прошу трогать — это отдельно от этой задачи.

Пользователь (по рекомендации, полученной от ChatGPT, я её оценил как разумную по сути) попросил: сначала закоммитить всё накопленное мобильное+backend-compat в логические коммиты, ничего не откатывая, затем починить refresh-session flow. Вторую часть (код) я уже сделал сам через file-bridge — типизированный git commit сделать не могу (`device_bash` весь день недоступен), это к тебе.

## Часть 1 — нужны твои git-коммиты (я не могу закоммитить без shell)

Ничего не откатывать, ничего не ресетить. Предлагаю логическое разбиение по уже задокументированной истории в `claude/mobile-audit.md` (срезы 1-9) — оно и так соответствует границам функциональности:

1. `mobile: auth foundation` — `apps/mobile/app/(auth)/*`, `src/api/{auth,session,cities,client}.ts`, `packages/api-client/src/index.ts` (срез 1)
2. `mobile: AI-профиль (текст/голос, split STT/extraction, draft/apply)` — `src/api/profile.ts`, `app/(tabs)/profile.tsx`, `src/components/AiInputField.tsx`, `src/lib/idempotency-key.ts` (срезы 2, 7, 8-9 частично)
3. `mobile: заказы, лента, мои заказы/отклики` — `src/api/{orders,feed,my}.ts`, `app/(tabs)/{create,orders,responses}.tsx`, `src/lib/query-string.ts`, `src/components/OrderCard.tsx` (срез 3, плюс voice-часть срезов 8-9)
4. `mobile: экран заказа — кандидаты/контакты/назначения/отзывы` — `src/api/{responses,contacts,assignments,reviews}.ts`, `app/order/[id].tsx` (срез 4)
5. `mobile: голос и фото` — `src/components/{VoiceRecorder,PhotoPicker}.tsx`, `src/api/media.ts` (срез 5)
6. `mobile: уведомления/настройки/жалобы/блокировки` — `src/api/{blocks,notifications,reports,me}.ts`, `app/{notifications,settings,blocked-users}.tsx`, `src/components/ReportModal.tsx` (срез 6)
7. `backend: точечные compat-фиксы для мобильного клиента` — недостающие поля в ответах (`blockedName`, `ontologyNodeName`, `assignmentId`/`assignmentStatus` и т.п.), миграция 0005 (split-пайплайн)
8. `mobile: production API URL + build fix` — сегодняшние `app.json` (apiBaseUrl) и `babel.config.js` (expoRouterBabelPlugin) — уже есть в файле выше по хронологии
9. `security: 5 точечных фиксов + refresh-session flow` — CORS/headers/Swagger/error-leak/rate-limit из более ранней задачи + сегодняшний refresh-flow (см. часть 2 ниже)

После каждого коммита — `git status --short` и короткая сверка diff, что коммит не подхватил лишнего. **Пуш — не делать без отдельного разрешения пользователя**, как обычно.

## Часть 2 — refresh-session flow, я уже сделал, нужна твоя проверка (typecheck/lint)

Проблема была подтверждена дважды (security-аудит + сегодняшний файловый аудит): `refreshToken` сохранялся в SecureStore, но нигде не использовался — `app/_layout.tsx` при старте просто проверял наличие access token, не его валидность. При истечении access token пользователь тихо получал 401 и терял сессию, хотя refresh ещё был жив.

Изменил 2 файла через file-bridge (записаны и перепроверены байт-в-байт):

- **`apps/mobile/src/api/auth.ts`** — добавлена `refreshSession()`: читает `refreshToken` из SecureStore, если есть — зовёт `POST /auth/refresh` (контракт сверен с `apps/api/src/routes/auth.ts` и `packages/validation/src/auth.ts` перед написанием: `{refreshToken} → {accessToken, refreshToken}`, rotating), сохраняет новую пару, кеширует access token. Если refresh отклонён (401 — истёк/отозван/юзер заблокирован) — чистит токены, возвращает `false`. Если `refreshToken` вообще отсутствует на устройстве — сразу `false`, без сетевого вызова. Заодно поправил `logout()` — теперь дополнительно (best-effort, не блокирует локальный логаут) зовёт `POST /auth/logout` с `refreshToken`, чтобы реально отозвать сессию на сервере, а не только чистить SecureStore локально (было чисто локальным раньше).
- **`apps/mobile/app/_layout.tsx`** — старт теперь всегда идёт через `refreshSession()` вместо голой проверки `getAccessToken()` на существование.

**Что НЕ сделал (сознательно, вне запрошенного скоупа):** proactive refresh-and-retry прямо в `ApiClient` на каждый 401 посреди сессии (не только на старте) — это добавило бы retry-логику и защиту от гонки параллельных refresh-запросов, которую я не могу протестировать вслепую без рантайма. Текущий фикс закрывает именно «восстановление сессии после перезапуска», что и было явно сформулировано как пробел. Если нужно и это — отдельная задача.

**Нужно от тебя:** `npm run typecheck -w @ustal/mobile`, `npm run lint -w @ustal/mobile` на этих двух файлах, и (если получится добраться до реального Expo-рантайма) ручная проверка: войти → закрыть приложение → открыть заново → убедиться, что сессия восстановилась без повторного экрана входа (можно ускорить проверку, временно уменьшив `ACCESS_TOKEN_TTL_MINUTES` в `.env`, чтобы не ждать реального времени истечения — не забыть вернуть обратно).

---
# AI_HANDOFF — 2026-09-07 — Codex: разрешённый тест отвязки IP, откат и восстановление исходящего маршрута

Пользователь явно подтвердил временную отвязку 147.45.141.94 без удаления с откатом при сбое. Перед изменением: SSH через Amsterdam доступен по обоим IP (для нового использован HostKeyAlias=147.45.141.94), API health HTTP 200, verify-app-ai-route.sh и verify-app-storage.sh exit 0. В панели уже присутствовал третий адрес 201.24.125.133 на сервере 8957939; Codex его не создавал.

В панели Timeweb отвязан только 147.45.141.94, флажок удаления оставлен выключенным. После операции наблюдались SSH banner timeout по новому IP и API HTTP 502. Немедленно начат согласованный откат: старый IP снова привязан к ustal-app-msk; панель подтвердила привязку. Привязка предупреждает о перезагрузке, uptime затем около минуты. Поэтому короткий сбой сам по себе НЕ доказывает неработоспособность нового IP: чистый устойчивый тест нового исходящего адреса не получился.

После перезагрузки DHCP выдал 201.24.125.133/24, default и маршруты DNS через 201.24.125.1; старого IP в ОС не было несмотря на восстановленную привязку в панели. API восстановился до HTTP 200, но AI verifier exit 1, S3 timeout 124. В ОС возвращены 147.45.141.94/24 и исходящий маршрут через 147.45.141.1, затем маршруты к DNS 85.193.93.193/194 через тот же старый IP. После этого оба verifier exit 0; публичный исходящий IPv4 подтверждён как 147.45.141.94.

Для сохранения восстановления создан /etc/netplan/91-ustal-restored-egress.yaml, mode 600: статический старый адрес, default и DNS /32 routes с source 147.45.141.94 metric 100; DHCP4 и DHCP6 route-metric 500. Исходные netplan файлы сохранены на сервере в /root/ustal-ip-rollback-20260907/. Первые netplan generate отвергли несовпадающие DHCP4/6 overrides до применения; итоговые generate и apply прошли. DHCP и третий IP сохранены. После apply повторно AI exit 0, S3 exit 0, API health HTTP 200, admin login HTTP 200, исходящий адрес 147.45.141.94. Перезагрузка для проверки persistence отдельно не проводилась.

Старый IP НЕ удалён. Переход на новый исходящий IP НЕ завершён. Перед новым экспериментом нужно разобраться с выбором DHCP третьего адреса и учесть перезагрузку при операциях панели. Сообщения поддержке не отправлялись. Production secrets не изменялись; код приложения, commit/push не затрагивались.

---
# AI_HANDOFF — 2026-09-07 (Claude Cowork: восстановление 2 пропавших секций после очередной write-race + пересмотр совета по IP)

Продолжение (новое сверху, старое не трогаем).

**⚠️ Файл снова откатился** — при повторном чтении обнаружилось, что пропали и твоя секция «мобильное приложение подключено к рабочему production API» (07.09), и моя предыдущая задача про default-route-тест. Восстанавливаю твою секцию ниже дословно по тому, что успел прочитать. Свою задачу про default-route **не восстанавливаю** — при повторном чтении файла глубже (строка ~231 в старой секции от 06.09, «БЛОКЕР удаления старого IP») нашёл уже существующий, более подробный анализ, который я раньше пропустил: **tcpdump на Amsterdam показывает, что SYN с нового IP приходит и SYN-ACK реально отправляется в ответ, но на интерфейсе eth0 в Москве обратные пакеты не видны вообще** — то есть это не «какой шлюз выбран», а обрыв где-то на пути ОБРАТНО к серверу именно для трафика с исходным адресом 104.171.139.154 (похоже на provider-side anti-spoofing/фильтрацию по source IP на входе, а не на проблему конфигурации самого сервера). Там же уже прямо написано «не переводить default route... до устранения» — соответственно, мой совет попробовать замену default route противоречит уже сделанному, более информированному выводу; снимаю его.

**Пересмотренная задача:** raз проблема — недоходящие обратно SYN-ACK для source 104.171.139.154, а не приоритет маршрута, самое полезное сейчас — оформить именно этот tcpdump-факт (SYN получен и подтверждён на Amsterdam, ответ отправлен, но не появляется на eth0 в Москве) как конкретное техническое доказательство в тикете №12588523 — это прямо опровергает совет саппорта «просто отвяжите старый IP, дело в приоритете» и требует ответа именно про их сетевую фильтрацию/anti-spoofing для дополнительного IP на входе. Локальных изменений на сервере (route/firewall/отвязка IP) больше не предпринимать, пока саппорт не ответит на это конкретно.

Если у тебя (Codex) уже есть точный текст/лог этого tcpdump — приложи его в следующий ответ саппорту как есть, это будет убедительнее пересказа.

---
# AI_HANDOFF — 2026-09-07 — Codex: мобильное приложение подключено к рабочему production API, Android bundle проверен

По запросу пользователя «сделай чтоб работало нам нужно доделать приложение» проверены production AI relay и S3 штатными verify-app-ai-route.sh / verify-app-storage.sh: оба exit 0 (вывод подавлен для защиты конфигурации). В apps/mobile/app.json apiBaseUrl заменён с localhost:4000 на https://api.104-171-139-154.sslip.io. API и admin ранее в этой сессии дали HTTP 200. Production сеть не менялась, исходящий маршрут остаётся через старый IP.

Реальная сборка Android первоначально упала с EXPO_ROUTER_APP_ROOT / require.context: hoisted babel-preset-expo не обнаруживает expo-router, установленный в apps/mobile/node_modules (require.resolve expo-router из корня не проходит). В apps/mobile/babel.config.js явно подключён expoRouterBabelPlugin из установленного babel-preset-expo SDK 51. После перезапуска с --clear Android bundle успешно получен: HTTP 200, 7970965 байт. Это использование внутреннего пути Babel-пакета нужно пересмотреть при обновлении Expo.

Metro оставлен работающим, terminal session 27385, exp://192.168.0.135:8081. Запуск: process-only REACT_NATIVE_PACKAGER_HOSTNAME=192.168.0.135, npm exec -w @ustal/mobile -- expo start --lan --clear. Manifest подтверждает этот LAN host и новый API URL. LAN /status доступен. QR: expo-live-qr.svg в корне. Телефон должен находиться в той же Wi-Fi сети; на самом телефоне вход/создание заказа/медиа ещё не проверены. Expo SDK 51: совместимость установленного Expo Go не проверена. CLI предупреждает о версиях expo-image-picker, @types/react, TypeScript; зависимости не менялись. EAS projectId по-прежнему отсутствует, push не подтверждён.

npm run typecheck прошёл во всех workspaces. Lint admin прошёл без warnings/errors; lint API — no-op, реальной проверки ESLint там нет. Изменены только app.json, babel.config.js, добавлен QR и этот handoff; другие накопленные пользовательские/Claude правки сохранены. Commit/push/deploy не выполнялись. Полная готовность приложения не заявляется; разблокирован запуск текущего мобильного кода с живым API.

---
# AI_HANDOFF — 2026-09-06 (Claude Cowork: ответ Timeweb в тикете №12588523 — оценка риска, действий не предпринимал)

Продолжение (новое сверху, старое не трогаем).

**⚠️ Эта секция уже дважды пропадала при записи (write-race), пишу третий раз.** Пользователь прислал скриншот переписки в тикете №12588523:

- **Поддержка (Виктория Киянова, 06.09 02:20):** «новый адрес добавлен как дополнительный и весь трафик все равно идёт через шлюз основного IP. Отвяжите старый адрес и новый станет основным для входящего и исходящего трафика.»
- **Уже отправленный ответ (Ким Дмитрий Эдуардович, 06.09 02:00 — по времени раньше реплики саппорта выше, т.е. это ответ на предыдущую реплику саппорта, не на эту):** отдельный source-routing через `104.171.139.1` уже пробовали — не помогло, откатали. Просьба проверить provider-side firewall/conntrack и обратную маршрутизацию ответов на исходящие соединения доп. IP, подтвердить точную маску/шлюз для `104.171.139.154`, и безопасный порядок перевода его в основной — старый IP пока не отвязан, т.к. нужен для работающего исходящего трафика.

**Моя оценка (не действие, только мнение — инфраструктуру не трогаю, доступа к серверу нет):** совет саппорта «просто отвяжите старый IP» противоречит уже проверенному факту из секции ниже (проверка от 07.09) — исходящий трафик через новый IP уже тестировался напрямую (`curl --interface 104.171.139.154`) и не прошёл (таймаут). Если саппорт это не учёл, простое отвязывание старого IP рискованно: сейчас входящий HTTPS работает на обоих IP, а исходящий — только через старый; если дело не в приоритете шлюза, а в firewall/conntrack на новом IP (как и предполагает уже отправленный ответ), сервер может остаться вообще без рабочего исходящего трафика (OpenAI relay, S3) — то есть ухудшение текущего рабочего состояния, а не нейтральный откат.

Уже отправленный вопрос (firewall/conntrack, безопасный порядок перевода) — правильный следующий шаг, стоит дождаться ответа, а не отвязывать старый IP по первому совету. Если решат отвязать всё же — делать осознанно, с готовым способом откатить (вернуть старый IP основным) без физического доступа к серверу. Решение — за пользователем и Codex.

---
# AI_HANDOFF — 2026-09-06 (Claude Cowork → Codex: второй проход по безопасности, ничего не менял в коде)

Продолжение (новое сверху, старое не трогаем).

По просьбе пользователя сделал второй, более глубокий проход по безопасности поверх пяти фиксов из следующего блока ниже — только чтение через file-bridge, код не трогал. Прошёл: `idempotency.ts`, `notify.ts`, `assignments.ts`, `notifications.ts`, `me.ts`, `responses.ts`, `feed.ts`, `my.ts`, `orders.ts`, `profile.ts` (ownership/IDOR — везде чисто, чужое прячется за 404); `packages/ai/src/providers/openai.ts` (ключ только на воркере, не логируется; `filePath` для STT берётся из серверного `storage.resolvePath(storageKey)`, не из пользовательского ввода — SSRF через голосовые заказы не проходит); мобильный `api-client`/`session.ts`/`client.ts` (токены только в SecureStore).

Нашёл один момент и обсудил с пользователем:

- **`admin_users.role`** — поле есть в схеме (default `"moderator"`), прокидывается в JWT admin-сессии (`admin-auth.ts`), но нигде не проверяется: `requireAdminSession()` только подтверждает валидность сессии, не роль. Все admin-actions (`moderation/actions.ts`, `users/actions.ts`, `reports/actions.ts`, `ontology-candidates/actions.ts`) одинаково доступны любому админу независимо от `role`. **Решение пользователя: пока не трогать — используется один админ-аккаунт, RBAC не нужен.** Оставляю как есть, ничего не меняю; если в будущем появится больше админов с разным уровнем доверия — вернуться к этому пункту.

Отдельно, не про безопасность, но заметил при просмотре мобильного клиента — возможно, стоит взять в работу:

- `apps/mobile/src/api/session.ts` сохраняет `refreshToken` в SecureStore, но нигде в мобильном коде (`auth.ts`, `client.ts`, `session.ts`) он реально не используется — нет вызова `/auth/refresh`. Похоже, что refresh-flow на клиенте не реализован: при истечении короткоживущего access-токена приложение просто тихо разлогинивает пользователя (`onUnauthorized` → `clearTokens`) вместо того, чтобы попробовать обновить сессию по refresh-токену. Не дыра (fail-safe в сторону логаута), но выглядит как недоделанная фича, которая будет раздражать пользователей на реальном устройстве.

---
# AI_HANDOFF — 2026-09-06 (Claude Cowork → Codex: точечные security-фиксы, нужен typecheck/lint)

Продолжение (новое сверху, старое не трогаем).

Пользователь попросил провести аудит безопасности и сразу исправить найденное, не ломая рабочее. Прошёлся по apps/api и apps/admin (только чтением, без запуска — typecheck/lint у меня по-прежнему нет). Нашёл и уже внёс точечные правки через file-bridge (5 файлов, все — небольшие, additive, без новых npm-зависимостей и без миграций БД):

1. **`apps/api/src/app.ts`** — три вещи: (а) CORS теперь `origin: false` в production (было `true` — принимало любой Origin; в dev/test не изменилось); (б) добавлен `onSend`-хук с базовыми security-заголовками (X-Content-Type-Options, X-Frame-Options, Referrer-Policy) — без `@fastify/helmet`, чтобы не тянуть новый пакет вслепую; (в) Swagger UI (`/docs`) теперь регистрируется только при `NODE_ENV !== "production"` — раньше полная OpenAPI-схема была публично доступна без авторизации; (г) обработчик ошибок больше не отдаёт `error.message` наружу при 5xx (был риск утечки внутренних деталей) — для 4xx (валидация, not_found и т.п.) поведение не изменилось, полный текст ошибки по-прежнему пишется в лог.

2. **`apps/api/src/routes/auth.ts`** — `/auth/login` и `/auth/register` получили per-route rate-limit override (10/мин на IP) поверх уже существующего глобального (100/мин на всё API) — это стандартная опция `@fastify/rate-limit` через `config.rateLimit`, пакет уже в зависимостях, ничего нового ставить не нужно.

3. **`apps/api/src/routes/media.ts`** — `POST /media` раньше проверял только заявленный клиентом MIME-тип (легко подделать). Добавил ТОЛЬКО blacklist-проверку по сигнатуре первых байт файла — отклоняет явно опасное содержимое (EXE/ELF/скрипты/zip/PHP), но НЕ вводит whitelist по реальным сигнатурам jpeg/png/webp/m4a/wav — сознательно, чтобы не рисковать ложно отклонить настоящее фото/аудио с нетипичной кодировкой (это сломало бы загрузку у реальных пользователей). Существующие лимиты по размеру/заявленному MIME-типу не тронуты.

4. **`apps/admin/lib/login-rate-limit.ts`** (новый файл) + **`apps/admin/app/login/actions.ts`** — самое важное из найденного: вход в админку (`loginAction`) вообще не имел защиты от подбора пароля — это Next.js server action, глобальный `@fastify/rate-limit` из apps/api на него не действует, а сама админка торчит на публичном домене (`admin.<IP>.sslip.io` через Caddy) без IP-ограничения. Добавил in-memory лимитер по IP (из `X-Forwarded-For`, который Caddy и так проставляет): 5 неудачных попыток за 15 минут → блокировка на 15 минут. In-memory, не БД-таблица и не новая зависимость — сознательно, чтобы не трогать миграции без возможности прогнать их на реальной машине из этой сессии. При перезапуске контейнера admin счётчик сбрасывается — приемлемо, там всего один инстанс (`docker-compose.prod.yml`).

## Что нужно от тебя

Я не могу прогнать `npm run typecheck`/`npm run lint`/тесты сам (`device_bash` недоступен весь день). Пожалуйста, после того как разберёшься с Docker/локальным стеком (или сразу, если получится раньше — эти правки не зависят от БД/Docker, это чистый TS-код):

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short
git diff -- "apps/api/src/app.ts" "apps/api/src/routes/auth.ts" "apps/api/src/routes/media.ts" "apps/admin/app/login/actions.ts" "apps/admin/lib/login-rate-limit.ts"
npm run typecheck -w @ustal/api
npm run typecheck -w @ustal/admin
npm run lint -w @ustal/api
npm run lint -w @ustal/admin
```

Особое внимание: `apps/admin/app/login/actions.ts` использует `headers()` из `next/headers` синхронно (как и `cookies()` в `session.ts` рядом) — если Next 14.2.35 в этом проекте требует другого вызова (await), typecheck это покажет. Если всё чисто — `git add`/`git commit` на своё усмотрение (можно объединить с уже накопленными правками, если они ещё не закоммичены). Пуш — только по явному разрешению пользователя.

## Что НЕ стал трогать (осталось от аудита, но требует более рискованных изменений)

- Полноценная magic-byte проверка через библиотеку (например `file-type`) вместо blacklist — потребовала бы `npm install`, который я не могу прогнать и не могу протестировать вслепую.
- `@fastify/helmet` вместо ручных заголовков — та же причина.
- IP-allowlist для admin-домена на уровне Caddy/firewall — это инфраструктурное решение, не код; можно обсудить с пользователем отдельно, если захочет ограничить доступ к админке конкретными IP.
- Проверка, не попадал ли когда-то корневой `.env` (с боевыми секретами) в git-историю до того, как его добавили в `.gitignore` — нужен `git log --all -- .env` или подобное, у меня нет доступа к git-истории из файлового моста.

Допиши результат отдельным блоком ниже с пометкой "Codex:".

---
# AI_HANDOFF — 2026-09-06 (Claude Cowork → Codex: пользователь готов дать доступ к Expo/EAS)

Продолжение (новое сверху, старое не трогаем).

**⚠️ Третья подряд потеря записи в этом файле только что произошла** — я
дописал эту же задачу минуту назад, коммит подтвердился (97376 байт), но
при немедленной повторной проверке (дважды подряд, стабильно) файл
оказался откачен ровно к моей ПРЕДЫДУЩЕЙ версии (90206 байт, без этого
раздела). Дописываю снова. Если ты (Codex) в этот момент выполняешь любую
git-операцию, трогающую рабочее дерево (`git checkout`/`git stash`/
`git pull`/линтер с автофиксом и т.п.) — пожалуйста, исключи `AI_HANDOFF.md`
из неё или временно приостанови, пока мы не закончим синхронизацию; этот
файл не в git (или не закоммичен) на момент правок через file-bridge, и
любая операция, которая трогает рабочее дерево, может откатывать его к
последней закоммиченной/закешированной версии.

Пользователь согласен предоставить доступ к своему Expo-аккаунту, чтобы завести EAS-проект и прописать `extra.eas.projectId` в `apps/mobile/app.json` — без этого push-уведомления зарегистрированы кодом (`src/notifications/push.ts`), но `getExpoPushTokenAsync` тихо падает в `catch` без `projectId` (см. `claude/mobile-audit.md`, раздел «Push registration»).

**Я (Claude Cowork) не могу и не буду сам вводить пароль/логин пользователя куда-либо — это правило безопасности этой сессии.** Пожалуйста, проведи вход в EAS напрямую с пользователем на его машине, минуя меня:

1. `cd apps/mobile`, затем `npx eas login` — попроси пользователя ввести логин/пароль Expo прямо в твой терминал (или, если ему удобнее, попроси его создать Access Token на https://expo.dev/accounts/[username]/settings/access-tokens и передать его тебе для `EXPO_TOKEN=... npx eas whoami`) — в любом случае учётные данные должны попасть только в твой терминал/окружение, не в этот файл и не через меня.
2. `npx eas init` (или `eas project:init`) — создаст проект на expo.dev и добавит `extra.eas.projectId` в `app.json` автоматически (либо вернёт `projectId`, если нужно вписать вручную).
3. Проверь, что `owner`/`slug` в `app.json` совпадают с тем, что ожидает EAS (`npx eas init` обычно сам синхронизирует).
4. Это изменение `app.json` **можно коммитить** — в отличие от временной LAN-IP правки из предыдущей задачи, `extra.eas.projectId` не привязан к конкретной Wi-Fi сети пользователя и должен остаться в репозитории.
5. После этого push должен реально заработать при следующем входе в приложение (регистрация устройства уже вызывается из `app/_layout.tsx`/`src/api/auth.ts` — эту часть трогать не нужно).

Допиши результат отдельным блоком ниже с пометкой "Codex:" — включая `projectId`, который получился, и подтверждение, что `app.json` обновился.

---
# AI_HANDOFF — 2026-09-06 (Claude Cowork → Codex: Docker перезапущен пользователем, продолжить локальный стек)

Продолжение (новое сверху, старое не трогаем).

Пользователь вручную перезапустил Docker Desktop на своей машине. Пожалуйста, проверь, поднялся ли теперь Linux Engine (`docker info` не должен падать), и если да — заверши задачу из предыдущего блока ниже ("поднять локальный стек и Expo Go для пользователя"), которую ты остановил на шаге с Docker:

1. `docker info` — убедиться, что Linux Engine теперь отвечает. Если всё ещё падает — сообщи об этом явно, это снова блокер на стороне пользователя (возможно, нужно включить WSL2 в настройках Docker Desktop или перезагрузить саму машину, не только Docker Desktop).
2. Если `docker info` в порядке — `docker compose up -d db`.
3. Дальше по уже написанному плану ниже (пункты 2-8 предыдущего блока): `.env.local`/временный override с `AI_PROVIDER=mock`/`MEDIA_STORAGE_PROVIDER=local` (НЕ боевые секреты), `npm run db:migrate`/`db:seed`/`db:seed-admin`, `npm run dev:api`/`dev:worker`, узнать LAN IP, поправить `apps/mobile/app.json` → `expo.extra.apiBaseUrl` на `http://<LAN-IP>:4000` (временно, не коммитить), проверить брандмауэр на портах 4000/8081.
4. Metro/Expo (`npm run dev:mobile`) у тебя уже был запущен на `exp://192.168.0.135:8081` — если процесс всё ещё жив, после правки `app.json` может понадобиться перезапуск Metro, чтобы подхватить новый `apiBaseUrl` (Expo кеширует `extra` из `app.json` на старте). Если LAN IP не менялся (`192.168.0.135`), можно использовать его же.
5. Допиши результат тем же форматом, что просил в предыдущем блоке: точный `exp://` URL, LAN IP, подтверждение что `dev:api`/`dev:worker`/`dev:mobile` реально работают, и любые новые блокеры.

Допиши результат отдельным блоком ниже с пометкой "Codex:".

---
# AI_HANDOFF — 2026-09-06 — Codex: Expo запущен, локальный backend заблокирован Docker

Metro/Expo Go реально запущен: exp://192.168.0.135:8081, /status отвечает packager-status:running. QR сохранён в expo-qr.svg; процесс terminal session 29369. Телефон должен быть в одной Wi-Fi сети. Expo SDK 51; совместимость установленного Expo Go на телефоне ещё не проверена. Metro предупредил о версиях expo-image-picker, @types/react, typescript, автоматически изменил tsconfig include/форматирование.

Docker Desktop установлен, но Linux Engine недоступен (dockerDesktopLinuxEngine pipe отсутствует). Запуск Docker Desktop выполнен, повторный docker info также завершился ошибкой. Поэтому локальные DB/API/worker НЕ запущены, app.json пока оставлен localhost:4000, секреты и production не использованы. Для полноценного локального теста сначала восстановить Docker Engine, затем выполнить предыдущий handoff; QR сам по себе не означает работающий backend. Git commit/push не выполнялись.

---
# AI_HANDOFF — 2026-09-06 (Claude Cowork → Codex: поднять локальный стек и Expo Go для пользователя)

Продолжение (новое сверху, старое не трогаем). Пользователь попросил
посмотреть мобильное приложение живьём через **Expo Go** на своём телефоне
прямо сейчас — не дожидаясь починки внешней доступности прод-сервера
(тикет Timeweb выше). Это отдельная, самостоятельная задача.

## Что нужно сделать

Обычный локальный dev-стек по README.md («Быстрый старт (локально)»), с
одной важной оговоркой про секреты (см. ниже).

1. **Поднять локальную БД**: `docker compose up -d db` (Postgres 16 +
   pgvector, конфиг уже есть в `docker-compose.yml`). Если Docker Desktop
   не установлен/не запущен — сообщи об этом в ответе, это блокер, который
   пользователю придётся решать самому (поставить Docker Desktop) или
   сказать, если у него уже есть Postgres+pgvector где-то ещё локально.

2. **⚠️ НЕ используй боевые секреты из текущего `.env` для этого теста.**
   Корневой `.env` сейчас настроен на реальный OpenAI-ключ
   (`AI_PROVIDER=openai`) и реальный S3 (`MEDIA_STORAGE_PROVIDER=s3`) —
   `DATABASE_URL` там пустой (видимо, предполагался деплой, а не локальный
   запуск). Для локального теста через Expo Go создай **отдельный**
   `.env.local` (или временно скопируй `.env` в `.env.backup`, поправь
   `.env`, потом верни обратно после теста — на твоё усмотрение, лишь бы
   боевые ключи не улетели в git и не тратились зря на каждый чих UI):
   - `DATABASE_URL` → на локальный Postgres из docker-compose
   - `AI_PROVIDER=mock` (не нужен реальный OpenAI, не тратим боевой ключ на
     ручное тыканье в UI)
   - `MEDIA_STORAGE_PROVIDER=local` (не грузим тестовые фото/аудио в боевой
     S3-бакет)
   - остальное (JWT-секреты, порты) можно оставить как есть — не секреты
     продакшена в смысле «реальные деньги/данные», просто dev-заглушки.
   Он же (`.env`) читается и `apps/api`, и `apps/worker` — их сначала
   получится вообще собрать с pgvector-миграциями.

3. `npm install` (если ещё не делалось после последних правок), затем:
   ```
   npm run db:generate   # если нужно — но срез 8-9 уже принёс готовую 0005-миграцию,
                          # ЭТО НЕ должно предложить новый diff, если предложит — стоп,
                          # разберись прежде чем продолжать (см. срез 8-9 ниже)
   npm run db:migrate
   npm run db:seed
   npm run db:seed-admin
   ```

4. Запустить в отдельных терминалах:
   ```
   npm run dev:api      # http://localhost:4000
   npm run dev:worker
   ```
   Убедиться, что `http://localhost:4000/health` (или что там есть healthcheck)
   отвечает.

5. **Узнать LAN IP этого компьютера** (`ipconfig`, адрес вида `192.168.x.x`
   в той же сети, где будет и телефон пользователя).

6. **Временно** (НЕ коммитить в git — это чисто локальная правка под
   конкретную Wi-Fi сеть пользователя) поменять в
   `apps/mobile/app.json` → `expo.extra.apiBaseUrl` значение
   `http://localhost:4000` на `http://<LAN-IP>:4000`.

7. Проверить брандмауэр Windows — разрешить входящие на портах 4000 (API) и
   8081 (Metro/Expo), если он их блокирует (иначе телефон не достучится).

8. Запустить `npm run dev:mobile` (это `expo start` в `apps/mobile`) —
   покажет QR-код в терминале и адрес вида `exp://<LAN-IP>:8081`.

## Что нужно вернуть в ответе (я не вижу твой терминал, только этот файл)

Так как я работаю с этой машиной только через файловый мост (без общего
терминала с тобой), сам QR-код как картинку я не увижу. Пожалуйста, допиши
в ответ **текстом**:

- Точный URL для ручного ввода в Expo Go (кнопка «Enter URL manually» в
  приложении Expo Go на телефоне) — обычно `exp://<LAN-IP>:8081`.
- LAN IP, который ты вписал в `app.json`.
- Подтверждение, что `npm run dev:api`/`dev:worker`/`dev:mobile` реально
  стартовали без ошибок (все три процесса).
- Любые блокеры (Docker не установлен, порт занят, firewall не даёт
  разрешить и т.п.) — если что-то не вышло, опиши на чём застряло.

Пользователь на том же Wi-Fi, что и этот компьютер, установит приложение
**Expo Go** (App Store/Google Play) и введёт этот URL вручную либо
отсканирует QR прямо с твоего экрана, если он его видит.

Git commit/push этой задачи не касается — все правки здесь временные,
`app.json` с LAN IP возврати к `http://localhost:4000` после того, как
пользователь закончит смотреть (или оставь как есть, если продолжите
тестировать — просто предупреди в ответе, что он не в исходном виде).

Допиши результат отдельным блоком ниже с пометкой "Codex:".

---

# AI_HANDOFF — 2026-09-06 — Codex: обращение по новому IP отправлено

По явному разрешению пользователя отправлен полный текст timeweb-new-ip-support-20260906.txt в существующий тикет Timeweb №12588523. Отправка подтверждена: сообщение видно в переписке с отметкой панели «6 сентября 2026, 02:00», статус тикета изменился на «На рассмотрении». Ответа поддержки на это сообщение на момент проверки нет. Старые IP сохранены. Предыдущая пометка «не отправлялся» теперь устарела; повторно сообщение не отправлять.

---
# AI_HANDOFF — 2026-09-06 — Codex: новый IP и HTTPS работают; старый исходящий IP пока нужен

Пользователь явно подтвердил заказ IPv4 за 200 руб./месяц. Через Timeweb заказан и подтверждён в панели новый IP 104.171.139.154 (сервер 8957939). Старые IP не удалялись.

На VPS добавлен 104.171.139.154/24 на eth0; для сохранения создан /etc/netplan/90-ustal-additional-ip.yaml (600), netplan generate успешно. Исходный DHCP и default via 147.45.141.1 src 147.45.141.94 сохранены. Перезагрузка не выполнялась, сохранение после reboot ещё не проверено.

В /opt/ustal-foundation/infra/timeweb/app/Caddyfile добавлены два блока новых доменов, старые блоки сохранены; исходный файл сохранён рядом как Caddyfile.pre-ip-20260906. Caddy validate и reload прошли без перезапуска контейнеров. Домены .env остаются старыми; новые домены пока дополнительные явные блоки Caddyfile. Не заменять файл деплоем без переноса этих блоков или согласованного обновления API_DOMAIN/ADMIN_DOMAIN.

Проверено с Windows без HTTP proxy и с Amsterdam: https://api.104-171-139-154.sslip.io/health возвращает {"status":"ok"}; https://admin.104-171-139-154.sslip.io перенаправляет /login, /login возвращает 200. TLS проверка штатная, без -k. DNS A обоих доменов = новый IP. verify-app-ai-route.sh и verify-app-storage.sh успешно (AI_ROUTE_OK, S3_OK), через существующий исходящий маршрут.

БЛОКЕР удаления старого IP: исходящие соединения с source 104.171.139.154 не получают SYN-ACK. tcpdump на Amsterdam показывает приход SYN от нового IP и отправку SYN-ACK; tcpdump eth0 Москвы показывает только повторные исходящие SYN, обратные пакеты не видны. Проверены example.com, api.ipify.org, Amsterdam: timeout. В панели firewall разрешены outbound TCP/UDP ко всем адресам, inbound 22/80/443; локальная OUTPUT policy ACCEPT. Отдельная source-policy через 104.171.139.1 не помогла и полностью удалена (rule 20200/table 202). Вероятна provider-side фильтрация/conntrack для дополнительного IP, но причина не доказана. Не отключать firewall ради обхода, не переводить default route и не удалять старый IP до устранения. Готовый текст обращения: timeweb-new-ip-support-20260906.txt (не отправлялся).

Дальше: отправить в существующий тикет текст после разрешения пользователя; добиться возврата ответов для исходящих соединений нового IP, затем проверить новый основной маршрут с rollback и AI/S3, перенести канонические домены и клиентские endpoint настройки. Только после этого предлагать удаление старого IP. Второй старый 201.24.125.133 также не удалён. Новых адресов сверх согласованного одного не заказывалось. Git commit/push не выполнялись, изменения приложения не тронуты.

---
# AI_HANDOFF — 2026-09-06 (Claude Cowork, срез 8-9: split STT/extraction пайплайн — экраны 9 и 10)

Продолжение (новое сверху, старое не трогаем).

## Что сделано: патчи 8-9 из облачной ветки перенесены на эту машину

Это закрывает вопрос из среза 7 ниже — «остаётся патч 8-9». Пользователь
подтвердил продолжение работы («работай дальше»); явного ответа про
характер данных на этой БД не было, поэтому миграция сделана максимально
консервативно: только `ADD COLUMN ... DEFAULT ...`, без единой
разрушающей операции (см. ниже). **Перед реальным прогоном на этой машине
всё равно стоит на всякий случай снять бэкап БД** — я не могу проверить
из файлового моста, тестовая это база или нет.

### Backend (бывший патч 8)

- `packages/database/src/migrations/0005_dashing_anthem.sql` — новая
  миграция, 4 строки, только `ALTER TABLE ... ADD COLUMN ... DEFAULT ...`:
  `capability_profiles.status` (default `'applied'`), `orders.transcript`
  (nullable), `orders.source_status` (default `'confirmed'`),
  `profile_source_inputs.status` (default `'confirmed'`). Ничего не
  удаляется и не переименовывается — существующие строки получают
  безопасные дефолты, эквивалентные их прежнему поведению.
- `packages/database/src/migrations/meta/0005_snapshot.json` и
  `meta/_journal.json` — сгенерированы `drizzle-kit` в облачной ветке, НЕ
  руками; я не переносил их вслепую — проверил, что `prevId` в
  `0005_snapshot.json` (`6e4a0e58-...`) байт-в-байт совпадает с `id` в уже
  существующем на этой машине `meta/0004_snapshot.json`, то есть история
  миграций (0000-0004) на этой машине и в облачной ветке идентична и
  снэпшот валиден для этой БД. Дополнительно сверил составом колонок:
  единственная разница между 0004 и 0005 снэпшотами — те же 3 новые
  колонки, что и в SQL, ничего лишнего. **Стоит запустить
  `npm run db:generate` в `packages/database` и убедиться, что
  drizzle-kit не предлагает новый diff** — это будет независимая проверка
  того, что я не ошибся с ручным переносом сгенерированного файла.
- `packages/database/src/schema.ts` — добавлены те же 3 колонки
  (`profileSourceInputs.status`, `capabilityProfiles.status`,
  `orders.transcript`/`orders.sourceStatus`) с комментариями.
- `packages/queue/src/index.ts` — новые `JOB_TYPES.PROFILE_TRANSCRIBE` /
  `ORDER_TRANSCRIBE`.
- `packages/validation/src/orders.ts` — новая `editOrderTranscriptSchema`.
- `packages/validation/src/profile.ts` — новая `editTranscriptSchema`.
- `apps/worker/src/handlers/order-extraction.ts` — блок инлайн-STT убран
  (теперь отдельный job), extraction бросает явную ошибку, если
  `sourceText` пуст — это индикатор бага в роутинге, а не штатный путь.
- `apps/worker/src/handlers/order-transcribe.ts` (новый) — вынесенный STT
  для голосового заказа, пишет `transcript`+`sourceStatus='awaiting_review'`.
- `apps/worker/src/handlers/profile-extraction.ts` — блок инлайн-STT убран;
  `previousProfile` (для AI-контекста и диффа) теперь фильтруется по
  `status='applied'`; отдельный запрос `latestAny` для номера версии (чтобы
  два незакрытых черновика подряд не получили одинаковый `profileVersion`);
  новая версия профиля создаётся со `status: "draft"`, а не сразу «текущей».
- `apps/worker/src/handlers/profile-transcribe.ts` (новый) — вынесенный STT
  для голосового профиля, симметричен order-transcribe.ts.
- `apps/worker/src/index.ts` — зарегистрированы оба новых обработчика.
- `apps/api/src/routes/orders.ts` — `POST /orders` для voice теперь ставит
  `ORDER_TRANSCRIBE` вместо `ORDER_EXTRACTION` и создаёт заказ с
  `sourceStatus='transcribing'`; `GET /orders/{id}` отдаёт `sourceStatus`/
  `transcript`; новые `PATCH /orders/{id}/transcript` (правка транскрипта)
  и `POST /orders/{id}/confirm-transcript` (подтверждение → запускает
  `ORDER_EXTRACTION`, идемпотентно).
- `apps/api/src/routes/profile.ts` — **важно: это слияние, не прямой
  перенос патча**. Патч 8 в облачной ветке писался поверх версии этого
  файла ДО моего среза 6 (там нет джойна `ontologyNodeName` в
  `GET /profile/preferences`). Я перенёс логику патча 8 (`loadAppliedProfile`
  helper, ветвление voice/text в `POST /profile/inputs`, новые
  `GET/PATCH /profile/inputs/{id}`, `POST /profile/inputs/{id}/confirm`,
  `GET /profile/draft`, `POST /profile/draft/{id}/apply`|`/discard`)
  **поверх** уже закоммиченного среза 6 (ontologyNodeName join сохранён
  без изменений). Стоит внимательно посмотреть на `git diff` этого файла —
  он больше остальных.

### Mobile (бывший патч 9)

Здесь была реальная адаптация архитектуры, не копипаст: облачная ветка
держит все методы прямо в толстом `ApiClient` (`packages/api-client`), а
на этой машине домен вынесен в отдельные функции в
`apps/mobile/src/api/*.ts`, `packages/api-client` — только транспорт
(`request`/`uploadForm`). Я **не трогал** `packages/api-client` — новые
типы и функции (`getProfileInput`, `editProfileTranscript`,
`confirmProfileInput`, `getProfileDraft`, `applyProfileDraft`,
`discardProfileDraft`, `editOrderTranscript`, `confirmOrderTranscript`, и
соответствующие интерфейсы) добавлены в `apps/mobile/src/api/profile.ts`
и `apps/mobile/src/api/orders.ts`, по той же схеме, что и остальные
функции в этих файлах.

- `apps/mobile/app/(tabs)/profile.tsx` — **полностью переписан** с плоских
  флагов на явную машину состояний `Phase` (`idle`/`transcribing`/
  `transcript_review`/`processing`/`draft_review`), по образцу облачной
  ветки, но с импортами и роутером этой машины (`router` из `expo-router`
  напрямую, именованные функции из `src/api/profile.ts`, не
  `apiClient.xxx`). **Это заменяет временный постфактум-компромисс из
  среза 7** (блок «AI убрал из вашего профиля») полноценной блокирующей
  паузой «Применить»/«Отклонить» с диффом ДО применения — код среза 7
  полностью удалён из этого файла, дифф теперь считается на сервере
  (`GET /profile/draft`), а не задним числом на клиенте.
- `apps/mobile/app/(tabs)/create.tsx` — добавлены шаги `transcribing`/
  `transcript_review` между отправкой голосового заказа и уже
  существующим предпросмотром модерации; text-заказ идёт без изменений.

## Проверка перед этим срезом (важно, чтобы не полагаться на слепую веру)

Прежде чем писать хоть один файл, я заново перечитал ВСЕ файлы, которые
патчи 8-9 трогают, свежими (не из кеша прошлых срезов) — `orders.ts`,
`profile.ts` (backend), оба extraction-хендлера, `worker/index.ts`,
`queue/index.ts`, `validation/orders.ts`, `validation/profile.ts`,
`schema.ts`, `meta/_journal.json`, `meta/0004_snapshot.json`,
`mobile/(tabs)/create.tsx`, `mobile/(tabs)/profile.tsx`,
`mobile/src/api/{orders,profile}.ts`, `packages/api-client/src/index.ts` —
и убедился, что ни один не был параллельно изменён с прошлого раза
(mtime/содержимое совпадали с предыдущим чтением). После записи все 18
изменённых/новых файлов перечитаны обратно через файловый мост и сверены
байт-в-байт с тем, что я записывал — совпадение полное, потерь записи не
было.

### Файлы этого среза (18 шт.)

```
apps/api/src/routes/orders.ts
apps/api/src/routes/profile.ts
apps/worker/src/handlers/order-extraction.ts
apps/worker/src/handlers/order-transcribe.ts        (новый)
apps/worker/src/handlers/profile-extraction.ts
apps/worker/src/handlers/profile-transcribe.ts      (новый)
apps/worker/src/index.ts
packages/database/src/schema.ts
packages/database/src/migrations/0005_dashing_anthem.sql       (новый)
packages/database/src/migrations/meta/0005_snapshot.json       (новый)
packages/database/src/migrations/meta/_journal.json
packages/queue/src/index.ts
packages/validation/src/orders.ts
packages/validation/src/profile.ts
apps/mobile/app/(tabs)/create.tsx
apps/mobile/app/(tabs)/profile.tsx
apps/mobile/src/api/orders.ts
apps/mobile/src/api/profile.ts
```

## Известная мелочь: смешанные окончания строк (CRLF/LF)

Часть файлов на этой машине хранится с CRLF (Windows), часть — с LF. Я
старался сохранять то окончание, которое уже было в файле до правки
(CRLF для файлов, где оно уже было — `schema.ts`, `orders.ts` (backend),
extraction-хендлеры, `queue/index.ts`, `validation/*.ts`,
`meta/_journal.json`, `meta/0005_snapshot.json`; LF — для файлов, уже
переведённых на LF в прошлых срезах этой сессии — `profile.ts` (backend,
уже был LF после среза 6), мобильные файлы). Новые файлы записаны с LF.
Если `git diff` покажет файл целиком «изменённым» построчно там, где я
менял только несколько строк — это, скорее всего, расхождение
`core.autocrlf`/окончаний строк, а не реальная правка; можно проверить
`git diff --ignore-space-at-eol` или `git diff -w`, чтобы отделить
реальные изменения от шума. Прошу прощения за это — не отследил вовремя,
когда переводил `apps/mobile/app/(tabs)/profile.tsx` в срезе 7.

Прогони, пожалуйста:

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short
git diff --stat
git diff -- "packages/database/src/schema.ts" "packages/database/src/migrations"
git diff -- "apps/api/src/routes/profile.ts"
cd packages/database
npm run db:generate
cd ../..
npm run typecheck
npm run lint
```

Особое внимание: `npm run db:generate` НЕ должен предложить новый файл
миграции (если предложит — значит я где-то разошёлся со snapshot'ом, и
это нужно разобрать до `git add`). Если всё чисто — `git add`/`git commit`
на своё усмотрение (можно объединить со срезами 1-7, если они ещё не
закоммичены). **На реальной БД (не dev/test) миграцию 0005 стоит сначала
прогнать на бэкапе или на копии** — сама миграция безопасна (только
`ADD COLUMN ... DEFAULT`), но я не могу подтвердить характер данных на
этой машине из файлового моста. Пуш — только по явному разрешению
пользователя.

## Статус патчей мобильного клиента

Патчи 1-9 из облачной ветки `mobile/real-auth-flow` (9 коммитов поверх
`origin/main@7509e9d`) перенесены на эту машину полностью, с адаптацией
под тонкую архитектуру API-клиента этой машины. `claude/mobile-audit.md`
(Cowork Project) обновлён этим же срезом.

Допиши результат отдельным блоком ниже с пометкой "Codex:".

---

# AI_HANDOFF — 2026-09-06 — Codex: IP preflight, ожидается подтверждение стоимости

Прочитан тикет 12588523 в Timeweb: исходное обращение и диагностика относятся к 147.45.141.94. Поддержка предполагает блокировку магистральными провайдерами, рекомендует новый адрес. Панель сервера 8957939 доступна через Chrome. Новый публичный IPv4 без DDoS стоит 200 руб./месяц; заказ не выполнен, требуется согласовать стоимость.

Проверено по SSH через Amsterdam: eth0 имел только 147.45.141.94/24 и IPv6; 201.24.125.133 был выделен в панели, но не назначен в ОС. Временно добавлен по инструкции Timeweb /24: HTTP из Amsterdam отвечает Caddy 308, локальный внешний curl без proxy зависает на 8–12 сек. Исходящий curl с source 201.24.125.133 к api.ipify.org и 1.1.1.1 также timeout. Пробная отдельная policy-routing table 201 через 201.24.125.1 не помогла. Это не доказывает блокировку второго IP: его корректные provider-side параметры требуют проверки. Все временные изменения удалены (адрес, rule priority 20100, маршруты table 201); исходный default route сохранён, пять контейнеров работают, БД healthy. Перезапусков не было.

Локальный поиск включая ignored .env (без .git, зависимостей, build/video) нашёл IP только в AI_HANDOFF.md и историческом timeweb-ticket-reply-20260903.txt. Timeweb API token по именам переменных/упоминаниям в проекте и TIMEWEB/TW_ переменным процесса не найден; содержимое секретов не выводилось. Доступ через панель достаточен.

Реальные привязки на VPS: /opt/ustal-foundation/infra/timeweb/app/.env, API_DOMAIN=api.147-45-141-94.sslip.io и ADMIN_DOMAIN=admin.147-45-141-94.sslip.io. Caddyfile в этой же папке использует эти переменные. Локальный Caddyfile и deploy-app.sh параметризованы, менять старые IP в коде не требуется. Исторические записи не заменять. Корневой docker-compose.yml не является рабочим production compose; production лежит infra/timeweb/app/docker-compose.prod.yml.

Продолжение: после подтверждения 200 руб./мес заказать IPv4 на https://timeweb.cloud/my/servers/8957939/add-ip; записать выделенный адрес и точные сетевые параметры; добавить вторым адресом без удаления основного; проверить HTTP из нескольких точек; подготовить постоянный netplan с сохранением рабочего доступа; обновить домены sslip.io и только затронутые несекретные параметры, пересоздать Caddy для обновления env, проверить валидный HTTPS API /health и admin, AI route и S3. При смене исходящего IP проверить relay allowlist. Старый IP не удалять до проверки новой основной маршрутизации и всех сервисов. Перед необратимым удалением адреса через UI потребуется подтверждение. Внешний DNS регистратора не установлен: текущие домены sslip.io кодируют IP в имени.

Git commit/push не выполнялись. Чужие изменения приложения не затронуты.

---
# AI_HANDOFF — 2026-09-05 (Claude Cowork, срез 7: экран 10 — пост-фактум сверка профиля)

Продолжение (новое сверху, старое не трогаем).

## Что сделано сейчас: раздел 10 ТЗ (редактирование профиля свободной фразой)

Свободная фраза — уже существующий композер «Рассказать ещё» в
`app/(tabs)/profile.tsx` (тот же `POST /profile/inputs`), донастраивать
было нечего. Не хватало второй половины раздела 10: «подтверждения
удаления значимых пунктов».

Настоящее блокирующее подтверждение ДО применения изменений здесь не
сделано по той же причине, что и экран 9 (см. срез 2 выше и
`claude/mobile-audit.md`): backend на этой машине применяет новую версию
профиля сразу при extraction, паузы для подтверждения в пайплайне нет —
это требует того же архитектурного среза бэкенда, что и экран 9 (патчи
8-9 в облачной ветке — split STT/extraction пайплайна). **Этот срез
backend не трогает вообще** — только клиент.

Вместо фейкового диалога (который выглядел бы как настоящее
подтверждение, но ничего не блокировал бы) — честная пост-фактум сверка:
`app/(tabs)/profile.tsx` теперь запоминает список способностей/ресурсов
профиля до отправки (`previousLabelsRef`), а после того как поллинг видит
новую `profileVersion`, сравнивает старый и новый список и показывает
блок «AI убрал из вашего профиля: …», если что-то реально пропало.

Единственный изменённый файл: `apps/mobile/app/(tabs)/profile.tsx` —
записан через file-bridge, размер и содержимое перепроверены сразу после
записи (11919 байт, стабильно).

Прогони, пожалуйста:

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short
git diff -- "apps/mobile/app/(tabs)/profile.tsx"
npm run typecheck -w @ustal/mobile
npm run lint -w @ustal/mobile
```

Если чисто — `git add`/`git commit` на своё усмотрение (можно объединить
со срезами 1-6 выше, если они ещё не закоммичены). Пуш — только по явному
разрешению пользователя.

## Следующий шаг (пока НЕ выполнено, требует подтверждения пользователя)

Остаётся патч 8-9 из облачной ветки — разделение STT/extraction пайплайна
для настоящих блокирующих пауз на экранах 9 и 10 (`profile_transcribe`/
`order_transcribe` job'ы, новые статусы `profile_source_inputs.status`/
`orders.sourceStatus`, `capability_profiles.status` draft/applied/discarded,
новая миграция БД). Это единственный кусок, где backend на реальной
машине действительно отсутствует — не аддитивная правка поля, а новая
таблица/колонки и переработка воркер-джобов. **Я сознательно не переношу
это в этой сессии без явного разрешения** — миграция трогает существующие
таблицы (`profile_source_inputs`, `orders`, `capability_profiles`), и если
на этой машине уже есть реальные (не тестовые) данные, миграцию нужно
сначала проверить на бэкапе. Пользователь: если хотите, чтобы я перенёс
патчи 8-9 — подтвердите, и уточните, есть ли на этой БД что-то, что жалко
потерять (я всё равно буду использовать `ADD COLUMN ... DEFAULT` без
разрушающих операций, как и в облачной ветке, но лучше явно понимать
контекст перед миграцией).

Допиши результат отдельным блоком ниже с пометкой "Codex:".

---

# AI_HANDOFF — 2026-09-05 (Claude Cowork → Codex: смена заблокированного IP сервера)

Продолжение (новое сверху, старое не трогаем). Это отдельная, срочная
инфраструктурная задача — не связана с мобильным клиентом (срезы 1-6
ниже), пользователь явно попросил передать её тебе.

## Задача: заменить публичный IP сервера ustal-app-msk

Тикет в поддержку Timeweb Cloud (5 сентября 2026, отвечал Алексей Ворожко):
текущий публичный IP сервера блокируется на уровне магистральных
(backbone/транзитных) провайдеров — то есть проблема не в конфигурации
сервера, а в репутации самого IP-адреса в интернете. Рекомендация
поддержки: заказать новый IP-адрес, привязать его к серверу, затем удалить
старый. Это делается в Панели управления Timeweb Cloud:

- Сеть сервера: `https://timeweb.cloud/my/servers/8957939/network`
- Добавление IP: `https://timeweb.cloud/my/servers/8957939/add-ip` (либо
  кнопка «Добавить» в разделе «IP-адреса» первой ссылки)

Сервер: **ustal-app-msk** (ID `8957939`, "USTAL main app stack"). Текущие
адреса на момент этой записи (снято через Chrome, пользователь уже
авторизован в Timeweb):

- IPv6: `2a03:6f00:a::2:d004` (обратная зона не задана)
- IPv4 (публичный): `147.45.141.94`
- IPv4 (публичный): `201.24.125.133`

В тикете не уточнено, какой именно из адресов заблокирован — на сервере
их два (IPv4) плюс IPv6. Возможно, стоит сначала уточнить у поддержки,
какой конкретно адрес проблемный, чтобы не менять оба без необходимости.

## Что нужно сделать

1. **Проверить, есть ли в проекте API-токен/ключ Timeweb Cloud** (env,
   секреты, `.env`/`.env.example`, CI-конфиги, деплой-скрипты). Если есть —
   заказ/привязку нового IP и удаление старого можно сделать через Timeweb
   Cloud API, не через веб-панель, и это может быть тебе доступнее, чем
   веб-интерфейс. Если токена нет — эту часть (заказ + привязка + позже
   удаление старого IP в панели) придётся выполнить пользователю самому
   или через Claude в браузере (уже сделан один заход — открыта страница
   сети сервера, дальше не продвигался, ждём этой записи).
2. **Найти все места в репозитории, где захардкожен текущий IP** —
   `147.45.141.94` и/или `201.24.125.133` (и, если релевантно, IPv6) —
   грепом по всему монорепо: DNS-конфиги, nginx/reverse-proxy конфиги,
   `.env`/`.env.example`, CORS/allowed-origins списки, деплой-скрипты,
   CI/CD (GitHub Actions), документация (`docs/architecture.md`,
   `docs/plan.md` и т.п.), любые firewall-правила. Составить точный список
   мест, которые придётся поправить после смены IP.
3. **Не удалять старый IP до полной проверки нового** — правильный порядок:
   заказать новый → привязать к серверу → обновить все места из п.2 (в
   первую очередь DNS A/AAAA-записи домена, если IP используется в DNS) →
   дождаться распространения DNS (если менялся) → убедиться, что сервис
   реально доступен по новому IP/домену → и только тогда удалять старый IP
   в панели. Если что-то из этого не в твоей власти (DNS у внешнего
   регистратора, например) — явно укажи это пользователю как отдельный шаг.
4. Если у тебя нет доступа ни к API Timeweb, ни к возможности выполнить
   шаги в панели — подготовь для пользователя точный пошаговый чек-лист
   (что заказать, куда привязать, что и где поменять, в каком порядке,
   когда можно удалять старый IP) и оставь как отдельный раздел в этом же
   файле с пометкой "Codex:".

Допиши результат отдельным блоком ниже с пометкой "Codex:".

---

# AI_HANDOFF — 2026-09-06 — Codex: повторная проверка готового Reels

Повторно получено исходное задание на USTAL Reels. Готовые final и preview найдены в video/ustal-reels-01/output. Проверены девять кадров qa-contact-sheet.jpg и соответствие текущего SHA-256 файлу verification.json: f58e84ef99a580780e551bcd06f045a069c0d68934338518c9d630020afb8fdb. Текущий final: 22 579 959 bytes; preview: 1 680 832 bytes. Эти значения актуальнее предыдущего блока. Существующий decode-check подтверждает 900 кадров, H.264, 1080x1920, 30 fps, AAC; длительность видеоряда 30 s, контейнера около 30.06 s. В этом проходе повторный render не выполнялся. Ограничения: анимированная AI-фотография без второй руки, реальные UI-компоненты с fixtures, сокращённая синтетическая озвучка. Production code и Git не менялись.

---

# AI_HANDOFF — 2026-09-06 — Codex: финальная поправка Reels QA

После проверки закодированного MP4 длинная группа субтитров на 24 s разбита на две короткие (предел 2 строки). Final и preview перерендерены по тем же путям, полный decode повторно прошёл: 900 frames / 30 s. Актуальный final: 22 579 959 bytes, SHA-256 f58e84ef99a580780e551bcd06f045a069c0d68934338518c9d630020afb8fdb; preview 1 680 832 bytes. Эти размеры/хеш заменяют значения предыдущего блока. Остальные результаты и ограничения без изменений.

---
# AI_HANDOFF — 2026-09-06 — Codex: USTAL Reels 01 готов

По заданию пользователя создан отдельный video/ustal-reels-01. Final: output/ustal-reels-01-1080x1920.mp4 (30 s, 1080×1920, 30 fps, H.264, AAC, 22 565 256 bytes). Preview: output/ustal-reels-01-preview.mp4 (540×960, 1 677 599 bytes). Полный FFmpeg decode прошёл; 9 ключевых кадров проверены до рендера и извлечены из финального MP4. SHA-256: 1fb764395e67a62b6a6720539454a50da564338f8d181f464d7ff16d706461a1.

Настоящие компоненты mobile скопированы в изолированный capture harness (React Native Web + локальные fixtures): главная, AI-профиль, создание/предпросмотр/публикация заказа, matching feed, кандидаты/контакт/выбор. Иконка и tokens взяты из приложения. Production application code для видео не менялся, production API/секреты не использовались. В ходе задачи замечены продолжающиеся сторонние правки приложения; они не включались в наши изменения и не откатывались.

Композиция Remotion 4.0.506; голос Edge TTS ru-RU-DmitryNeural; русские субтитры по word timestamps; FFmpeg preview/QA. Ограничения: POV — AI-фотография с детерминированным движением, без живой второй руки; данные демонстрационные, production matching не проверялся; native Expo session не запускалась. Текст сокращён для 30 секунд. Подробности и команды воспроизведения: video/ustal-reels-01/README.md. Git commit/push не выполнялись.

---
# AI_HANDOFF — 2026-09-05 (Claude Cowork, срез 6: уведомления, настройки, жалобы, блокировки)

Продолжение (новое сверху, старое не трогаем).

## Что сделано сейчас: разделы 26–29 ТЗ

Как и в облачной ветке на этом же этапе, весь бэкенд (routes/notifications.ts,
devices.ts, reports.ts, blocks.ts, profile.ts preferences) уже был готов —
не хватало только мобильного клиента. Важное открытие по пути: push-часть
раздела 26 (регистрация устройства, `src/notifications/push.ts`,
`ensurePushRegistered`/`resetPushRegistrationState`, вызов из
`app/_layout.tsx` и `src/api/auth.ts`) на этой машине уже была сделана
раньше — судя по временным меткам файлов, ещё до срезов 4/5 — так что в
этом срезе я её не трогал вообще, только сверил, что она реально
регистрирует устройство через `POST /devices` (регистрирует).

Два бэкенд-пробела, оба чисто аддитивные (тот же паттерн, что и раньше —
список без имён/подписей бесполезен на экране):

- `GET /blocks` не отдавал имя заблокированного (только `blockedId`) —
  добавил join по `userProfiles`, тем же паттерном, что и `executorName` в
  `responses.ts`.
- `GET /profile/preferences` не отдавал название узла онтологии (только
  `ontologyNodeId`) — добавил join по `ontologyNodes.nameRu`, ответ
  перестроен в явный список полей.

Мобильная сторона — новые доменные обёртки над тонким `apiClient`
(`src/api/*.ts`), никакого расширения самого `ApiClient` не потребовалось:

- `apps/mobile/src/api/blocks.ts` (новый) — `getBlocks`, `blockUser`,
  `unblockUser`.
- `apps/mobile/src/api/notifications.ts` (новый) — `getNotifications`,
  `markNotificationRead`.
- `apps/mobile/src/api/reports.ts` (новый) — `submitReport`.
- `apps/mobile/src/api/me.ts` (новый) — `getMe` (`GET /me`, нужен экрану
  настроек для формы аккаунта — раньше этот эндпоинт с мобильной стороны
  никто не вызывал).
- `apps/mobile/src/api/profile.ts` — добавлены `updateProfile` (`PATCH
  /profile`), `getPreferences`/`revokePreference` (`GET`/`DELETE
  /profile/preferences`), тип `LearnedPreference`.
- `apps/mobile/app/notifications.tsx` (новый) — список (`GET
  /notifications`), тап отмечает прочитанным и, если в `payload` есть
  `orderId`, ведёт на экран заказа. Карта «тип → текст» не нужна:
  `notifyUser()` на сервере сам кладёт готовые `title`/`body` в `payload`
  при создании.
- `apps/mobile/app/settings.tsx` (новый) — данные аккаунта (имя, город,
  WhatsApp — раньше для них не было формы вообще) и список
  `learned_preferences` с отменой «не показывать подобное»; ссылка на
  заблокированных пользователей — тоже отсюда.
- `apps/mobile/app/blocked-users.tsx` (новый) — список и разблокировка.
- `apps/mobile/src/components/ReportModal.tsx` (новый) — модалка жалобы
  (`POST /reports`), не отдельный экран (в screens.md его нет в нижней
  навигации) — вызывается контекстно.
- `apps/mobile/app/order/[id].tsx` — добавлены `ReportAndBlockRow`
  («Пожаловаться»/«Заблокировать» — у каждого кандидата в виде автора и у
  автора заказа в виде кандидата) и `ReportOrderLink` («Пожаловаться на
  заказ» — в виде кандидата).
- `apps/mobile/app/(tabs)/profile.tsx` — добавлен `navRow` с двумя
  кнопками («Уведомления» → `/notifications`, «Настройки» → `/settings»`).

Всё — запись на диск через file-bridge, **не git-коммит**. На этот раз
явно сверял mtime сразу после записи (после истории со срезом 4 — см.
раздел ниже) — все 13 файлов записались с ожидаемым размером, повторного
чтения с потерей правок не было.

Прогони, пожалуйста:

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short
git diff -- "apps/api/src/routes/blocks.ts" "apps/api/src/routes/profile.ts" "apps/mobile/src/api/blocks.ts" "apps/mobile/src/api/notifications.ts" "apps/mobile/src/api/reports.ts" "apps/mobile/src/api/me.ts" "apps/mobile/src/api/profile.ts" "apps/mobile/app/notifications.tsx" "apps/mobile/app/settings.tsx" "apps/mobile/app/blocked-users.tsx" "apps/mobile/src/components/ReportModal.tsx" "apps/mobile/app/(tabs)/profile.tsx" "apps/mobile/app/order/[id].tsx"
npm run typecheck -w @ustal/api
npm run typecheck -w @ustal/mobile
npm run lint -w @ustal/api
npm run lint -w @ustal/mobile
```

Если чисто — `git add`/`git commit` на своё усмотрение (можно объединить со
срезами 4–5 ниже, если они ещё не закоммичены). Пуш — только по явному
разрешению пользователя.

Допиши результат отдельным блоком ниже с пометкой "Codex:".

---

# AI_HANDOFF — 2026-09-05 (Claude Cowork, срез 5: голос и фото для профиля/заказа)

Продолжение (новое сверху, старое не трогаем). Примечание: предыдущая
попытка дописать раздел «срез 4» в этот файл, судя по всему, не
сохранилась на диске (при повторном чтении файла через file-bridge его не
оказалось) — записываю срезы 4 и 5 вместе сейчас, без предположений о
причине (возможно, гонка записи или что-то в редакторе/синхронизации на
твоей стороне). Если увидишь что-то похожее на потерю правок в будущем —
дай знать, стоит разобраться.

## Что сделано сейчас: VoiceRecorder, PhotoPicker, POST /media на клиенте

Backend (`POST /media`, `apps/api/src/routes/media.ts`) уже полностью
готов и совпадает с ожиданиями 1:1; `expo-av`/`expo-image-picker` уже были
в зависимостях `apps/mobile/package.json`, а разрешения (микрофон, камера,
галерея) — уже в `app.json` (`NSMicrophoneUsageDescription`,
`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`,
`RECORD_AUDIO`/`CAMERA`/`READ_MEDIA_IMAGES` для Android). Ничего из этого
не пришлось трогать — только клиентский код.

Добавлено/изменено (тонкий `apiClient` + `src/api/*.ts`-обёртки, как и
раньше):

- `packages/api-client/src/index.ts` — добавлен `ApiClient.uploadForm<T>`
  (multipart, без `Content-Type: application/json`, который `request<T>`
  всегда проставляет — boundary должен выставить сам `fetch`/`FormData`).
- `apps/mobile/src/api/media.ts` (новый) — `uploadMedia(kind, file)`,
  обёртка над `uploadForm` для `POST /media`.
- `apps/mobile/src/components/VoiceRecorder.tsx` (новый) — запись
  (`expo-av`, HIGH_QUALITY preset → `.m4a`, совпадает с
  `MEDIA_LIMITS.audio.mimeTypes` в `packages/validation/src/media.ts`),
  прослушивание, удаление, перезапись.
- `apps/mobile/src/components/PhotoPicker.tsx` (новый) — камера/галерея
  (`expo-image-picker`), каждое фото грузится сразу при выборе через
  `uploadMedia("photo", ...)`, в заказ уходит готовый `mediaId`.
- `apps/mobile/src/components/AiInputField.tsx` — переключается между
  текстовым полем и `VoiceRecorder` (голос и текст взаимоисключимы, как в
  ТЗ); новые пропсы `audioUri`/`onAudioRecorded`/`onAudioDeleted` вместо
  старого пустого `onStartRecording`.
- `apps/mobile/src/api/orders.ts` — `CreateOrderInput` разделён на
  `CreateOrderTextInput`/`CreateOrderVoiceInput` (union).
- `apps/mobile/src/api/profile.ts` — `submitProfileInput` принимает текст
  или `{inputType:"voice", audioMediaId}`.
- `apps/mobile/app/(tabs)/profile.tsx` — голосовой ввод грузится через
  `uploadMedia` перед `submitProfileInput({inputType:"voice", ...})`.
- `apps/mobile/app/(tabs)/create.tsx` — то же для голоса + добавлен
  `PhotoPicker`, `mediaIds` уходят в `createOrder`.
- `apps/mobile/app/(tabs)/index.tsx` — набранный текст/записанный голос с
  главного экрана передаётся в композер заказа через параметры маршрута
  вместо того, чтобы теряться при переходе (был баг: кнопка «Опубликовать
  заказ» игнорировала уже введённое).

Не сделано и намеренно (как и в облачной ветке на этом же этапе): экран
«проверка транскрипции» (раздел 9 ТЗ) — backend на этой машине делает
распознавание речи и AI-извлечение одним job'ом без паузы
(`profile-extraction.ts`/`order-extraction.ts`), split-пайплайна
(патчи 8-9) здесь нет — уже задокументировано в срезе 2 и в
`claude/mobile-audit.md`.

Всё — запись на диск через file-bridge, **не git-коммит**. Прогони,
пожалуйста:

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short
git diff -- "packages/api-client/src/index.ts" "apps/mobile/src/api/media.ts" "apps/mobile/src/components/VoiceRecorder.tsx" "apps/mobile/src/components/PhotoPicker.tsx" "apps/mobile/src/components/AiInputField.tsx" "apps/mobile/src/api/orders.ts" "apps/mobile/src/api/profile.ts" "apps/mobile/app/(tabs)/profile.tsx" "apps/mobile/app/(tabs)/create.tsx" "apps/mobile/app/(tabs)/index.tsx"
npm run typecheck -w @ustal/mobile
npm run lint -w @ustal/mobile
```

Если чисто — `git add`/`git commit` на своё усмотрение (можно объединить
со срезом 4 ниже в один коммит, раз оба ещё не закоммичены). Пуш — только
по явному разрешению пользователя.

Допиши результат отдельным блоком ниже с пометкой "Codex:" — и, если не
трудно, подтверди в том же блоке, видишь ли ты раздел "срез 4" ниже (про
экран заказа) на диске прямо сейчас, до моей текущей записи — это поможет
понять, было ли дело в гонке записи или в чём-то другом.

---

# AI_HANDOFF — 2026-09-05 (Claude Cowork, срез 4: экран заказа — кандидаты/контакты/выбор/отзывы)

Продолжение (новое сверху, старое не трогаем).

## Что сделано сейчас: единый экран `app/order/[id].tsx`

Backend здесь тоже оказался ПОЛНОСТЬЮ готов: прочитал реальные
`apps/api/src/routes/assignments.ts`, `contacts.ts`, `reviews.ts`,
`orders.ts` — все три роута (`order_assignments`/`contact_unlocks`/
`reviews`) уже существуют и на 100% совпадают с тем, что ожидала моя
облачная ветка (patch 4). Единственные два реальных пробела — оба
чисто аддитивные, без риска сломать что-то существующее:

- `GET /my/responses` не отдавал `orderAuthorId`/`assignmentStatus` —
  исполнителю неоткуда было узнать id автора заказа (нужен для
  отзыва/раскрытия контакта) и завершена ли работа.
- `GET /orders/{id}/responses` отдавал `assignmentStatus`, но не сам
  `assignmentId`, а он обязателен для `.../complete` и `.../not-completed`.

Закрыл оба точечными правками (только новые поля в ответе, ни одного
существующего поля/строки не тронул):

- `apps/api/src/routes/my.ts` — добавлены `orderAuthorId`,
  `assignmentStatus` в `GET /my/responses`.
- `apps/api/src/routes/responses.ts` — добавлен `assignmentId` в
  `GET /orders/{id}/responses`.

Мобильная сторона — под те же соглашения репозитория (тонкий `apiClient`
+ отдельные `src/api/*.ts`-обёртки на каждый домен, а не толстый класс с
доменными методами, как в моей ветке):

- `packages/api-client/src/index.ts` — добавлен класс `ApiRequestError`
  (сохраняет HTTP-статус и код ошибки), `request<T>` теперь бросает его
  вместо голого `Error`. Нужно экрану заказа, чтобы отличить штатный 404
  «вы не автор этого заказа» (переключение на вид кандидата) от настоящей
  сетевой ошибки.
- `apps/mobile/src/api/orders.ts` — добавлены типы `ResponseStatus`,
  `AssignmentStatus` (переиспользуются в `my.ts`/`responses.ts`/
  `assignments.ts`).
- `apps/mobile/src/api/responses.ts` (новый) — `createResponse`,
  `getOrderCandidates`, `withdrawResponse`.
- `apps/mobile/src/api/contacts.ts` (новый) — `unlockContact`,
  `getOrderContact`.
- `apps/mobile/src/api/assignments.ts` (новый) — `selectCandidate`,
  `closeOrder`, `completeAssignment`, `markAssignmentNotCompleted`.
- `apps/mobile/src/api/reviews.ts` (новый) — `submitReview`.
- `apps/mobile/src/api/my.ts` — `MyResponseItem` расширен полями
  `orderAuthorId`/`assignmentStatus`.
- `apps/mobile/app/order/[id].tsx` (новый) — единый экран без выбора
  роли (architecture.md §2): автор видит карточку + кандидатов + раскрытие
  контакта + выбор исполнителя + закрытие заказа + отметку
  выполнено/не выполнено + форму отзыва; не-автор (кандидат/исполнитель)
  получает 404 на `GET /orders/{id}` — штатный путь, экран переключается
  на форму отклика или, если отклик уже есть, на статус с раскрытием
  контакта автора и отзывом. Карточка заказа для вида кандидата берётся
  из параметров навигации (передаются из ленты), а не с сервера — сервер
  её не отдаёт не-автору.
- `apps/mobile/app/(tabs)/orders.tsx` и `.../responses.tsx` — карточки/
  строки теперь ведут на `/order/[id]` (`router.push`).

Сознательно НЕ трогал `apps/mobile/app/_layout.tsx`: в моей ветке (patch 4)
там правился guard, чтобы защищать любой маршрут вне auth-флоу, а не
только `(tabs)`. На этой машине `_layout.tsx` устроен проще (нет
редиректа неавторизованных прочь из защищённых маршрутов вообще — только
редирект авторизованных в `(tabs)` при старте), и обычная навигация не
даёт способа попасть на `/order/[id]` иначе как из `(tabs)`, которые и так
недостижимы без входа. Если это когда-то станет проблемой (например,
deep link) — стоит вернуться к этому отдельной задачей, я специально не
трогал файл, чтобы не расширять зону изменений сверх необходимого.

Всё — запись на диск через file-bridge, **не git-коммит**. Прогони,
пожалуйста:

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short
git diff -- "packages/api-client/src/index.ts" "apps/api/src/routes/my.ts" "apps/api/src/routes/responses.ts" "apps/mobile/src/api/orders.ts" "apps/mobile/src/api/my.ts" "apps/mobile/src/api/responses.ts" "apps/mobile/src/api/contacts.ts" "apps/mobile/src/api/assignments.ts" "apps/mobile/src/api/reviews.ts" "apps/mobile/app/order/[id].tsx" "apps/mobile/app/(tabs)/orders.tsx" "apps/mobile/app/(tabs)/responses.tsx"
npm run typecheck -w @ustal/api
npm run typecheck -w @ustal/mobile
npm run lint -w @ustal/api
npm run lint -w @ustal/mobile
```

Особо интересно: не ругается ли typecheck на `apps/mobile/app/order/[id].tsx`
(expo-router динамический маршрут, новый файл — первый раз создаю файл
внутри новой директории `app/order/` через file-bridge, стоит убедиться,
что путь и расширение легли верно) и не конфликтует ли новый
`ApiRequestError` с чем-то, что уже могло появиться в
`packages/api-client/src/index.ts` помимо того, что я видел при чтении.

Если чисто — `git add`/`git commit` на своё усмотрение (можно все пять
срезов одним коммитом или раздельно). Пуш — только по явному разрешению
пользователя.

Допиши результат отдельным блоком ниже с пометкой "Codex:".

---

# AI_HANDOFF — 2026-09-05 (Claude Cowork, срез 3: заказы/лента/отклики)

Продолжение (новое сверху, старое не трогаем).

## Что сделано сейчас: создание заказа, лента, мои заказы, мои отклики

Прочитал реальные `apps/api/src/routes/orders.ts`, `feed.ts`, `my.ts` и
`packages/validation/src/orders.ts` — backend здесь ПОЛНОСТЬЮ готов
(`POST /orders`, `GET /orders/{id}`, `POST /orders/{id}/publish`/`cancel`,
`GET /feed`, `GET /my/orders`, `GET /my/responses`) и контракт совпал 1:1 с
тем, что я ожидал по своей ветке. Экраны `create.tsx`/`orders.tsx`/
`responses.tsx` на этой машине были нетронутыми Фаза-1 заглушками (ни
одного реального запроса) — конфликтов с чем-либо не было, чистая новая
работа.

Добавлено, под те же соглашения репозитория (тонкий `apiClient` +
`src/api/*.ts`, без `expo-crypto` — см. срез 2):

- `apps/mobile/src/api/orders.ts` — `createOrder`/`getOrder`/`publishOrder`/
  `cancelOrder`.
- `apps/mobile/src/api/feed.ts` — `getFeed`.
- `apps/mobile/src/api/my.ts` — `getMyOrders`/`getMyResponses`.
- `apps/mobile/src/lib/query-string.ts` — общий хелпер пагинации
  (`?limit=&offset=`), переиспользуют `feed.ts`/`my.ts`.
- `apps/mobile/app/(tabs)/create.tsx` — композер (текст) → `POST /orders`
  → поллинг `GET /orders/{id}` до решения модерации → предпросмотр с
  контекстными чипами → явная кнопка «Опубликовать» (публикация никогда не
  автоматическая) → `moderation_hold` показывает отдельный экран вместо
  публикации.
- `apps/mobile/app/(tabs)/orders.tsx` — два режима одного таба: «Лента»
  (`GET /feed`, использует уже готовый `OrderCard.tsx`, который до этого
  нигде не был подключён) и «Мои заказы» (`GET /my/orders`).
- `apps/mobile/app/(tabs)/responses.tsx` — реальный список
  `GET /my/responses` вместо статичного текста.

Вне рамок этого среза (как и в моей ветке на этом же этапе): фото/голос при
создании заказа, экран деталей заказа (`order/[id].tsx` — кандидаты,
контакты, отклик, отзывы). Это следующий срез.

Всё — запись на диск через file-bridge, **не git-коммит**. Прогони,
пожалуйста:

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short
git diff -- "apps/mobile/app/(tabs)/create.tsx" "apps/mobile/app/(tabs)/orders.tsx" "apps/mobile/app/(tabs)/responses.tsx" "apps/mobile/src/api/orders.ts" "apps/mobile/src/api/feed.ts" "apps/mobile/src/api/my.ts" "apps/mobile/src/lib/query-string.ts"
npm run typecheck -w @ustal/mobile
npm run lint -w @ustal/mobile
```

Если чисто — `git add`/`git commit` на своё усмотрение (можно все три среза
одним коммитом или раздельно). Пуш — только по явному разрешению
пользователя.

Допиши результат отдельным блоком ниже с пометкой "Codex:".

---

# AI_HANDOFF — 2026-09-05 (Claude Cowork, срез 2: AI-профиль текстом)

Продолжение раздела чуть ниже (тот же формат: новое сверху, старое не
трогаем). Важная поправка к тому, что я думал раньше: то, что выглядело
как «отдельная параллельная ветка backend-работы» на этой машине — на
самом деле тот же `origin/main@7509e9d`, что и в моей облачной ветке. Я
нашёл в этом же файле ниже запись от МОЕЙ ЖЕ более ранней облачной сессии
(другая сессия, тот же проект USTAL) — она и реализовала весь 8-фазный
backend и запушила его. Никакого сюрприза, извиняюсь за путаницу в
предыдущем разделе. Единственное, что на этой машине сделано параллельно
и независимо от моей ветки — мобильная авторизация (`16d45e0`), уже
сверена и закрыта (см. раздел ниже).

## Что сделано сейчас: AI-профиль, текстовый ввод

Прочитал реальные `apps/api/src/routes/profile.ts` и
`packages/validation/src/profile.ts` — backend здесь на СТАРОМ атомарном
пайплайне (`POST /profile/inputs` → сразу `processing`, `GET /profile` без
draft/apply). Split-пайплайна для экранов 9/10 (пауза «проверка
транскрипции» + блокирующее подтверждение AI-правок) на этой машине НЕТ
вообще — ни `/profile/inputs/{id}`, ни `/profile/draft`. Это единственный
кусок моей облачной ветки, который здесь действительно отсутствует, а не
дублирует уже сделанное — будет отдельной задачей позже.

Для текстового AI-профиля (без экрана 9/10 — тексту пауза транскрипции не
нужна) добавил, под существующие соглашения этого репозитория (тонкий
`apiClient` + обёртки в `src/api/*.ts`, как `auth.ts`/`cities.ts`, а не
толстый класс с доменными методами, как в моей ветке):

- `apps/mobile/src/api/profile.ts` — `getProfile()` (GET /profile),
  `submitProfileInput()` (POST /profile/inputs).
- `apps/mobile/src/lib/idempotency-key.ts` — простой `Date.now()+Math.random()`
  ключ вместо `expo-crypto` (его нет в зависимостях `apps/mobile/package.json`
  на этой машине — не стал добавлять новый нативный пакет вслепую, без
  возможности самой прогнать `npm install`/rebuild и проверить).
- `apps/mobile/app/(tabs)/profile.tsx` — композер поверх уже
  существовавшего на этой машине `AiInputField.tsx` (интерфейс совпал 1:1
  с тем, что я использовал в своей ветке) + поллинг `GET /profile` через
  уже подключённый `@tanstack/react-query` до роста `profileVersion`, показ
  summary/капабилити при наличии профиля. Кнопка «Выйти» из прошлого среза
  сохранена.

Всё это — запись на диск через file-bridge, **не git-коммит** (нет
shell-доступа). Прогони, пожалуйста:

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short
git diff -- "apps/mobile/app/(tabs)/profile.tsx" "apps/mobile/src/api/profile.ts" "apps/mobile/src/lib/idempotency-key.ts"
npm run typecheck -w @ustal/mobile
npm run lint -w @ustal/mobile
```

Особо интересно: не ругается ли typecheck на `apiClient.request` без
generic-параметра нигде (я типизировал явно `<ProfileResponse>`/
`<SubmitProfileInputResult>` в новых функциях) и не конфликтует ли
`src/lib/idempotency-key.ts` с чем-то уже существующим в `src/lib/`, если
там уже что-то есть — я создавал файл вслепую, не видя, есть ли там
что-то ещё.

Если всё чисто — `git add`/`git commit` на своё усмотрение по каждому
файлу или всем сразу. Пуш в GitHub — только после явного разрешения
пользователя, не автоматически.

Допиши, пожалуйста, результат отдельным блоком ниже с пометкой "Codex:" —
я прочитаю через file-bridge на следующем шаге. Если что-то не
типчекается/не линтится — тоже напиши, что именно, я поправлю.

---

# AI_HANDOFF — 2026-09-05 (Claude Cowork: канал связи с Codex установлен)

Это отдельная облачная Claude-сессия (Cowork) — не та, что писала запись от
2026-09-02 ниже. Работаю в этом репозитории через file-bridge на машине
пользователя (`device_stage_files`/`device_commit_files`): могу точечно
читать и записывать конкретные файлы, но не имею прямого shell/git доступа
(`device_bash` сейчас недоступен на этой машине: "Workspace unavailable —
the isolated Linux environment failed to start"). Раздел от 2026-09-02 ниже
оставлен без изменений — не проверял его текущий статус (тикет #12588523,
`ustal-seed-idempotent.bundle`), не трогал.

## Установлен формальный канал: AGENTS.md + этот файл

Добавлен `AGENTS.md` в корне репозитория — описывает роли (Claude = primary
software engineer, пишет код и правит файлы через file-bridge; Codex =
terminal/browser/QA, выполняет команды) и жёсткие правила (без force push /
`reset --hard` / автопуша в GitHub / удаления untracked-файлов без явного
разрешения пользователя). Codex, пожалуйста, прочитай его при старте
работы в этом репозитории.

Дальше в этом файле — по образцу раздела 2026-09-02 ниже: новое сверху,
старое не удаляется, пока автор явно не разрешит убрать раздел.

## Задача для Codex сейчас: проверить один файл (мобильная авторизация)

Контекст: на этой машине (`main`, не запушен в `2959427-eng/Ustal`) уже
есть независимая реализация мобильного входа/регистрации/сессии/push
(коммит `16d45e0`), функционально эквивалентная тому, что я параллельно
собрал в облачной ветке `mobile/real-auth-flow` (9 патчей поверх `7509e9d`,
переданы пользователю файлами — GitHub push из облачной сессии заблокирован
её собственным git-прокси). Сверил файл-за-файлом
(`login.tsx`/`register.tsx`/`select-city.tsx`/`client.ts`/`session.ts`/
`packages/api-client`/`packages/validation/src/auth.ts`) — они эквивалентны,
расходиться в архитектуре не о чем. Единственный реальный пробел: в
`apps/mobile/app/(tabs)/profile.tsx` не было кнопки «Выйти» — `logout()` в
`src/api/auth.ts` был готов, но ниоткуда не вызывался.

Я дописал в `profile.tsx` кнопку «Выйти» (вызывает существующий `logout()`,
затем `router.replace("/onboarding")`) и записал файл на диск через
file-bridge — **без git-коммита** (нет shell-доступа для `git add`/`commit`
с моей стороны). Прогони, пожалуйста:

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short
git diff -- "apps/mobile/app/(tabs)/profile.tsx"
npm run typecheck -w @ustal/mobile
npm run lint -w @ustal/mobile
```

(Репозиторий на `npm`-воркспейсах, не `pnpm`.)

Если всё чисто — можно `git add`/`git commit` (например,
`mobile: добавить кнопку выхода в profile.tsx`). Пуш в GitHub — только
после явного разрешения пользователя в диалоге, не автоматически.

Допиши, пожалуйста, результат отдельным блоком ниже с пометкой "Codex:" —
я прочитаю его через file-bridge на следующем шаге.

---

# AI_HANDOFF — 2026-09-02 (обновление после закрытия relay/S3 + фикс db:seed)

Это заметка от Claude (облачная песочница, без доступа к GitHub PAT и
реальным ключам/секретам). Перезаписывает предыдущую версию этого файла —
та отражала состояние ДО того, как вы с Codex вписали настоящий OpenAI-ключ
на relay и создали нового S3-пользователя `ustal-app-media-codex`.

## Статус на сейчас (проверено мной по реальным командам/выводам, не с ваших слов)

Закрыто:

1. **Git/онтология** — `7509e9d` (расширение до 124 узлов / 138 синонимов)
   подтверждён на `origin/main`.
2. **OpenAI relay (Amsterdam, 195.133.40.91)** — настоящий `OPENAI_API_KEY`
   вписан, `verify-relay.sh` прошёл: неавторизованный запрос блокируется,
   авторизованный доходит до OpenAI.
3. **S3 (Timeweb Object Storage, бакет `ustal-media`)** — closed через нового
   пользователя `ustal-app-media-codex` (у исходного `ustal-app-media` UI
   дважды не показал Secret Key после сброса — известный баг панели, не
   наша ошибка). `verify-app-storage.sh` прошёл: "App container verified
   Timeweb S3 bucket access: ustal-media." Старый пользователь
   `ustal-app-media` не удалён — можно деактивировать/удалить позже,
   не срочно.

Открыто:

4. **Внешняя сеть на `ustal-app-msk` (Москва, 147.45.141.94)** — HTTP/HTTPS
   снаружи не отвечают (60-секундный таймаут, не "connection refused"),
   при этом ВСЁ проверенное внутри сервера в порядке: контейнеры здоровы
   (`docker compose ps`), Caddy слушает `0.0.0.0:80`/`:443` (`ss -tlnp`),
   UFW разрешает 22/80/443, firewall-группа Timeweb `USTAL app web access`
   привязана к серверу с верными правилами, IP реально висит на `eth0`,
   маршрут по умолчанию верный, исходящий IP совпадает (`curl ifconfig.me`).
   Вывод: проблема на стороне провайдера/сети Timeweb, не на VPS. Заведён
   тикет **#12588523**. Первый ответ поддержки был отпиской (перепутали
   безобидный ICMP-таймаут с реальной проблемой TCP 80/443, сами не
   проверяли порты снаружи) — им отправлен твёрдый уточняющий ответ с
   просьбой сделать реальную проверку портов снаружи (nmap) и посмотреть
   провайдерскую фильтрацию/DDoS-защиту. Ждём содержательный ответ.

## Новое: `ustal-seed-idempotent.bundle` — обязательно применить перед следующим деплоем

Пока сетевой тикет висит, я проверил, безопасно ли просто взять и
задеплоить текущий код на Moscow-сервер (SSH туда работает независимо от
внешнего HTTP/HTTPS блокера). Нашёл реальный баг:
`infra/timeweb/scripts/deploy-app.sh` безусловно вызывает `npm run db:seed`
при каждом деплое, а `packages/database/src/seed.ts` (в составе уже
применённого `7509e9d`) делает плоские `.insert()` без проверки уже
существующих строк. `ontology_nodes.canonical_key` имеет `unique()` в
schema.ts — то есть повторный `db:seed` на уже засеянной боевой базе
(сейчас там 3 города / 26 узлов онтологии, старая версия) упал бы с
ошибкой уникальности Postgres и оставил бы новые 98 узлов невставленными.

Исправлено в `ustal-seed-idempotent.bundle` (один коммит поверх `7509e9d`,
без конфликтов, не трогает ничего кроме `packages/database/src/seed.ts`):
теперь вставляются только действительно новые города/узлы/синонимы, плюс
отдельным шагом реконсилируется подпись (`nameRu`) у уже существующих
узлов — иначе косметическое переименование `electrical_work` и `gas_work`
(сделанное в `7509e9d`) не применилось бы на уже засеянной базе.
`canonicalKey`/`regulated`/`riskLevel` НЕ переписываются автоматически —
это осознанное решение об онтологии, а не опечатка.

Проверено на реальном PostgreSQL 16 (три сценария): чистая база даёт
прежний результат (124/138); повторный запуск той же базы — 0 дублей,
0 ошибок; симуляция реального апгрейда (старый seed на 25/26 узлах →
новый seed) — корректно добавляет только 98 новых узлов и обновляет
2 устаревшие подписи, без потери данных и без падений.

### Как применить (Codex, `C:\Users\User\Desktop\ustal-foundation`)

```powershell
cd C:\Users\User\Desktop\ustal-foundation
git status --short --branch   # должно быть чисто, main == origin/main (7509e9d)
git bundle verify "C:\Users\User\Desktop\ustal-seed-idempotent.bundle"
git fetch "C:\Users\User\Desktop\ustal-seed-idempotent.bundle" seed-idempotent-onto-main:seed-idempotent-onto-main
git log --oneline seed-idempotent-onto-main -1   # "Сделать db:seed идемпотентным..."
git merge --ff-only seed-idempotent-onto-main    # fast-forward, без конфликтов
git push origin main
```

### Дальше — передеплой на Moscow-сервере (можно делать прямо сейчас, не дожидаясь тикета)

```bash
ssh -J root@195.133.40.91 root@147.45.141.94
cd /opt/ustal-foundation
git pull --ff-only
cd infra/timeweb/app
bash ../scripts/deploy-app.sh
```

**Важно предупредить заранее**: последняя строка `deploy-app.sh` —
`curl -fsS "https://${API_DOMAIN}/health"` — упадёт из-за всё ещё открытого
сетевого блокера (тикет #12588523), и скрипт из-за `set -euo pipefail`
завершится с ошибкой именно на этой строке. Это ОЖИДАЕМО и не новая
проблема: всё до неё (build, migrate, **db:seed теперь безопасен**,
db:seed-admin) к этому моменту уже отработает успешно. Проверять успех
нужно изнутри контейнера, например:

```bash
docker compose -f docker-compose.prod.yml exec -T api node -e \
  "fetch('http://localhost:4000/health').then(async r=>console.log(r.status, await r.text()))"
```

и убедиться, что новых узлов онтологии стало 124 (было 26):

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM ontology_nodes;"
```

## Что дальше

- Мониторить ответ Timeweb по тикету #12588523 — это единственное, что
  реально блокирует внешний доступ (HTTPS/ACME) к Moscow-серверу.
- После ответа Timeweb — либо Caddy сам получит сертификат Let's Encrypt
  (если дело было в фильтрации 80/443), либо потребуется следующий шаг от
  провайдера.
- Не удалять старого S3-пользователя `ustal-app-media` до явного решения —
  просто неиспользуемый, не мешает.
