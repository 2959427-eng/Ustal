# Matching regression guards (MVP baseline 2026-09-26)

Каждая защита ниже закрывает конкретную ошибку live blind holdout-100. Не удалять и не ослаблять без
воспроизводимого бага и полного blind 100/100 (см. CLAUDE.md, раздел Matching FROZEN).

## Серверные правила (packages/ai/src/review-constraints.ts)

| Правило | Закрывает | Суть |
|---|---|---|
| Отрицательный вердикт только с grounded `hardConflict` | BH-038 (FN) | `compatible=false` без обоснованного конфликта → repair, не финальный REJECT |
| Снятый недоказанный credential-конфликт → `compatible=true` | BH-038 | Упоминание категории B не доказывает отсутствие D (licence ≠ auto-reject) |
| `limitKind` вместо субъективного `wholeTask` | BH-004, BH-028, BH-046 (FP) | rate/threshold/per_item: required > available → hard; total_quantity — только при grounded явном «за один рейс» |
| Единица с «/» всегда rate | BH-004 | 60 vs 120 слов/мин — hard, как бы модель ни классифицировала |
| Закрытая таблица единиц м/m, кг/kg, г/g, км/km, слов/мин/wpm | BH-046 | 10 м vs 40 m сравнимы; разные величины не конвертируются |
| Делимый объём без явного one-trip → не конфликт | BH-034 (TP) | фургон 3 куб.м vs 10 куб.м мусора остаётся MATCH |
| Scope backstop: only/только/исключительно в профиле ⇒ `exclusiveScope` обязателен | BH-082 (FP) | пропуск инвентаризации → repair |
| Scope-конфликт по `requestedWithinAllowed=false`, не по строковому неравенству; `requested=null` → нет конфликта | BH-003 (TP) | «только удалённо» vs `remote` не конфликтует; «не только» не граница |

## Repair (packages/ai/src/providers/openai.ts, `buildRepairFeedback`)

| Правило | Закрывает |
|---|---|
| Для EvidenceValidationError в retry передаются `field` и отклонённая цитата + «копируй непрерывную подстроку значения, не переводи имена JSON-полей» | BH-066 (anomaly) |
| Для необоснованного `compatible=false` repair объясняет: domain = действительно несвязанные области; лицензии/категории/уровни/инструменты/медиумы/специализации внутри связанной области — не domain | BH-038, BH-035, BH-072 |

## Промпт review

- Смежная область, другой инструмент/медиум/специализация — релевантно; отсутствие точного опыта — не конфликт (BH-035 лётчик→дроны, BH-072 художник-масло→digital).
- Удалена строка «compatible=false requires … kind=domain for a clearly unrelated domain» из основного промпта: она вызвала FN BH-035/BH-072 (run 535ec880). Не возвращать.

## Pipeline gate (apps/worker/src/handlers/matching-run.ts, `shouldRunSourceReview`)

- Пустое/недостаточное structured extraction + есть исходные тексты профиля и заказа → source review решает; без review кандидат не становится MATCH. Закрывает BH-100 (FN: пустой extraction заказа «рыбалка в охотничьем хозяйстве» давал автоматический REJECT). Review budget прежний.

## Evidence validator (packages/ai/src/evidence-validation.ts)

- Консервативный: без fuzzy/semantic accept; сохраняет числа, отрицания, only, единицы. Не смягчать — для перефраза используется repair (BH-066).

## Regression tests

- `packages/ai/src/review-constraints.test.ts` — BH-038 (repair + нормализация), BH-004, BH-028, BH-046 (+ м≠км), BH-034, one-trip grounding, BH-082 (scope + backstop), BH-003, `requested=null`, «2D experience» без only, «не только», BH-066 (перевод имени поля отклоняется, дословное значение принимается).
- `packages/ai/src/providers/repair-feedback.test.ts` — BH-066 end-to-end repair; лётчик→дроны, художник→digital, BH-038 через repair с определением domain; основной промпт содержит правило смежности и не содержит удалённую domain-строку.
- `packages/ai/src/providers/order-contract.test.ts` — контракт: отрицательный вердикт с grounded domain-конфликтом.
- `packages/matching/src/empty-extraction.test.ts` — пустой extraction без review ≠ MATCH; с положительным review → candidate; grounded конфликт → REJECT; смежные области остаются candidate.
- `apps/worker/src/source-review-gate.test.ts` — gate source review (4 случая).

Состояние на baseline: matching 99/99, AI 114/114, worker 41/41, blind-evaluation 28/28, typecheck PASS.
