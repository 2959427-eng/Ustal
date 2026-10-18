# Semantic matching v2 — audit, implementation and release plan

## Latest readiness evaluation — 2026-09-15

Current scoring policy is semantic-score-v2.5; normalization remains semantic-v2.2. See [200-pair production-readiness report](evaluations/semantic-matching-production-readiness.md) and its JSON. Fresh live extraction/vectors on 200 frozen authored pairs completed 198/200; after a generic qualification gate, all saved inputs were re-evaluated with fresh reviews. Current precision97.35%, recall83.97%, F1 90.16%, FP3/FN21. Thresholds0.60–0.85 produce identical decisions; no production-safe range established. The current MVP rejects nonzero-risk work as qualification_unverified because canonical equality and AI compatibility do not establish verified qualifications. This gate removed four false positives without adding false negatives on this sample. Remaining negative/time constraint errors, missed semantic candidates and stochastic extraction block release. Current tests94/94 and typechecks8/8 PASS. No production/commit/push/deploy. Earlier small-sample results below are historical evidence, superseded by this evaluation for readiness.


Status: local implementation, NOT deployed. Worktree `C:\Users\User\Desktop\ustal-codex`, branch `codex/work`, base `a151f762f469957d0dae46a6dbdb11ab72cec882`. No new commit, push or production mutation.

Live evaluation completed on 2026-09-15: see [full report with raw model responses](evaluations/semantic-live-report.md). Seven expected decisions and four negative pipeline cases pass. Final checks: 92/92 tests and eight workspace typechecks. Current normalization version is semantic-v2.2; scoring policy semantic-score-v2.4. Production readiness remains NO for the explicit calibration/scale/legacy gates in that report.

## CURRENT ROOT CAUSE / CURRENT PIPELINE

The old profile handler exact-matched extracted labels against ontology names/synonyms and dropped unresolved structural facts. Order extraction persisted actions only in raw JSON; its mapping loop consumed four requirement arrays, not actions. Whole-profile/order embeddings existed, but phrase embeddings and explicit exclusions did not. Seed changes did not update prior profiles/orders. Profile apply and city updates did not enqueue rematching. Matching selected the newest profile including drafts. Feed selected the latest run even when unfinished and did not recheck city/blocks after publication.

Live read-only evidence earlier in this task: order 9269fc52-7719-463f-a800-c2f4c85cf462 was published in Уссурийск, both accounts were in that city, extraction contained погрузка/разгрузка but no persisted requirements, and the executor's applied profile had zero capabilities. This release has not been applied to those records.

## NEW MATCHING ARCHITECTURE

Extraction -> source-grounded normalization -> active ontology resolution -> immutable matching document plus phrase facts/vectors -> legacy structural projections -> city-filtered canonical/vector shortlist -> hard evidence gates -> semantic score -> candidates and diagnostic traces committed together.

The normalizer sees a bounded catalogue of active nodes and can return up to four existing keys per fact. No production keyword rules or profession catalogue are added. Unknown keys are ignored; unmapped phrases remain facts with vectors. Every normalizer evidence field must be a verbatim substring of the source. Low-confidence mappings do not grant canonical evidence. The ontology catalogue is capped at 512 nodes per request; current seed contains 131. Larger catalogues need a separately evaluated catalogue-retrieval stage rather than raising the cap indefinitely.

## PROFILE PIPELINE

New extraction checks input ownership and confirmed status, builds from the previous applied source plus the latest change, and writes a draft. The user still explicitly applies it. Source-input provenance and a unique source index prevent duplicate profiles on job retries; per-user locking prevents concurrent profile-version races. A different applied profile appearing during extraction aborts the stale result. Source text, semantic facts, exclusions, availability and vectors persist even without a canonical mapping. The applied profile is the only matching source; drafts are not candidates.

## ORDER PIPELINE

Actions are inputs to normalization and recognized active action/capability nodes have a deterministic fallback projection. Ordinary actions are desired capability signals; concrete explicit mandatory requirements are separate hard gates. Resource/action type inconsistencies are corrected against node type. Original source, order status, moderation, price and publication workflow are preserved. Derived facts are committed with extraction results. Backfill of an open order does not rerun publication or alter the original description/moderation.

## SEMANTIC FALLBACK / MATCHING SCORE

Every normalized fact has a 1536-dimensional vector. Retrieval documents contain positive capability phrases only; explicit refusal is never positive retrieval text. Embedding model IDs must agree before vectors are compared. Zero/non-finite/dimension-mismatched vectors do not produce a score.

