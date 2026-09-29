# Career-context regression set — Stage 0 (2026-09-27)

Stage 0 of `claude/extended-ai-profile-architecture-2026-09-27.md`: do career facts, wishes and
passive-search conditions in a profile hard-reject ordinary relevant orders?

**Not part of the frozen blind holdout-100** (SHA 53b5c423…, untouched). Separate paired set:
`cases.json` — 12 profiles (+Q10 stability probe) × base / career / cumulative variants,
4 distinction variants (preference / passive condition / price ban / refusal), 15 orders, 76 pairs.
Criterion: the career variant must decide exactly like the base variant.

## Harness (`harness/`)
Real production functions with live AI (same `.env` provider/models, temperature 0):
`extractCapabilityProfile → prepareDocument(normalizeMatching, ontology mapping, negatives, embeddings)`
[cumulative: `planNegativeOverrides` + fact carry-forward], `extractOrder → prepareDocument("order")`
+ moderation, then the per-candidate glue of `matching-run.ts` (copied verbatim):
`evaluateSemantic → shouldRunSourceReview → reviewSemantic → evaluateSemantic`.
Only Postgres is replaced (`database-stub-index.ts`): ontology = unchanged seed
(`ONTOLOGY_NODES` extracted from `packages/database/src/seed.ts` into `ontology-data.ts`), retrieval
computed in memory (canonical node hit + document cosine are recorded per pair).
The same harness on the frozen holdout reproduces the official live baseline 7096b094 exactly
(TP 82 / TN 17 / FP 1 = BH-026 / FN 0), see `holdout-before.json`.

Run (Linux, Node 22; `NODE_USE_ENV_PROXY=1` behind a proxy): copy packages ai/config/validation/
matching/domain/ontology + worker `semantic.ts`, `profile-negatives.ts`, `handlers/matching-run.ts`
into a scratch dir, add the stub as `@ustal/database`, then
`npx tsx harness/probe.ts [P01|…|V] out.json` and `HOLDOUT=… npx tsx harness/holdout.ts 0 100 out.json`,
`python3 harness/summarize.py <prefix>`.

## Results
| | career-caused FN (pairs) | holdout-100 |
|---|---|---|
| before fix | 7 + matching-run crash (P01) | 82/17/1/0, F1 0.994 |
| after fix  | 0 | 82/17/1/0, F1 0.994, 0 decision diffs |

Remaining MATCH-expected rejects after the fix are NOT caused by career text (they also occur in
base variants): `missing_mandatory_resource` from pseudo-capacity "1 шт" / unit null vs "шт" on a
whole_task vehicle requirement, and V4 (`Не выполняю перевозки`) leaking an exclusion hardConflict
onto an assembly order. Both are documented as separate findings, not fixed here.

Files: `stage0-pairs-before-after.json` (per-pair decisions), `holdout-before.json`,
`holdout-after.json`, `raw/` (full facts + review per run).

## Follow-up 2026-09-27: three matching bugs (refusal scope, missing data ≠ missing resource, review failure)
Report: project doc `claude/matching-bugs-refusal-resource-review-2026-09-27.md`.
- Career set extended with real-ban group B1–B4 (`cases.json`), 94 pairs: 0 expected-MATCH rejected;
  every explicit ban variant rejects the related order and keeps unrelated ones (`raw/after-bugfix-20260927`).
- Same harness on holdout-100: 82/17/1/0, 0 decision diffs vs baseline (`holdout-after-bugfix.json`).
- Official DB harness (`apps/blind-evaluation`, real handlers, live AI) on a local PostgreSQL 14 + pgvector 0.8:
  evaluation 8e50a18e…: 82/17/1/0, F1 0.994, 0 evidence anomalies, 0 review failures (709 AI calls).

## Phase 1 profile_facts (shadow), 2026-09-27
Career set re-run after adding profile_facts: 94 pairs, 0 decision diffs vs the previous run (`raw/after-phase1-profile-facts`). Official blind evaluation a6c47751…: 82/17/1/0, predictions identical to 8e50a18e… for 100/100 cases.

## Phase 2A profile_facts user control, 2026-09-28
Career set: 94 pairs, 0 decision diffs vs Phase 1 (`raw/after-phase2a`). Official blind evaluation 6d597436…: 82/17/1/0, predictions identical to 8e50a18e… for 100/100.
