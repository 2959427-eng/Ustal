> Исторический отчёт исходной ветки. Актуальный результат объединения и совместных проверок: [store-consent-integration-20261024.md](store-consent-integration-20261024.md).

## Утверждённая модель первого запуска — 2026-10-24

Владелец — физическое лицо; целевая территория — Россия, аудитория — 18+. Это не изменение страны проживания оператора или подтверждение применимого права.

Регистрация, профили, навыки, ресурсы, заказы, отклики и подбор в первом публичном запуске USTAL полностью бесплатны для заказчиков и исполнителей. Комиссия платформы — 0%. Подписок и платного продвижения нет.

Store metadata: приложение бесплатное; цифровые покупки, подписки и платное продвижение не заявляются. Не добавлять фиктивные тарифы, комиссии или платёжные сценарии. Цена работ между участниками не является комиссией платформы. Privacy/Data Safety по-прежнему заполняются по фактическому сбору данных: бесплатность не означает отсутствие сбора.

Модель утверждена, но это не утверждение всего юридического пакета и не разрешение на публикацию. Остальные решения о данных, сроках хранения и правовых основаниях остаются отдельными gates.


# USTAL: фактическая privacy / store готовность

Дата проверки: 2026-10-21. Ветка `codex/store-compliance-20261021`, base iOS `db335874fee03d8ef472a617f8054ac79d34ff5d`, main/production `f8b610db7b27c156600fa5dea32e4c4236d9b876`. Не относится к WedLink.

## Итог и границы

**BLOCKED для public/store submission.** Это не отзыв успешной компиляции IPA1.0.0(1). Новые mobile-ссылки требуют отдельной сборки с новым build number, планируется2. Build1 не изменён. Ничего не публиковалось; main, Apple/Google declarations, Timeweb и consent mode не менялись.

Фактически production: provider=openai; endpoint origin `https://195-133-40-91.sslip.io` (relay); S3 endpoint `https://s3.timeweb.cloud`; consent=off. Регионы хранения и юридические лица relay/upstream по hostname НЕ установлены. Нельзя называть relay самим OpenAI или приписывать ему условия OpenAI. Пять требуемых публичных URL сейчас возвращают404 (внутренний read-only HTTP из API container). Доступность из разных стран не доказана.

## Подтверждённые store gaps (7 групп)

1. **Документы/контакт/URL не финализированы и не опубликованы.** Оператор — физическое лицо Ким Дмитрий Эдуардович; ранее подтверждённая страна — South Korea. Отдельный support email, постоянный origin, основания и retention не утверждены; возраст 18+ и Россия утверждены 2026-10-24. Нельзя публиковать текущие draft тексты с TBD. Публичное размещение требует отдельного разрешения.
2. **AI permission при OFF.** `apps/api/src/app.ts` регистрирует consent routes только в enforced; worker/AI имеют механизм enforcement, но он не активен. Нельзя заявить, что любой outbound требует действующего consent. Apple5.1.2(i) прямо включает third-party AI. Нужны подтверждённая цепочка получателей, конкретное раскрытие и отдельное решение об активации; эта ветка ничего не переключает.
3. **UGC acceptance отсутствует.** В `app/(auth)/register.tsx` и upload/create flows нет принятия утверждённых Terms/community policy до UGC. Google UGC требует принятия. Не добавляли фиктивную галочку к неутверждённым условиям. Следующий технический scope после утверждения текста: versioned acceptance до первой отправки UGC, с проверкой сервера, без смешения с AI consent.
4. **Moderation coverage/операции не доказаны для всех surface.** `reports.ts`, `blocks.ts`, admin reports/moderation и order text moderation существуют. ReportModal позволяет report order/user/response. Предварительная фильтрация profile/about/photo/review и конкретный регламент своевременного реагирования не подтверждены; report на собственный user отвергается, собственного AI-profile target нет. Для Apple1.2 нужен доказанный end-to-end фильтр/реакция/контакт. Для Google AI policy отдельно подтвердить применимость: основной продукт matching, не generative chatbot; не выдавать это за автоматическое исключение для любого AI output.
5. **Deletion обещания/retention не закрыты.** Самостоятельное DELETE/me безопасно реализовано, но history/source text и некоторые производные/служебные записи остаются. Для них нужны действительные основания/сроки, а не обещание «всё удаляется». При409 нужен реальный support процесс проверки личности и урегулирования, без обхода active-work guard. Не утверждать SLA до согласования.
6. **Новый mobile candidate и device acceptance.** Build1 не содержит ссылок. Ветка добавляет их в login/account. Нужны integration review, backend legal publication и отдельный build2 с проверкой ссылок/permissions/deletion на устройстве. Текущие новые ссылки ещё не работают на production404; локальный renderer PASS не равен public URL PASS.
7. **Store declarations, permissions и store actions.** App Privacy/Data Safety, возрастные анкеты, review account/notes, screenshots, final URLs и тексты ещё не отправлены. Для существующего Google Personal account ранее отмечено closed testing12/14: проверить фактическое требование в Console, пройти непрерывные14дней с12opt-in testers и запросить production access, если оно применяется к этому аккаунту. Запуск теста/подача не выполнялись.

## Что уже есть

