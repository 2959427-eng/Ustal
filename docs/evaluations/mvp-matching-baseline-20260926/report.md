# MVP matching baseline — FROZEN (2026-09-26)

Статус: **matching для MVP заморожен.** Это эталон, с которым сравнивается любое будущее изменение matching.

## Подтверждённый live blind run

- Run: `7096b094-6816-4bf9-8ce3-7c15a013c3dc`
- Dataset: frozen holdout-100, SHA256 `53b5c42387ff4ba29fcafa7debfe89b8faae2255e54d8c3dd057cb9fa7975bd3`
- Среда: изолированная облачная среда (Postgres 16 + pgvector), полный цикл `blind:setup-db` (migrations + seed) → `blind:load-data` → `blind:evaluate` (live, AI_PROVIDER=openai через relay) → `blind:analyze` (exit 0).
- 100/100 attempted, 100/100 classified, needs_review 0.

| TP | TN | FP | FN | Precision | Recall | F1 | Accuracy | Specificity | Evidence anomalies |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 82 | 17 | 1 | 0 | 0.988 | 1.000 | 0.994 | 0.99 | 0.944 | 0 |

Совпадает с исторической baseline policy (82/17/1/0, F1 0.994).

## Известный допустимый FP

- **BH-026** — профиль «водитель, мотоцикл», заказ «доставка посылок, автомобиль». Ожидается REJECT (объективная несовместимость ресурса), система даёт MATCH semantic-only.
- Причина: extraction помечает «автомобиль» как `resourceRole=compatibility` (мягкий сигнал), единственный барьер — LLM-review, который в этом прогоне не вернул `hardConflict=resource` (в предыдущих прогонах возвращал). Нестабильность LLM-вызова, не детерминированный баг.
- Решение: для MVP принимается, **не исправлять**; специальных правил motorcycle/car не добавлять.

## История этапа (кратко)

| Run | TP | TN | FP | FN | Anomalies | Ошибки |
|---|---:|---:|---:|---:|---:|---|
| b6251585 (до этапа) | 81 | 13 | 4 | 1 | 1 | FN BH-038; FP BH-004/028/046/082; anomaly BH-066 |
| 535ec880 (фиксы 1–5) | 79 | 17 | 1 | 3 | 0 | FN BH-035/072/100; FP BH-026 |
| **7096b094 (baseline)** | **82** | **17** | **1** | **0** | **0** | FP BH-026 |

Защиты и зачем они нужны: `docs/matching-regression-guards.md`.
