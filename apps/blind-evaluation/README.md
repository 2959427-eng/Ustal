> Verified 2026-09-18: setup/load/dry-run pass for frozen SHA256 53b5c42387ff4ba29fcafa7debfe89b8faae2255e54d8c3dd057cb9fa7975bd3. Real handlers and SQL extractor are wired; no live calls executed. See ../../docs/evaluations/blind-ready-20260918/report.md. Earlier status notes below are superseded.

> Current verified status (2026-09-18): prerequisites only. The live adapter and prediction extractor are not implemented; non-dry execution is blocked. The required semantic-blind-holdout-100.json is missing. Historical descriptions below describe intended behavior, not verified implementation. See ../../docs/evaluations/blind-prerequisites-20260918/report.md and scripts/prepare-local.ps1.

# Blind Evaluation Harness

Production-like blind evaluation harness for USTAL matching pipeline using real matching code without label leakage.

## Overview

This harness evaluates the USTAL matching pipeline on a 100-case holdout dataset using the actual production matching code:

- **Profile extraction & normalization**: Production code
- **Order embedding**: Real OpenAI API
- **Candidate retrieval**: pgvector similarity search
- **Scoring & classification**: Real `scoring.ts` and `classifyMatchType()`
- **Blind evaluation**: expected_label sealed until post-hoc metrics calculation

## Critical Invariants

### Label Sealing

The expected_label is NEVER accessed during matching pipeline execution:

```
Input: profile + order (expected_label sealed in database)
  ↓
Processing: matching-run.ts (no label access)
  ↓
Inference: scoring.ts computes blind prediction
  ↓
Output: prediction stored in matching_candidates
  ↓
Evaluation: expected_label unsealed ONLY for metrics (post-hoc)
```

### Database Isolation

Test database is isolated from production:

- **Database**: `ustal_test` (separate from production)
- **Schema**: `blind_evaluation` (isolated namespace)
- **User**: `ustal_test` (test credentials)
- **Connection**: TEST_DB_* environment variables only

### Data Flow

1. **Inference phase**: Profile + order only, no label access
2. **Prediction extraction**: Reads matching_candidates, not expected_label
3. **Post-hoc evaluation**: Unseals expected_label only after predictions sealed

## Setup

### Prerequisites

- PostgreSQL 14+ with pgvector extension
- Node.js 20+
- OpenAI API key (for real evaluation)
- Test database credentials

### Step 1: Verify Isolation

```bash
npm run blind:verify-isolation
```

Performs code-level and config-level audit to ensure label sealing.

### Step 2: Setup Test Database

```bash
npm run blind:setup-db
```

Creates isolated test database with:
- `ustal_test` database
- `blind_evaluation` schema
- `holdout_cases` table (stores cases + sealed expected_label)
- `matching_candidates` table (stores predictions)

Environment variables:
- `TEST_DB_HOST` (default: localhost)
- `TEST_DB_PORT` (default: 5432)
- `TEST_DB_NAME` (default: ustal_test)
- `TEST_DB_USER` (default: ustal_test)
- `TEST_DB_PASSWORD` (default: test_password)

### Step 3: Load Holdout Data

```bash
npm run blind:load-data
```

Loads `docs/evaluations/semantic-blind-holdout-100.json` into test database:
- Inserts 100 test cases
- Stores expected_label (sealed until post-hoc)
- Creates indices for fast lookups

### Step 4: Run Blind Evaluation

⚠️ **WARNING: Calls OpenAI API (~$2-5 cost)**

```bash
# Dry-run validation (no API calls):
npm run blind:evaluate -- --dry-run

# Real evaluation (calls OpenAI):
export CONFIRM_EVALUATION=true
npm run blind:evaluate
```

Pipeline execution:
1. Reads 100 holdout cases (profile + order, label sealed)
2. Calls `handleMatchingRun()` from production matching-run.ts
3. Extracts predictions from matching_candidates table
4. Stores predictions WITHOUT accessing expected_label
5. Unseals expected_label for post-hoc evaluation