Policy `semantic-score-v2.4`: exact capability coverage up to 80; related coverage up to 60; semantic evidence up to 60; concrete resource bonus up to 10; compatible availability +5; negative learned preference -20. Resource ownership alone cannot make a candidate relevant. Automatic semantic-only eligibility starts at cosine 0.78. At cosine >=0.40, low-risk candidates that passed hard gates may receive an additional gpt-4.1-mini review (configurable); compatible=true with confidence >=0.90 is required. Explicit exclusion comparison remains 0.80 and ordinary mandatory capability fallback 0.90. These values passed a small live evaluation, NOT representative production calibration. Pair review currently occurs inside the transaction with a 20-review budget; budget exhaustion aborts the run. Batch/cache/job design must be reviewed before production scaling.

Internal classes: exact, strong, probable, semantic-only, reject. API remains backward-compatible: exact/probable and explanatory text; detailed classification is in breakdown/trace. Regulated ontology nodes and regulated extraction prohibit automatic recommendations. Related graph edges cannot bypass regulated work or prove a mandatory qualification. Parent asset relations are directional: a car can satisfy a generic vehicle requirement, a generic vehicle cannot prove a van.

## RESOURCE MATCHING / NEGATIVE CONSTRAINTS

Resources are separate facts and structural rows. Added resource concepts: car, van, drill, lawn_mower, ladder, trailer, using existing resource parents. Added moving_help as a capability; existing canonical keys were not renamed. A small reviewed set of related edges joins carrying/loading/unloading/moving help; this is ontology maintenance, not a phrase dictionary.

Explicit refusals/inability are checked before positive score by canonical/related subject or phrase similarity. Required resources cannot be supplied by whole-profile similarity. Daily/overnight availability windows are compared with desiredAt in the city timezone or with an extracted order time window. Unknown time is marked needs_confirmation. Date-specific calendars, weekday-only restrictions, durations/travel time and arbitrary context predicates are not yet a complete scheduling system.

## REPROCESS STRATEGY

`apps/worker/src/reprocess-cli.ts` defaults to a read-only per-ID plan; `--apply` is explicit. Processing identity contains pipeline version, ontology content hash, model hash and source hash. Source/profile ownership/status is rechecked under locks. Existing snapshots are reused, structural rows are replaced atomically, existing proficiency/resource metadata is retained for recognized nodes. The same requested operation can be retried without duplicate snapshots; AI inference may still incur a repeated call before the persistence deduplication check.

For legacy applied profiles with no sourceInputId, the operator must supply a verified confirmed source input belonging to that user, created no later than the applied profile. Unknown provenance fails closed. Do not bulk-guess that the newest source input belongs to the applied profile: it may belong to a discarded draft. Already-approved summary is retained as context for cumulative legacy profiles. This provenance mapping needs review before processing real records.

Examples (local test shell with configured environment):

```powershell
node --import tsx apps/worker/src/reprocess-cli.ts --kind profile --id <PROFILE_UUID> --source-input-id <CONFIRMED_SOURCE_UUID>
node --import tsx apps/worker/src/reprocess-cli.ts --kind profile --id <PROFILE_UUID> --source-input-id <CONFIRMED_SOURCE_UUID> --apply
node --import tsx apps/worker/src/reprocess-cli.ts --kind order --id <OPEN_ORDER_UUID>
node --import tsx apps/worker/src/reprocess-cli.ts --kind order --id <OPEN_ORDER_UUID> --apply
```

## REMATCH STRATEGY

Profile apply and city change atomically upsert a durable per-user request. The dispatcher polls every ten seconds, locks at most five requests with SKIP LOCKED, pages 25 open same-city orders per request by UUID and enqueues normal matching jobs. Errors preserve the cursor for retry; duplicate jobs are harmless to data (they can create additional completed runs). A completed cursor retains the change watermark, so dispatch completion cannot briefly resurrect stale feed rows while matching is pending. New edits reset the cursor. Publication already enqueues order matching; explicit order reprocess also rematches.

## PERFORMANCE STRATEGY

Indexes cover city/user lookup, latest applied profiles, open orders by city, canonical capability lookup, current document snapshots and completed runs. Profile/fact vectors have HNSW cosine indexes. The shortlist combines up to 150 canonical candidates and 150 vector candidates; a bounded exact city fallback compensates for underfilled ANN results. Candidate facts/resources/embeddings/preferences are fetched in batches, not per-country cross-products. At most 450 distinct candidates can reach scoring when the fallback adds additional rows.

