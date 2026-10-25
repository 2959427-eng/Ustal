# USTAL: инструкции для Apple / Google (не отправлены)

## Утверждённая модель первого запуска — 2026-10-24

Владелец и оператор персональных данных — физическое лицо Ким Дмитрий Эдуардович; целевая территория — Россия, аудитория — 18+. Это не изменение страны проживания оператора или подтверждение применимого права.

Регистрация, профили, навыки, ресурсы, заказы, отклики и подбор в первом публичном запуске USTAL полностью бесплатны для заказчиков и исполнителей. Комиссия платформы — 0%. Подписок и платного продвижения нет.

Store metadata: приложение бесплатное; цифровые покупки, подписки и платное продвижение не заявляются. Не добавлять фиктивные тарифы, комиссии или платёжные сценарии. Цена работ между участниками не является комиссией платформы. Privacy/Data Safety по-прежнему заполняются по фактическому сбору данных: бесплатность не означает отсутствие сбора.

Модель утверждена, но это не утверждение всего юридического пакета и не разрешение на публикацию. Остальные решения о данных, сроках хранения и правовых основаниях остаются отдельными gates.


2026-10-21. Сверять с `data-inventory-20261021.md` и новым фактическим build. Это предварительное заполнение; оставшиеся неизвестные нельзя отмечать «No» ради submission.

## Apple App Store Connect

Идентификация: только USTAL /ru.ustal.app /6824967297 /Team2KX955DCB8. Аккаунт Dmitrii Kim можно переиспользовать, WedLink listing/signing profile/privacy нельзя.

|Поле|Подготовленный ответ / препятствие|
|---|---|
|Privacy Policy URL|Утверждённый постоянный origin + `/privacy`; live URL пока нет|
|Support URL|Тот же origin + `/support`; финальный email отсутствует|
|Privacy choices/deletion URL|`/delete-account`; в приложении account → delete; после будущей публикации backend|
|Does app collect data?|YES: сервер хранит account-linked данные; не «Data not collected»|
|Contact Info|Name, Phone Number; WhatsApp тоже телефон. Email не отдельное штатное registration поле; support email пользователя при обращении считать Customer Support/Contact Info при фактическом сборе|
|Identifiers|User ID YES. Push/installation identifier классифицировать по текущей definition Device ID; не путать с IDFA, которого в коде не найдено|
|Location|Coarse: выбранный город. GPS не запрашивается. Точный адрес возможен в свободном тексте; нет отдельного lat/lon поля. Перед ответом Precise Location проверить фактические screens/payloads и правила формы; не обещать отсутствие location вообще|
|User Content|Photos, Audio Data, Other User Content, Customer Support (обращения/жалобы) — функциональность; связаны с аккаунтом|
|Diagnostics|Other Diagnostic Data при фактическом logging запросов/errors/usage; не заявлять Crashlytics/Sentry, которых не найдено в прямых mobile dependencies|
|Financial Info|Карт, банковских счетов и payment SDK не найдено. Цена/согласованная услуга — оценить Purchase History по текущему вопросу формы, не заявлять обработку card details|
|Sensitive Info|Не цель сбора по выделенным полям. AI profile facts и свободный текст могут содержать чувствительные сведения; пройти actual fact taxonomy и определить необходимые категории до final labels, не обещать что «не собирается»|
|Data Linked to You|YES для account/profile/content/orders/push и связанных traces; irreversible unlinking не доказан|
|Purposes|App Functionality; security/account management/support относятся к соответствующим functionality purposes. Advertising/marketing не обнаружены. AI cost logs — техническая диагностика, не доказательство user-behavior analytics|
|Tracking|NO по inspected app/SDK: нет IDFA, ads SDK, ATT или cross-company ad tracking. Перепроверить утверждённые условия relay/upstream; не считать server data sharing отсутствующим|
|Third-party AI|Фактические provider/relay/передаваемые data + явное permission до отправки; текущий OFF не соответствует этой гарантии. Не включать без отдельного разрешения|
|Age rating|Не выбирать минимальный возраст за владельца. Заполнить questionnaire по UGC, обмену контентом, регулируемым услугам и safety controls; итог рассчитывает Apple. Target age policy ещё не утверждена|
|Encryption|В iOS config usesNonExemptEncryption=false; код использует OS TLS/Keychain, custom non-exempt crypto не найдено. Это не declaration «данные не шифруются». Повторно сверить фактический binary/SDK перед submission|

`PrivacyInfo.xcprivacy` с required-reason API не заменяет App Privacy labels о серверной обработке.