### Step 5: Analyze Results

```bash
npm run blind:analyze
```

Computes metrics:
- Confusion matrix: TP, TN, FP, FN
- Classification metrics: precision, recall, F1, accuracy
- Error analysis: false positives and false negatives

## File Structure

```
blind-evaluation/
├── scripts/
│   ├── verify-isolation.ts       # Static analysis audit (label sealing)
│   ├── setup-test-db.ts          # Create isolated test database
│   ├── load-holdout-data.ts      # Load 100 test cases
│   ├── run-blind-evaluation.ts   # Main blind evaluation pipeline
│   └── analyze-results.ts        # Compute metrics and error analysis
├── src/
│   ├── test-db-config.ts         # Test database isolation config
│   ├── holdout-injector.ts       # Load holdout dataset
│   ├── prediction-extractor.ts   # Extract predictions (sealed)
│   └── metrics-calculator.ts     # Compute confusion matrix & metrics
├── tests/
│   └── isolation.test.ts         # Unit tests for isolation guarantees
├── package.json
├── tsconfig.json
└── README.md (this file)
```

## Execution Examples

### Example 1: Full Pipeline (Dry-Run)

```bash
# Step 1: Verify isolation
npm run blind:verify-isolation

# Step 2: Setup isolated test database
npm run blind:setup-db

# Step 3: Load holdout dataset
npm run blind:load-data

# Step 4: Validate without calling OpenAI
npm run blind:evaluate -- --dry-run

# Step 5: Check results
npm run blind:analyze
```

Expected output:
- ✓ All isolation checks pass
- ✓ Test database created and isolated
- ✓ 100 holdout cases loaded
- ✓ Dry-run validation complete (no API costs)

### Example 2: Full Blind Evaluation (Real)

```bash
# Prerequisites: Steps 1-3 from Example 1 already completed

# Step 4: Real evaluation (~$2-5 for OpenAI API)
export CONFIRM_EVALUATION=true
npm run blind:evaluate

# Step 5: Analyze results
npm run blind:analyze
```

Expected output:
- ✓ Predictions extracted from production pipeline
- ✓ 100 cases evaluated
- Confusion matrix (TP, TN, FP, FN)
- Classification metrics (precision, recall, F1)
- Error analysis

### Example 3: Test Isolation

```bash
npm test
# or
node --test tests/isolation.test.ts
```

Verifies:
- ✓ Test database isolated from production
- ✓ expected_label not accessed during inference
- ✓ Data flow invariants maintained

## Architecture

### Production Code Reused

1. **matching-run.ts**: Main orchestration
   - Retrieves candidates from database
   - Calls scoring pipeline
   - Classifies match type

2. **scoring.ts**: Scoring algorithm
   - `computeScore()`: Weighted sum of features
   - `classifyMatchType()`: Classification logic

3. **requirements.ts**: Capability matching

### Test-Specific Code

1. **test-db-config.ts**: Isolated test database connection
2. **holdout-injector.ts**: Load test dataset with sealed labels
3. **prediction-extractor.ts**: Extract predictions without label access
4. **metrics-calculator.ts**: Compute confusion matrix post-hoc

### Data Tables

#### holdout_cases
```
id              UUID
case_id         VARCHAR (unique)
skill           VARCHAR
order_description TEXT
profile_json    JSONB
order_json      JSONB
expected_label  VARCHAR ('MATCH' or 'REJECT')
sealed          BOOLEAN (false during inference, true after)
created_at      TIMESTAMP
```

#### matching_candidates
```
id              UUID
case_id         VARCHAR
user_id         VARCHAR
score           NUMERIC
match_type      VARCHAR
created_at      TIMESTAMP

FOREIGN KEY (case_id) → holdout_cases.case_id
```