Small local data passed the real SQL paths. HNSW index availability was verified with EXPLAIN under enable_seqscan=off; this is an index usability check, not production load evidence. Actual city-filtered query plans and ANN recall need evaluation at representative scale. The documented filter/recall tradeoff follows [pgvector's official filtering guidance](https://github.com/pgvector/pgvector#filtering). Future large-city deployments may need partitioning or an evaluated iterative ANN configuration.

## OBSERVABILITY

matching_documents records pipeline/model/source versions and processing time (SQL created_at, Drizzle processedAt). matching_facts retains source evidence and unresolved facts. matching_traces records every evaluated shortlisted user's decision, exact/related coverage, semantic score, resources, availability, rejection reason and selected document/profile IDs. A user outside the shortlist has not been scored: absence of a trace is not a semantic rejection. Hard exclusions before retrieval are diagnosable from city, author, status and blocks.

```sql
SELECT decision, detail FROM matching_traces
WHERE matching_run_id = '<RUN_UUID>' AND user_id = '<USER_UUID>';
```

Feed rechecks city, active status, authorship, blocks, applied profile and processing watermarks. It selects only completed runs and rejects traces from a superseded profile. Matching runs/candidates/traces are published transactionally; cancelled orders are rechecked before completion.

## CHANGED FILES

- API: routes/profile.ts, routes/feed.ts, routes/feed.integration.test.ts.
- Worker: handlers/profile-extraction.ts, handlers/order-extraction.ts, handlers/matching-run.ts, handlers/matching-run.test.ts, index.ts; semantic.ts, semantic.integration.test.ts, rematch.ts, reprocess.ts, reprocess-cli.ts.
- AI: types.ts, providers/openai.ts, providers/mock.ts.
- Database: schema.ts, seed.ts, index.ts, test-safety.ts, migrations/0006_semantic_matching.sql, migrations/meta/0006_snapshot.json, migrations/meta/_journal.json.
- Matching: index.ts, semantic.ts, semantic.test.ts. Existing legacy scoring tests remain intact.
- Ontology: mapping.ts, mapping.test.ts.
- Validation: semantic.ts, index.ts.
- Documentation: this report and an additive AI_HANDOFF.md entry. Pre-existing AGENTS.md/CLAUDE.md/parallel-work.md changes are not part of this implementation.

## DB MIGRATIONS

0007_matching_retry_identity adds nullable matching_runs.input_hash and a unique matching_candidates(run_id,user_id) index. Both migrations were applied only to local test databases. Unchanged latest runs are reused; policy/model/source/profile/ontology/watermark changes invalidate the fingerprint. A repeated extraction no longer erases order requirements, and reusing an order document preserves its existing vector.

0006_semantic_matching is additive: matching_documents, matching_facts, matching_traces, rematch_requests; nullable capability_profiles.source_input_id; foreign keys, source uniqueness, one-owner check and retrieval/vector indexes. No reset/drop/data deletion. Performance indexes and one-owner constraint at the end of the SQL are maintained as explicit migration SQL in addition to the generated Drizzle snapshot. On a large production database HNSW index build time and locking require a scheduled rollout or splitting index creation into an operator-managed concurrent step before approval.

## TEST RESULTS / TYPECHECK RESULT

See final verification entry below. Integration tests run on localhost / ustal_semantic_test only, with NODE_ENV=test and injected AI fixtures. A fail-closed guard prevents these fixtures from running against a production/non-test URL. No production users/orders were created or exercised. All requested nine business cases are represented, along with provenance, retries, draft exclusion, real feed reads, time/resource/regulated hard gates and unsupported source evidence.

## REMAINING RISKS

- Live evaluation now passes the requested small set; broader relevance calibration and scale measurements remain required. Primary extraction can still overinterpret ambiguous/unknown input; the new source-only normalizer prevents those extra fields from becoming matching evidence. Detailed observations and intermediate failures are retained in the live report.
- The first normalizer still relies on the model to interpret negation/time correctly; verbatim evidence is necessary but is not proof of semantic entailment. Unknown date/week/context restrictions need human confirmation.
- Catalogue input is capped; large-catalogue retrieval, production ANN recall and throughput have not been benchmarked.
- Legacy source provenance must be reviewed per approved profile. Do not silently apply unknown draft inputs.
- New documents store source evidence and must follow the same access/retention policy as existing profile/order text. Traces are internal, never raw reasoning in the public feed.
- Rollout must rebuild/recreate the API and worker from the same reviewed code; copying seed.ts alone is insufficient for this architecture.

## PRODUCTION DEPLOY PLAN

1. Review this diff and isolated evaluation results; obtain explicit commit/push/deploy authorization. No authorization is inferred from this report.
2. Integrate only named changes into agreed main that includes current production SHA; rerun tests/typecheck there. Publish a reviewed commit only after authorization.
3. Inspect production HEAD/status, stop concurrent releases, take pg_dump -Fc and verify pg_restore --list, record SHA/hash/size and restore procedure.
4. Apply additive migration in the agreed maintenance window; run the reviewed seed. Rebuild API/worker from the same SHA and restart only those services under the agreed deployment procedure.
5. Run per-ID dry-run plans for reviewed existing applied profiles/open orders. Confirm source provenance; apply bounded profile backfill, then order backfill/rematch. No integration tests or synthetic data in production.
6. Read-only validate requirements, applied profile facts, completed matching trace/candidates and health; let users check their real feed. Observe queue backlog, errors, latency and rejection distribution.
7. Rollback: restore previous API/worker image; leave additive tables in place. Restore affected derived rows from the verified backup or a reviewed previous snapshot if required. Do not drop/reset the database or overwrite unrelated newer user data.
## Final local verification — 2026-09-14

- Worker: 19/19 PASS (11 semantic integration scenarios, 7 existing matching regressions, 1 extraction failure regression).
- API: 4/4 PASS (3 real Fastify/feed/profile-apply database tests, 1 health test).
- Matching: 53/53 PASS (12 new semantic/resource/constraint/time tests plus 41 existing tests).
- Ontology: 4/4 PASS. AI: 7/7 PASS. Total: 87/87.
- Typecheck: worker, api, matching, ontology, ai, database, validation all PASS. Validation has no standalone test script; its contracts are exercised by the worker/AI tests.
- git diff --check: PASS. These backend packages' lint scripts are no-op declarations, not additional static-analysis evidence.
- Node: bundled v24.19.0. Isolated database: localhost/ustal_semantic_test. No production connection was used for implementation/testing.
- Additive migration and seed: PASS on isolated PostgreSQL. HNSW usability: EXPLAIN showed Index Scan using profile_embeddings_cosine_hnsw_idx; production load/recall remains unmeasured.
- An initial suite cleanup failed on the moderation_cases foreign key. Cleanup order was corrected; the failed run's explicitly named fixtures were removed only from ustal_semantic_test. Subsequent complete test runs passed.
- No commit/push/deploy. Current application on the phones still uses the previous production implementation until a separately approved rollout/backfill.

## FN investigation — 2026-09-16, local evaluation in progress

See `evaluations/semantic-matching-fn-investigation.md` and `.json` for the complete21-case baseline audit and fresh full-pipeline rounds. Original production-readiness artifacts are preserved as the immutable baseline. No production/Git publication is authorized.

Current local normalizer uses configurable `AI_MODEL_NORMALIZATION` (default gpt-4.1-mini), bounded structured validation repair, and server-owned evidence span IDs restored to exact source text before persistence (`semantic-v2.3`). A citation establishes source provenance, not proof that the inferred fact is entailed. Source-span selection is not fuzzy quote acceptance.

Current scorer policy `semantic-score-v2.6` reviews unresolved ordinary actions without a cosine admission veto, preserving immutable source context when available (`semantic-review-v4-source`). Automatic cosine remains0.78; review confidence0.90; exclusion0.80; mandatory capability0.90. Every hard constraint still precedes review. No ontology edits or dataset relabeling in these rounds.

Source-aware review has a larger eligible population. The existing review budget20 remains a hard transactional limit: an isolated21-candidate test confirms exactly20 calls and no partial published run. This is safe failure, not production throughput readiness. City-level candidate counts, the shortlist150 cap, queueing/caching and network calls inside the transaction remain release blockers.

Round3 completed200/200,precision99.14%,recall87.79%,FP1/FN16,17/20 repeatability. Round4 completed and is the accepted current implementation: precision97.67%, recall96.18%, FP3/FN5,200/200 processed,20/20 stable. Round5 resource-allocation experiment was rejected (recall89.31%,196/200 processed,16/20 stable); its runtime edits were reverted to the exact round4 SHA256 file fingerprints. See semantic-fn-selection.json. Qualification, customer-provided resources and regulated-node input scope still require scrutiny. No waiver of qualification verification is implemented.