### Draft review notes (после закрытия gaps)

«USTAL — платформа задач и услуг; AI извлекает профиль и рекомендует соответствия, не гарантирует квалификацию или безопасность услуги. Для проверки используйте отдельный согласованный reviewer account (credentials передать только через защищённое App Review поле, не git). Deletion: Account → Удалить аккаунт → повторный пароль; in_progress409 требует урегулирования/поддержки. Reports: карточка заказа/пользователя/отклика; block и admin moderation. Privacy/Terms/Support: ссылки на login и account. Веб-удаление: утверждённый URL». Не утверждать reviewer account/consent/moderation PASS, пока действительно не проверено. Demo account, инструкции и backend должны работать во время review. Никакие реальные пользовательские credentials в отчёт не включать.

## Google Play Console

|Раздел|Подготовленный ответ / препятствие|
|---|---|
|Privacy Policy|Постоянный public HTML `/privacy`, не PDF, не login-gated; пока не опубликовано|
|Does app collect or share required data types?|YES collect; данные покидают устройство и хранятся. Не ephemeral: DB/S3/backups|
|Data collected|Name, phone, User IDs; approximate location/city; photos, voice/audio, other user content; device/other IDs для push; diagnostics согласно фактическим logs. Sensitive/financial/precise-location answers по отдельной фактической проверке в matrix|
|Required/optional|Name/phone/city/account ID — для регистрации. About/avatar/WhatsApp/photo/voice/push — optional feature inputs; plain text альтернатива голосу; deny permissions должен сохранять основные функции|
|Purposes|App functionality, account management, developer communications (transactional push/support), fraud prevention/security where implemented. Не добавлять ads/analytics purpose без evidence|
|Shared|Различать collection и sharing. Service-provider exception допустима только после проверки contractual role фактического relay/upstream/S3/push. User-initiated contact disclosure учесть по definitions формы; не превращать каждую peer-передачу в рекламный sharing и не скрывать передачу AI|
|Encrypted in transit|HTTPS app→API подтверждён production config; AI relay и S3 endpoints HTTPS. Для final YES проверить все реальные SDK/media/push paths и redirects, не только main API; наличие ATS arbitraryLoads в generated plist само по себе не доказывает фактический cleartext transfer|
|Deletion|Account creation YES; deletion request supported in app YES. External URL `/delete-account` после публикации; нужно фактическое доступное удаление без reinstallation и support для409/lost access|
|Retained data|Честно перечислить history/source/reviews/reports/audit/backups/derived cache; сроки пока не утверждены; не ставить complete erasure|
|Independent security review|Не заявлять проведённым официальным независимым certification по локальным tests|
|Permissions|Camera/gallery/mic/push по функциям; GPS/contacts не нужны. Проверить merged Android manifest; broad READ_MEDIA_IMAGES/storage не выдавать за автоматически разрешённые для occasional picker use. Перед Android submission подтвердить Photo Picker policy и минимальный manifest|
|App access|Reviewer credentials и пошаговые инструкции нужны для gated features; SMS не требуется в текущем auth scope|
|Content rating/Target audience|UGC/forms по фактическому поведению; владелец утвердил аудиторию 18+ и первый запуск в России. Не заявлять Families/kids; возрастной рейтинг магазина заполняется отдельно по фактическому контенту|
|AI-generated content|Проверить scope policy для конкретного интерфейса: matching не chatbot автоматически. Если rendered generated descriptions попадают в scope, нужен in-app flag без выхода; текущий own-profile AI issue не имеет специального target. Support email сам по себе не доказывает такое соответствие|
|Closed testing|Для Personal accounts после2023-11-13:12testers opt-in непрерывно14дней, затем application for production access; факт выполнения для этого аккаунта не проверялся здесь|

## Перед подачей

Не вносить эти draft ответы в store автоматически. Утвердить decisions, закрыть7групп gaps, опубликовать разрешённые документы, проверить страны/HTTPS и real device build2, затем ещё раз сверить декларации с фактическим artifact. Checklist URL/код/публичное утверждение не равнозначны.

Источники: Apple https://developer.apple.com/app-store/app-privacy-details/ и https://developer.apple.com/app-store/review/guidelines/ ; Google https://support.google.com/googleplay/android-developer/answer/10787469 , https://support.google.com/googleplay/android-developer/answer/13327111 , https://support.google.com/googleplay/android-developer/answer/14094294 , https://support.google.com/googleplay/android-developer/answer/14151465 . Проверены2026-10-21; правила/анкеты могут обновляться.
