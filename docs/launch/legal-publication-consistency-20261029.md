# Исправление рассинхронизации юридических документов — 2026-10-29

Статус: локально PASS; production не изменён.
Ветка `codex/legal-publication-consistency`, baseline `2e83d98e4f8b1b4ba13b1eca389f4fdbe88686e0`.
Изолированная рабочая копия: `C:/Users/User/.codex/worktrees/legal-publication-consistency/ustal-foundation`.
Исходники baseline до правки проверены штатным guard: расхождения только в пути и имени новой ветки,
не в HEAD/manifest/content. Каноническая релизная папка и существующий WIP не изменялись.

## Подтверждено в production

Read-only GET к `https://api.ustal.site`:

| Адрес | Результат до исправления |
|---|---|
| `/privacy`, `/terms` | 200, опубликованный HTML |
| `/legal` | 200, privacy/terms available=false, version=null |
| `/legal/`, `/legal/privacy`, `/legal/terms` | 404 |

Причина: публичные страницы используют валидированный publication bundle, а старый индекс
и адреса `/legal/*` искали отдельные Markdown-файлы. Мобильная форма проверяет именно индекс.

## Изменение

Два серверных модуля теперь получают один снимок утверждённого bundle через существующий
`currentPublication()`. Privacy/terms в индексе используют его доступность и версию.
Схема JSON, идентификаторы и `path` сохранены. `/legal` и `/legal/` возвращают JSON без редиректа;
`/legal/privacy` и `/legal/terms` возвращают тот же HTML, что канонические страницы.
Индекс и эти совместимые страницы имеют `Cache-Control: no-store`.

Тексты/renderer/validator/bundle не изменены и не скопированы. Мобильный код,
обязательные отметки, отсутствие публикации как блокер и отдельный источник AI-документа сохранены.
API регистрации, аудит согласий, БД и бизнес-логика не менялись.

## Проверки

- Регрессия на исходных двух серверных файлах: FAIL — при 200 у `/privacy` и `/terms`
  индекс сообщает false/null. Исправленные файлы после проверки восстановлены побайтово.
- После исправления: 20/20 тестов в `legal.test.ts`, `legal-documents.test.ts` и
  `tests/legal-registration-publication.test.ts` PASS.
- Новый тест использует настоящий publication loader и реальные мобильные
  `registrationDocumentsReady`/`registrationConsentError`: bundle → страницы 200 → индекс true
  → публикация перестаёт блокировать регистрацию. Неотмеченные согласия по-прежнему блокируют её.
- Также проверены точное совпадение HTML обоих адресов, `/legal/`, отсутствие публикации,
  отклонение неутверждённого bundle и сохранение старого AI-документа.
- Typecheck API и `git diff --check`: PASS. Аккаунты в production не создавались;
  фактическая регистрация на физическом iPhone/Android этим серверным тестом не заявляется.

Проверки выполнены Node 24.22.1 после `npm ci --ignore-scripts --workspace @ustal/api
--include-workspace-root --no-audit --no-fund`; lockfile не менялся.
API-only установка не содержит Expo; для прямого импорта чистого мобильного helper использована
временная Vitest-конфигурация `export default { esbuild: { tsconfigRaw: "{}" } };` вне репозитория.

Commit/push/deploy не выполнялись. Пока серверное исправление не развёрнуто,
production `/legal` продолжает блокировать регистрацию. После разрешённого серверного обновления
нужно повторить GET-проверки и заново открыть экран регистрации в существующей сборке;
новая мобильная сборка для этой правки не требуется.
