# .ai-bridge/ — файловый мост Claude <-> Codex

Создано Claude (Cowork) 2026-09-08 через file-bridge. Прошёл 6 раундов
тестирования на реальной машине (test-001 ... test-006 + первая боевая
задача), все найденные дефекты исправлены — статус: **рабочий**.

## Файлы

- `scripts/codex-bridge.ps1` — сам watcher (см. подробный `.SYNOPSIS`/
  `.DESCRIPTION`/`.NOTES` в начале файла). Поллит `task.json`, проверяет,
  что это точно репозиторий USTAL (git toplevel + remote), запускает Codex
  CLI, пишет `status.json` (с heartbeat раз в 15 сек, пока Codex работает),
  лог задачи в `logs/<task_id>.log` и добавляет запись в `result.md`.
- `.ai-bridge/task.json` — **сюда кладётся новая задача**, чтобы watcher её
  подхватил. Обязательные поля: `task_id` (уникальный, для dedup) и
  `prompt` (текст, который улетит в Codex CLI — любой длины, с кавычками,
  тире, markdown, переносами строк, кириллицей — см. "Как передаётся
  prompt" ниже). Файла `task.json` в репозитории по умолчанию нет — есть
  только примеры (`task.example.json` и другие `task-*.json`), чтобы
  ничего не запустилось само по себе.
- `.ai-bridge/task.example.json` — безопасный тестовый пример задачи (просто
  `git status --short` + `git branch --show-current`, ничего не меняет).
  Чтобы протестировать watcher: скопируйте его в `task.json`
  (`Copy-Item task.example.json task.json`) при запущенном watcher'е.
- `.ai-bridge/prompt-<task_id>.txt` — **создаётся watcher'ом автоматически**
  для каждой задачи (2026-09-08): полный текст prompt'а, сохранённый в
  UTF-8 без BOM, ровно тот, что уходит в stdin Codex. Не редактируйте
  вручную — это просто копия для аудита/отладки, не входной файл.
- `.ai-bridge/status.json` — текущий статус watcher'а: `task_id`, `state`
  (`idle` / `starting` / `running` / `completed` / `failed` / `error`),
  `cwd`, `pid`, `started_at`, `last_update`, `finished_at`, `exit_code`,
  `error`. Перезаписывается watcher'ом на каждом шаге.
- `.ai-bridge/result.md` — история завершённых задач, новые записи сверху
  (как в `AI_HANDOFF.md`). Пишется только watcher'ом. PID туда намеренно не
  дублируется (это лог истории, а не live-статус) — если нужно, можно
  добавить по запросу.
- `.ai-bridge/logs/<task_id>.log` — полный stdout/stderr конкретной задачи.
- `.ai-bridge/processed_tasks.json` — служебный файл дедупликации (создаётся
  автоматически при первой обработанной задаче); список уже обработанных
  `task_id`, чтобы один и тот же `task.json` не запускался повторно.

## Как запустить

Из корня репозитория, в PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\codex-bridge.ps1
```

Или открыть `scripts\codex-bridge.ps1` в PowerShell ISE/VS Code и запустить
напрямую (F5). Это **ручной foreground-режим** (пункт 17 исходной задачи) —
watcher работает, пока открыто окно; `Ctrl+C` останавливает. Как служба
Windows он НЕ регистрируется — это сознательно отложено.

## Как передаётся prompt (важно, если что-то не работает)

Изначально prompt передавался Codex как часть строки аргументов
(`codex exec "<prompt>"`). На длинных prompt'ах с кавычками/тире/переносами
строк это ломалось — Win32 разбор командной строки портил или разбивал
аргументы, Codex падал с `error: unexpected argument '-' found`.

Исправлено (2026-09-08): watcher вызывает `codex exec` БЕЗ prompt'а в
аргументах, а сам текст пишет напрямую в stdin процесса (эквивалент
`codex exec < prompt-file.txt`) как raw UTF-8 байты — без ручного
экранирования кавычек. Копия того же текста сохраняется в
`.ai-bridge\prompt-<task_id>.txt` для аудита. Подтверждено тестом test-006
(кириллица + двойные кавычки + тире + многострочный текст, exit_code=0).

Если на этой машине `codex exec` почему-то не читает stdin — смотрите
точный текст ошибки в `.ai-bridge\logs\<task_id>.log`, не гадайте заранее.

## $CodexCommand / $CodexArgsTemplate — подтверждено на машине

```powershell
$CodexCommand = "C:\Users\User\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe"
$CodexArgsTemplate = "exec"
```

Путь к `codex.exe` версионный (содержит хеш сборки) и сломается при
следующем обновлении Codex CLI — если watcher перестанет запускать Codex,
переоткройте реальный путь (например `Get-Command codex.exe` в обычной
оболочке, где алиас/PATH `codex` работает) и обновите строку в скрипте.

## Что watcher НЕ делает (жёсткие ограничения, встроены в скрипт)

- Никогда не вызывает `git push` сам.
- Никогда не трогает Timeweb/production-инфраструктуру сам — он только
  запускает Codex с текстовым prompt'ом; что именно сделает Codex внутри
  задачи, определяется самим prompt'ом и правилами `AGENTS.md`.
- Отказывается запускать Codex (пишет `state=error`, Codex не запускается),
  если репозиторий в `$RepoRoot` не проходит проверку (не git-репозиторий,
  или remote не похож на `2959427-eng/Ustal`).
- Дедуплицирует `task_id` — одна и та же задача не выполнится дважды, даже
  если `task.json` останется на диске после завершения.