Note: `expected_label` is NOT in `matching_candidates` table, preventing accidental access during prediction.

## Safety Constraints

### What MUST Be Used
- ✓ Real production matching-run.ts
- ✓ Real scoring.ts and classifyMatchType()
- ✓ Real OpenAI API for embeddings
- ✓ Separate test database (ustal_test, blind_evaluation schema)
- ✓ Test database credentials (TEST_DB_*)

### What MUST NOT Be Used
- ✗ Custom matching logic or improvements
- ✗ Mock OpenAI provider
- ✗ Production database (will be rejected)
- ✗ expected_label during inference (code prevents this)
- ✗ Threshold adjustments based on holdout results
- ✗ Feedback loops to improve matching

### Why These Constraints

- **Real code**: Ensures evaluation reflects actual production behavior
- **Separate test DB**: Prevents accidental production data modification
- **No label during inference**: Maintains blind evaluation integrity
- **No feedback loops**: Prevents overfitting to holdout dataset

## Cost Estimation

### OpenAI API Calls

1. **Order embeddings**: ~100 × $0.02 = ~$2
2. **Retrieval queries**: Minimal cost (pgvector searches)
3. **Total estimated**: $2-5 USD

### Why Dry-Run First

```bash
npm run blind:evaluate -- --dry-run
```

Validates harness without OpenAI costs. Ensures pipeline is ready before spending budget.

## Troubleshooting

### Test Database Not Found

```bash
npm run blind:setup-db
```

Ensure PostgreSQL is running with superuser access.

### OpenAI API Key Not Set

```bash
export OPENAI_API_KEY=sk_test_...
```

Get API key from: https://platform.openai.com/api-keys

### Isolation Tests Fail

```bash
npm run blind:verify-isolation
```

Check:
- Database name includes "test"
- Schema is "blind_evaluation"
- User is not "postgres" or "ustal"
- Connection uses TEST_DB_* variables

### Holdout Cases Not Loading

```bash
npm run blind:load-data
```

Ensure:
- Test database exists: `npm run blind:setup-db`
- File exists: `docs/evaluations/semantic-blind-holdout-100.json`
- Database user has INSERT privileges on blind_evaluation schema

## References

- **Matching pipeline**: `/apps/worker/src/handlers/matching-run.ts`
- **Scoring algorithm**: `/packages/matching/src/scoring.ts`
- **Holdout dataset**: `/docs/evaluations/semantic-blind-holdout-100.json`
- **Architecture**: `/docs/architecture.md` (§5)
- **Matching spec**: `/docs/matching.md` (§13)

## Future Work

- Implement holdout case injection with real database schema
- Wire production matching-run handler to test cases
- Support profile/order extraction from holdout JSON
- Add streaming results to avoid memory issues with large datasets
- Support multiple holdout datasets (bootstrap, cross-validation)

## Environment loading

All DB-backed scripts load the repository root `.env` through `@ustal/config` / `loadDotenvOnce`, independent of the working directory. The path for this worktree is `C:\Users\User\Desktop\ustal-codex\.env` (inside the directory, not `ustal-codex.env`). Explicit process variables take precedence. Do not copy credentials into this package; `BLIND_AI_ENV_FILE` and the old sibling-worktree fallback are no longer used.

Live evaluation requires `AI_PROVIDER=openai`, a valid `OPENAI_BASE_URL`, `OPENAI_API_KEY` (relay client token), and `CONFIRM_EVALUATION=true`. Missing AI settings fail before database access. Authentication failures remain errors; no fallback to mock is used. Dry/offline runs still force mock. The evaluator always connects via isolated local `TEST_DB_*`, never the application's `DATABASE_URL`; pipeline imports happen only after that override. Setup additionally requires the local PostgreSQL administrator's `TEST_DB_ADMIN_USER` and `TEST_DB_ADMIN_PASSWORD`, supplied in the environment.
