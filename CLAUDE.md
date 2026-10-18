# Claude: рабочая папка USTAL

Прочитай `AGENTS.md` и `docs/parallel-work.md` перед изменениями.
Твоя рабочая папка: `C:\Users\User\Desktop\ustal-codex` — единственная рабочая копия.
Перед изменениями проверь путь и текущую ветку в Git.
File-bridge также должен читать и писать именно в эту папку.
Не работай в `ustal-claude` и не продолжай параллельную разработку в
`ustal-foundation`: там остаётся общий незакоммиченный набор старых правок.
Деплои только последовательно из интегрированного main и с разрешением пользователя.

## Matching — FROZEN для MVP (с 2026-09-26)

Эталон: `docs/evaluations/mvp-matching-baseline-20260926/report.md` (run `7096b094-6816-4bf9-8ce3-7c15a013c3dc`:
100/100, TP 82 / TN 17 / FP 1 / FN 0, F1 0.994, evidence anomalies 0). Защиты: `docs/matching-regression-guards.md`.

- **FN = 0 — обязательный инвариант.** Политика recall-first: отсутствие данных ≠ запрет; смежная область, другой
  инструмент/медиум/специализация ≠ конфликт; лицензия/регулирование ≠ auto-reject. REJECT только при явном отказе,
  объективной несовместимости ресурса, нарушенном явном времени/географии, явной only-границе, превышенном явном
  числовом лимите или действительно несвязанной области.
- **BH-026** (мотоцикл vs автомобиль) — известный допустимый FP для MVP. Не исправлять, спецправил не добавлять.
- Не менять matching, review/extraction prompts, thresholds, ontology, frozen fixtures, evidence validator без
  конкретного воспроизводимого бага.
- Любое изменение matching: regression tests + полный live blind 100/100 (`blind:setup-db` → `blind:load-data` →
  `blind:evaluate` → `blind:analyze`); результат не хуже baseline (FN 0, FP ≤ 1, anomalies 0), без case-ID hacks.
