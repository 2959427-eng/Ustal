# USTAL — Matching

## Пайплайн заказа
`текст/голос → structured extraction → JSON validation (Zod) → ontology mapping →
risk classification → moderation → embedding → публикация → matching_run`

## Пайплайн профиля
`голос → транскрипция → правка → structured extraction → JSON validation →
ontology mapping → business validation → новая версия профиля → embedding → резюме`

## 13.1 Жёсткие фильтры (исключают кандидата полностью, до scoring)
- автор заказа;
- другой город (`orders.city_id <> user_profiles.city_id`);
- заблокированные/удалённые/скрытые аккаунты;
- взаимно заблокированные пары (`blocks`);
- отсутствие обязательного ресурса (`order_requirements.is_mandatory = true`);
- отсутствие допуска к регулируемой работе (см. architecture.md п.7 — в MVP это
  фактически означает: ни один пользователь не проходит фильтр допуска
  автоматически, регулируемые заказы всегда уходят в manual_review).

## Ontology mapping при извлечении профиля (реализовано в Фазе 2)
Раздел 11 ТЗ: LLM не создаёт активные узлы онтологии. Поэтому способность/ресурс
без совпадения в `ontology_nodes` не попадает в `user_capabilities`/`user_resources`
(структурные поля, используемые ниже для canonical match), а несовпавшая фраза
уходит в `ontology_candidates` на ручное подтверждение админом (Фаза 8). Это не
теряет информацию полностью: `capability_profiles.summary` — свободный текст,
включающий всё, что извлекла модель, и его embedding (`profile_embeddings`)
по-прежнему участвует в semantic similarity ниже — просто без вклада в
explicit/inferred capability match, пока админ не смёржит кандидат в онтологию.

## 13.2 Поиск кандидатов
Комбинация: совпадение canonical capabilities, совпадение resources, embedding similarity
(pgvector, `<=>` cosine), полнотекстовый поиск (`ts_vector` по normalized_description),
история похожих выполненных заказов, learned_preferences. Пороги и веса — в
`packages/config` (без деплоя).

**Решение при реализации (Фаза 4, см. architecture.md §5 п.12):** полнотекстовый
поиск (`ts_vector`) сознательно не реализован в MVP. Semantic similarity
(pgvector) уже покрывает поиск "по смыслу" при несовпадении формулировок, а
canonical capability/resource match — точные структурные совпадения; полнотекст
добавил бы третий, частично перекрывающийся сигнал без данных, чтобы оценить,
улучшает ли он реальный подбор кандидатов. Возврат к этому пункту — кандидат
на post-MVP, если реальные данные покажут, что embedding+canonical недостаточно
находят релевантных кандидатов при расхождении формулировок без семантической
близости (например, аббревиатуры, опечатки, местный сленг).

## 13.3 Scoring (объяснимый score 0–100)

Единственная боевая реализация — `evaluateSemantic` в `packages/matching/src/semantic.ts`
(вызывается из `apps/worker/src/handlers/matching-run.ts`), пороги — `SEMANTIC_POLICY`.
Сначала жёсткие гейты (явный отказ, время/доступность, объективная несовместимость
ресурса, недостаточно evidence без LLM-ревью), затем score:

```
max(80·exactCoverage + 60·relatedCoverage, 60·semantic)   (semantic — при ≥ semanticMin или semantic-only)
+ до 10 за ресурсы, +5 совместимая доступность
+5 similarCompletedWork — зарезервировано, пока НЕ подключено в matching-run
−20 negative preference, −5 soft-несовпадение вида ресурса
```

Инвариант: ни во входе `evaluateSemantic`, ни в `matching_candidates` нет полей,
связанных с оплатой. Совпадение города — фильтр retrieval, а не вес.

(Прежняя весовая формула 30/15/15/15/10/15 и модули `scoring.ts`/`requirements.ts`/
`explanation.ts` удалены 2026-09-24 как мёртвый код.)

## 13.4 Тип совпадения

Внутренняя классификация `evaluateSemantic`: `exact | strong | probable | semantic-only | reject`.
В `matching_candidates.match_type` пишется только:

| Тип | Условие |
|---|---|
| `exact` | все требуемые способности покрыты точным canonical-совпадением |
| `probable` | `strong`, `probable` или `semantic-only` (смежные навыки/ресурсы, semantic + LLM-ревью) |

Тип `new_opportunity` («простая работа, доступна каждому») удалён: он противоречит
политике показа (отказ только при явном отказе, объективной несовместимости,
нарушении времени/гео или заведомо другой области) и никогда не создавался боевым
pipeline. Объяснение — фиксированные строки в `matching-run.ts`; в мобильном UI
тип и объяснение сейчас не показываются, лента сортируется по score.

## 13.5 Распространение заказа
AI не определяет число необходимых исполнителей. Заказ показывается всем кандидатам
города, прошедшим фильтры и минимальный порог релевантности (без волновой рассылки в
MVP). Заказчик сам решает, с кем обсуждать, с кем договариваться и когда прекратить
поиск — это не автоматизируется.