- Удаление в приложении с повторным паролем, controlled403/409/429, logout только после успешного ответа; `app/delete-account.tsx`, `src/api/account-deletion.ts` (если имя модуля изменено — follow import в screen).
- `apps/api/src/routes/me.ts`, `lib/account-deletion.ts`, migrations0026/0027: deleted-user guard, транзакция, session/device purge, matching_candidates/traces purge, отмена queued profile jobs, durable media cleanup. Активная работа блокирует удаление409. Это не новая реализация deletion в этой ветке.
- Локальный web flow переиспользован из d94aba9: те же `/auth/login`, `/me`, `DELETE/me`; без email-only удаления, обхода пароля или privileged endpoint. Access/refresh только в памяти страницы; XSS-safe textContent; no localStorage; timeout/redirect guard; подтверждение только204; no automatic DELETE retry; single-flight.
- Жалобы/блокировка пользователя и admin resolution существуют; это не доказательство полного UGC соответствия или установленного времени реакции.
- iOS1.0.0(1), bundle ru.ustal.app, отдельные USTAL provisioning/project; Apple signing не менялся. SMS по продуктовому решению post-launch, не объявлен blocker.

## Публикационная архитектура (подготовлена, OFF)

Единственный источник текстов: `apps/api/src/legal/pages.ts`; он же генерирует HTML и draft Markdown. Пять top-level routes, без регистрации: `/privacy`, `/terms`, `/community-guidelines`, `/delete-account`, `/support`; CSS и deletion JS same-origin. Mobile-responsive CSS, escaped values, CSP без inline JS/style, no-store/no-referrer/frame denial, без трекеров/CDN/form processor.

Локальная среда:200 draft preview. Production без `USTAL_LEGAL_PUBLICATION_FILE`: routes не публикуются (404), а не ложная финальная политика/503. Это намеренный release gate, **не выполнение требования live URLs**. Неверный указанный файл не допускает старт. Утверждённый JSON должен содержать `approved:true`, version, effectiveDate, supportEmail, publicOrigin, agePolicy, territories, retention, backupRetention, processors, processingLocations, legalBasis, activeWorkSupport. Validator проверяет форму, не может доказать правдивость или юридическое одобрение этих значений; перед включением требуется review владельца.

Не создавать «approved fixture» на production. Test-only config не является утверждённой политикой. Retention parser разделяет6категорий, не удаляет данные, не запускает cron и не приписывает срок по умолчанию.

План origin: предпочтительно постоянный контролируемый USTAL hostname с TLS, same-origin API и страницами. Можно использовать существующий API hostname только после явного утверждения его постоянства и проверки региональной доступности; sslip.io не объявляется утверждённым юридическим доменом. Caddy/API должны сохранить same-origin `/auth/*` и `/me` для web deletion. Статический отдельный хост без безопасного backend routing не подходит текущей форме.

## Согласования владельца (один пакет)

1. Реальный USTAL support/privacy email; владелец процесса409/lost-password и порядок проверки личности/эскалации.
2. Постоянный HTTPS origin и полномочия/готовность его поддерживать.
3. Возраст 18+ и Россия утверждены. Проверить дополнительные применимые локальные требования; страна оператора не означает автоматическое ограничение Korea.
4. Основания, сроки/критерии для6категорий, включая retained source content, backups, AI caches и внешние копии; backup restore deletion reconciliation.
5. Имена и роли hosting/S3/relay/upstream/push получателей, регионы, договорные условия/training/retention; утверждение фактического AI disclosure, затем отдельное разрешение на consent enforcement.
6. Финальное утверждение Privacy/Terms/community policy и разрешение публикации/нового mobile build. Не принимать agreement и не подавать store формы автоматически.

## Операционные проверки до release

S3 `DeleteObject` необходим для фактического удаления; DB success не доказывает физическое удаление. Outbox повторяет ошибки; проверить IAM и controlled non-user test object только с отдельным разрешением. Backup retention/off-host/restore нельзя обещать по наличию scripts. Проверить recovery без resurrection удалённых аккаунтов. История заказов/жалоб/AI evidence может содержать personal data; ручной privacy request должен охватывать все stores, не только users row. Не изменять matching thresholds/ontology ради этого аудита.

## Официальные требования, проверены2026-10-21

- Apple review1.2,5.1.1,5.1.2: https://developer.apple.com/app-store/review/guidelines/
- Apple labels (собственный код и partners; free text/audio): https://developer.apple.com/app-store/app-privacy-details/
- Apple account deletion: https://developer.apple.com/support/offering-account-deletion-in-your-app/
- Google external deletion и lost-access/support: https://support.google.com/googleplay/android-developer/answer/13327111
- Google UGC: https://support.google.com/googleplay/android-developer/answer/9876937
- Google Data Safety definitions, service-provider exception и encryption: https://support.google.com/googleplay/android-developer/answer/10787469
- Google AI scope/reporting: https://support.google.com/googleplay/android-developer/answer/14094294
- Google Personal testing: https://support.google.com/googleplay/android-developer/answer/14151465

Не переносить privacy URLs, legal promises, identifiers, listing или screenshots WedLink. Переиспользуется только подтверждённый developer account оператора.

Подготовка Android: перенесён только минимальный app.json diff5318714 (remove READ_MEDIA_IMAGES + block image/video permissions) и2config regression tests. iOS owner/version/signing не изменены. Это не подтверждение итогового AAB manifest; перед Play нужен merged-manifest/device gate.
