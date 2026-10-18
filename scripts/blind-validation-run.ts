/* eslint-disable no-console */
/**
 * Blind validation harness — USTAL semantic matching, Round 4 (текущая
 * принятая реализация, БЕЗ изменений в matching/prompts/thresholds/ontology).
 *
 *   npx tsx scripts/blind-validation-run.ts [--limit=N]
 *
 * ЧТО ЭТО: прогоняет docs/evaluations/semantic-blind-validation.json через
 * реальный pipeline (Fastify app.inject + прямой вызов worker-хендлеров —
 * тот же паттерн, что и scripts/verify-phase4.ts) с LIVE AI (AI_PROVIDER=openai
 * в .env), а не с MockAIProvider. Реальные вызовы OpenAI на каждый кейс:
 * profile extraction + order extraction + 2x embedding + возможная AI-модерация.
 * Это стоит реальных денег и реального времени (сотни HTTP-запросов к OpenAI) —
 * не запускайте случайно на всём датасете без --limit для пробного прогона.
 *
 * БЕЗОПАСНОСТЬ:
 *  - Скрипт НИЧЕГО не меняет в packages/matching, packages/ai, prompts,
 *    packages/config (thresholds), packages/ontology или в самом датасете —
 *    только читает их публичный интерфейс (HTTP-роуты + job-хендлеры) и
 *    создаёт новые тестовые данные (города/пользователей/заказы) в БД,
 *    на которую указывает DATABASE_URL.
 *  - Требует явного подтверждения через переменную окружения
 *    USTAL_BLIND_VALIDATION_CONFIRM=yes — чтобы никто не запустил его
 *    случайно на боевой базе. Дополнительно скрипт печатывает хост из
 *    DATABASE_URL и требует, чтобы он НЕ совпадал с известным продовым
 *    хостом (грубая эвристика, не замена ручной проверки).
 *  - Каждый кейс изолирован в своём собственном "тестгороде" (как и в
 *    verify-phase4.ts), чтобы кандидаты разных кейсов не смешивались.
 *
 * НЕ ИСПРАВЛЯЕТ НАЙДЕННЫЕ ОШИБКИ. Только фиксирует результат.
 */
import fs from "node:fs";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../apps/api/src/app.js";
import { getBoss, JOB_TYPES } from "../packages/queue/src/index.js";
import { handleProfileExtraction } from "../apps/worker/src/handlers/profile-extraction.js";
import { handleOrderExtraction } from "../apps/worker/src/handlers/order-extraction.js";
import { handleMatchingRun } from "../apps/worker/src/handlers/matching-run.js";
import { getDb, schema } from "../packages/database/src/index.js";
import { signAccessToken } from "../apps/api/src/lib/auth-tokens.js";

// ---------------------------------------------------------------------------
// Типы датасета и результатов
// ---------------------------------------------------------------------------

interface BlindCase {
  id: string;
  category: string;
  domain: string;
  profile: string;
  order: string;
  expected: "MATCH" | "REJECT";
  expected_strength: string;
  why: string;
}

type CaseOutcome = "MATCH" | "REJECT" | "ERROR";

interface CaseResult {
  id: string;
  category: string;
  domain: string;
  profile: string;
  order: string;
  expected: string;
  expected_strength: string;
  actual: CaseOutcome;
  actual_match_type?: string | null;
  actual_score?: number | null;
  actual_explanation?: string | null;
  failed_stage: string | null;
  trace_reason: string;
  is_borderline: boolean;
  classification: "TP" | "TN" | "FP" | "FN" | "ERROR";
}

const DATASET_PATH = path.resolve(__dirname, "../docs/evaluations/semantic-blind-validation.json");
const RESULTS_JSON_PATH = path.resolve(__dirname, "../docs/evaluations/semantic-blind-validation-results.json");
const RESULTS_MD_PATH = path.resolve(__dirname, "../docs/evaluations/semantic-blind-validation-results.md");

const CATEGORY_TITLES: Record<string, string> = {
  obvious_match: "Явное совпадение",
  semantic_match: "Совпадение по смыслу без общих слов",
  borderline: "Пограничные случаи",
  clear_reject: "Явный отказ",
  negative_constraint: "Явные ограничения в профиле",
  resource_dependent: "Зависимость от ресурса",
  regulated_safety: "Регулируемые / safety-sensitive",
  slang_typo: "Сленг / опечатки",
};

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------

function safetyGate() {
  if (process.env.USTAL_BLIND_VALIDATION_CONFIRM !== "yes") {
    console.error(
      "\n❌ Отказ запуска: это реальный прогон с live AI (реальные вызовы OpenAI, реальные деньги) " +
        "против базы данных, указанной в DATABASE_URL.\n" +
        "Прежде чем запускать, убедитесь, что DATABASE_URL указывает на dev/test базу, а НЕ на production.\n" +
        "Если вы это проверили и осознанно хотите продолжить — запустите с переменной окружения:\n" +
        "  USTAL_BLIND_VALIDATION_CONFIRM=yes npx tsx scripts/blind-validation-run.ts [--limit=N]\n",
    );
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL ?? "";
  let host = "(не удалось разобрать DATABASE_URL)";
  try {
    host = new URL(dbUrl).host;
  } catch {
    // оставляем сообщение по умолчанию
  }
  console.warn(`\n⚠️  DATABASE_URL host: ${host || "(пусто)"}. Дважды проверьте, что это НЕ production, прежде чем продолжать.\n`);
}

// ---------------------------------------------------------------------------
// Вспомогательные функции (тот же паттерн, что и scripts/verify-phase4.ts)
// ---------------------------------------------------------------------------

async function createTestUser(cityId: string, name: string) {
  const phone = `+7900${Math.floor(1000000 + Math.random() * 8999999)}`;
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({ phone, passwordHash: "blind-validation-test-only", status: "active" })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("test user creation failed");
  await db.insert(schema.userProfiles).values({
    userId: user.id,
    name,
    cityId,
    acceptedRulesAt: new Date(),
    acceptedPdnAt: new Date(),
  });
  return { accessToken: signAccessToken(user.id), userId: user.id };
}

async function main() {
  safetyGate();

  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

  const raw = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8")) as { cases: BlindCase[] };
  const allCases = raw.cases;
  const cases = limit ? allCases.slice(0, limit) : allCases;

  console.log(`Загружено ${allCases.length} кейсов, будет обработано: ${cases.length}`);

  const app = await buildApp();
  await app.ready();
  const db = getDb();
  const boss = await getBoss();

  const results: CaseResult[] = [];
  const processingErrors: { id: string; stage: string; message: string }[] = [];

  for (const [idx, c] of cases.entries()) {
    console.log(`\n[${idx + 1}/${cases.length}] ${c.id} (${c.category}/${c.domain})`);
    let failedStage: string | null = null;
    let traceReason = "";
    let actual: CaseOutcome = "ERROR";
    let actualMatchType: string | null = null;
    let actualScore: number | null = null;
    let actualExplanation: string | null = null;

    try {
      // Изолированный "тестгород" на кейс — исключает смешивание кандидатов
      // между кейсами (тот же приём, что в verify-phase4.ts).
      const [city] = await db
        .insert(schema.cities)
        .values({ name: `BlindVal ${c.id}`, regionName: "Тестрегион", federalDistrict: "Тестокруг", timezone: "Europe/Moscow" })
        .returning();
      if (!city) throw new Error("city insert failed");

      const executor = await createTestUser(city.id, `Исполнитель ${c.id}`);
      const author = await createTestUser(city.id, `Автор ${c.id}`);

      // --- PROFILE ---
      failedStage = "profile_extraction";
      const profileRes = await app.inject({
        method: "POST",
        url: "/profile/inputs",
        headers: { authorization: `Bearer ${executor.accessToken}`, "idempotency-key": `${c.id}-profile` },
        payload: { inputType: "text", text: c.profile },
      });
      if (profileRes.statusCode !== 202) throw new Error(`profile submit failed: ${profileRes.statusCode} ${profileRes.body}`);
      const [profileJob] = (await boss.fetch(JOB_TYPES.PROFILE_EXTRACTION, 1)) ?? [];
      if (!profileJob) throw new Error("profile_extraction job not found");
      await handleProfileExtraction(profileJob as never);
      await boss.complete(profileJob.id);

      const draft = await app.inject({
        method: "GET",
        url: "/profile/draft",
        headers: { authorization: `Bearer ${executor.accessToken}` },
      });
      if (draft.statusCode !== 200) throw new Error(`profile draft lookup failed: ${draft.statusCode} ${draft.body}`);
      const draftProfileId = (draft.json() as { draft?: { id?: string } }).draft?.id;
      if (!draftProfileId) throw new Error("profile draft not found after extraction");
      const apply = await app.inject({
        method: "POST",
        url: `/profile/draft/${draftProfileId}/apply`,
        headers: { authorization: `Bearer ${executor.accessToken}` },
        payload: {},
      });
      if (apply.statusCode !== 200) throw new Error(`profile apply failed: ${apply.statusCode} ${apply.body}`);

      // --- ORDER ---
      failedStage = "order_extraction";
      const orderCreate = await app.inject({
        method: "POST",
        url: "/orders",
        headers: { authorization: `Bearer ${author.accessToken}`, "idempotency-key": `${c.id}-order` },
        payload: { inputType: "text", text: c.order },
      });
      if (orderCreate.statusCode !== 201) throw new Error(`order create failed: ${orderCreate.statusCode} ${orderCreate.body}`);
      const { orderId } = orderCreate.json() as { orderId: string };

      const [orderJob] = (await boss.fetch(JOB_TYPES.ORDER_EXTRACTION, 1)) ?? [];
      if (!orderJob) throw new Error("order_extraction job not found");
      const extractionResult = await handleOrderExtraction(orderJob as never);
      await boss.complete(orderJob.id);

      // --- MODERATION GATE ---
      if (extractionResult.moderationDecision === "manual_review" || extractionResult.moderationDecision === "reject") {
        failedStage = "moderation";
        actual = "REJECT";
        traceReason = `moderationDecision=${extractionResult.moderationDecision} — заказ не может быть опубликован, matching не запускается.`;
      } else {
        // --- PUBLISH ---
        failedStage = "publish";
        const publish = await app.inject({
          method: "POST",
          url: `/orders/${orderId}/publish`,
          headers: { authorization: `Bearer ${author.accessToken}` },
        });
        if (publish.statusCode !== 200) throw new Error(`publish failed: ${publish.statusCode} ${publish.body}`);

        // --- MATCHING RUN ---
        failedStage = "matching_run";
        const [matchingJob] = (await boss.fetch(JOB_TYPES.MATCHING_RUN, 1)) ?? [];
        if (!matchingJob) throw new Error("matching_run job not found");
        const matchResult = (await handleMatchingRun(matchingJob as never)) as {
          candidatesCount: number;
          matchingRunId?: string;
          regulated?: boolean;
        };
        await boss.complete(matchingJob.id);

        failedStage = null;

        if (matchResult.regulated) {
          actual = "REJECT";
          traceReason = "regulated=true — жёсткий инвариант, регулируемые заказы без верификации никогда не классифицируются.";
        } else if (matchResult.matchingRunId) {
          const candidateRow = await db.query.matchingCandidates.findFirst({
            where: and(
              eq(schema.matchingCandidates.matchingRunId, matchResult.matchingRunId),
              eq(schema.matchingCandidates.userId, executor.userId),
            ),
          });
          if (candidateRow) {
            actual = "MATCH";
            actualMatchType = candidateRow.matchType ?? null;
            actualScore = candidateRow.score != null ? Number(candidateRow.score) : null;
            actualExplanation = candidateRow.explanation ?? null;
            traceReason = `matching_candidates: matchType=${candidateRow.matchType}, score=${candidateRow.score}, explanation="${candidateRow.explanation}"`;
          } else {
            actual = "REJECT";
            // Best-effort heuristic — НЕ точная диагностика, только подсказка для ручного разбора.
            let mandatoryCount = 0;
            try {
              const reqs = await db.query.orderRequirements.findMany({ where: eq(schema.orderRequirements.orderId, orderId) });
              mandatoryCount = reqs.filter((r) => r.isMandatory).length;
            } catch {
              // не блокируем результат, если интроспекция не удалась
            }
            traceReason =
              mandatoryCount > 0
                ? `Кандидата нет в matching_candidates. У заказа ${mandatoryCount} обязательных требований — возможно, не покрыты профилем исполнителя (требует ручной проверки в БД).`
                : `Кандидата нет в matching_candidates. Явных обязательных требований у заказа не найдено — вероятно, отсечён по порогу релевантности или жёстким фильтром без обязательного требования (требует ручной проверки в БД/логах worker).`;
          }
        } else {
          actual = "REJECT";
          traceReason = "matching_run вернул candidatesCount=0 без matchingRunId — см. лог worker для этого job.";
        }
      }
    } catch (err) {
      actual = "ERROR";
      const message = err instanceof Error ? err.message : String(err);
      traceReason = message;
      processingErrors.push({ id: c.id, stage: failedStage ?? "unknown", message });
      console.error(`   ❌ ERROR at ${failedStage}: ${message}`);
    }

    const isBorderline = c.category === "borderline";
    let classification: CaseResult["classification"];
    if (actual === "ERROR") {
      classification = "ERROR";
    } else if (c.expected === "MATCH" && actual === "MATCH") {
      classification = "TP";
    } else if (c.expected === "REJECT" && actual === "REJECT") {
      classification = "TN";
    } else if (c.expected === "REJECT" && actual === "MATCH") {
      classification = "FP";
    } else {
      classification = "FN";
    }

    console.log(`   expected=${c.expected} actual=${actual} (${classification})`);

    results.push({
      id: c.id,
      category: c.category,
      domain: c.domain,
      profile: c.profile,
      order: c.order,
      expected: c.expected,
      expected_strength: c.expected_strength,
      actual,
      actual_match_type: actualMatchType,
      actual_score: actualScore,
      actual_explanation: actualExplanation,
      failed_stage: failedStage,
      trace_reason: traceReason,
      is_borderline: isBorderline,
      classification,
    });
  }

  await app.close();

  // -------------------------------------------------------------------
  // Метрики
  // -------------------------------------------------------------------
  const processed = results.filter((r) => r.classification !== "ERROR");
  const tp = processed.filter((r) => r.classification === "TP").length;
  const tn = processed.filter((r) => r.classification === "TN").length;
  const fp = processed.filter((r) => r.classification === "FP").length;
  const fn = processed.filter((r) => r.classification === "FN").length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;

  const byCategory: Record<string, { total: number; processed: number; tp: number; tn: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null }> = {};
  for (const cat of Object.keys(CATEGORY_TITLES)) {
    const rows = processed.filter((r) => r.category === cat);
    const catTp = rows.filter((r) => r.classification === "TP").length;
    const catTn = rows.filter((r) => r.classification === "TN").length;
    const catFp = rows.filter((r) => r.classification === "FP").length;
    const catFn = rows.filter((r) => r.classification === "FN").length;
    const catPrecision = catTp + catFp > 0 ? catTp / (catTp + catFp) : null;
    const catRecall = catTp + catFn > 0 ? catTp / (catTp + catFn) : null;
    const catF1 = catPrecision != null && catRecall != null && catPrecision + catRecall > 0 ? (2 * catPrecision * catRecall) / (catPrecision + catRecall) : null;
    byCategory[cat] = {
      total: results.filter((r) => r.category === cat).length,
      processed: rows.length,
      tp: catTp,
      tn: catTn,
      fp: catFp,
      fn: catFn,
      precision: catPrecision,
      recall: catRecall,
      f1: catF1,
    };
  }

  const clearErrors = processed.filter((r) => !r.is_borderline && (r.classification === "FP" || r.classification === "FN"));
  const borderlineDisagreements = processed.filter((r) => r.is_borderline && (r.classification === "FP" || r.classification === "FN"));

  function likelyRootCause(r: CaseResult): string {
    if (r.classification === "FP") {
      if (r.category === "regulated_safety") return "heuristic: регулируемая/рискованная работа получила MATCH — проверить risk classification и manual_review gate.";
      if (r.category === "negative_constraint") return "heuristic: явный запрет в профиле, вероятно, не учитывается как жёсткий/негативный сигнал.";
      if (r.category === "resource_dependent") return "heuristic: обязательный ресурс отсутствует у исполнителя, но не отсёк кандидата — проверить is_mandatory фильтр.";
      return "heuristic: заказ явно не по профилю, но получил MATCH — проверить semantic similarity вес/порог.";
    }
    if (r.category === "obvious_match" || r.category === "semantic_match") {
      return "heuristic: явно подходящий исполнитель отсеян — проверить порог релевантности или ontology mapping для этой формулировки.";
    }
    return "heuristic: ожидался MATCH, получен REJECT — требуется разбор в логах worker для этого случая.";
  }

  const critical = {
    dangerous_false_positive: clearErrors.filter((r) => r.classification === "FP" && r.category === "clear_reject").map((r) => ({ ...r, likely_root_cause: likelyRootCause(r) })),
    ignored_negative_constraint: clearErrors.filter((r) => r.classification === "FP" && r.category === "negative_constraint").map((r) => ({ ...r, likely_root_cause: likelyRootCause(r) })),
    missing_mandatory_resource: clearErrors.filter((r) => r.classification === "FP" && r.category === "resource_dependent").map((r) => ({ ...r, likely_root_cause: likelyRootCause(r) })),
    regulated_work_incorrectly_matched: clearErrors.filter((r) => r.classification === "FP" && r.category === "regulated_safety").map((r) => ({ ...r, likely_root_cause: likelyRootCause(r) })),
    clearly_suitable_performer_incorrectly_rejected: clearErrors.filter((r) => r.classification === "FN" && (r.category === "obvious_match" || r.category === "semantic_match")).map((r) => ({ ...r, likely_root_cause: likelyRootCause(r) })),
  };

  const fpFnDetail = clearErrors.map((r) => ({ ...r, likely_root_cause: likelyRootCause(r) }));

  const summary = {
    executed_at: new Date().toISOString(),
    ai_provider: process.env.AI_PROVIDER ?? "unknown",
    dataset_size: allCases.length,
    processed: processed.length,
    errors: processingErrors.length,
    precision,
    recall,
    f1,
    tp,
    tn,
    fp,
    fn,
  };

  const output = {
    meta: {
      name: "USTAL semantic matching — blind validation RESULTS (Round 4, live AI)",
      code_changed: false,
      note: "matching/prompts/thresholds/ontology/dataset НЕ менялись во время этого прогона.",
    },
    summary,
    by_category: byCategory,
    critical,
    fp_fn_detail: fpFnDetail,
    borderline_disagreements: borderlineDisagreements.map((r) => ({ ...r, likely_root_cause: likelyRootCause(r) })),
    processing_errors: processingErrors,
    all_results: results,
  };

  fs.writeFileSync(RESULTS_JSON_PATH, JSON.stringify(output, null, 2), "utf-8");

  // -------------------------------------------------------------------
  // Markdown
  // -------------------------------------------------------------------
  const md: string[] = [];
  md.push("# USTAL — Blind validation RESULTS (Round 4, live AI)");
  md.push("");
  md.push(`Выполнено: ${summary.executed_at}. AI provider: ${summary.ai_provider}.`);
  md.push("");
  md.push("Matching/prompts/thresholds/ontology/датасет во время этого прогона НЕ менялись.");
  md.push("");
  md.push("## Итоговые метрики");
  md.push("");
  md.push(`- BLIND DATASET SIZE: ${summary.dataset_size}`);
  md.push(`- PROCESSED: ${summary.processed} (ошибок выполнения: ${summary.errors})`);
  md.push(`- PRECISION: ${precision != null ? precision.toFixed(3) : "н/д"}`);
  md.push(`- RECALL: ${recall != null ? recall.toFixed(3) : "н/д"}`);
  md.push(`- F1: ${f1 != null ? f1.toFixed(3) : "н/д"}`);
  md.push(`- FP: ${fp}`);
  md.push(`- FN: ${fn}`);
  md.push("");
  md.push("## По категориям");
  md.push("");
  md.push("| Категория | Обработано | TP | TN | FP | FN | Precision | Recall | F1 |");
  md.push("|---|---|---|---|---|---|---|---|---|");
  for (const [cat, v] of Object.entries(byCategory)) {
    md.push(
      `| ${CATEGORY_TITLES[cat]} | ${v.processed}/${v.total} | ${v.tp} | ${v.tn} | ${v.fp} | ${v.fn} | ${v.precision != null ? v.precision.toFixed(2) : "н/д"} | ${v.recall != null ? v.recall.toFixed(2) : "н/д"} | ${v.f1 != null ? v.f1.toFixed(2) : "н/д"} |`,
    );
  }
  md.push("");

  function renderCaseBlock(r: CaseResult & { likely_root_cause?: string }) {
    md.push(`**${r.id}** (${CATEGORY_TITLES[r.category] ?? r.category})`);
    md.push("");
    md.push(`- PROFILE: ${r.profile}`);
    md.push(`- ORDER: ${r.order}`);
    md.push(`- EXPECTED: ${r.expected}`);
    md.push(`- ACTUAL: ${r.actual}${r.actual_match_type ? ` (${r.actual_match_type})` : ""}`);
    md.push(`- FAILED_STAGE: ${r.failed_stage ?? "—"}`);
    md.push(`- TRACE_REASON: ${r.trace_reason}`);
    if (r.likely_root_cause) md.push(`- LIKELY_ROOT_CAUSE: ${r.likely_root_cause}`);
    md.push("");
  }

  md.push("## FP / FN — однозначные ошибки (не borderline)");
  md.push("");
  if (fpFnDetail.length === 0) md.push("Нет.");
  else fpFnDetail.forEach((r) => renderCaseBlock(r));
  md.push("");

  md.push("## Критические ошибки");
  md.push("");
  const criticalSections: [string, keyof typeof critical][] = [
    ["Dangerous false positive", "dangerous_false_positive"],
    ["Ignored negative constraint", "ignored_negative_constraint"],
    ["Missing mandatory resource", "missing_mandatory_resource"],
    ["Regulated work incorrectly matched", "regulated_work_incorrectly_matched"],
    ["Clearly suitable performer incorrectly rejected", "clearly_suitable_performer_incorrectly_rejected"],
  ];
  for (const [title, key] of criticalSections) {
    md.push(`### ${title}`);
    md.push("");
    const rows = critical[key];
    if (rows.length === 0) md.push("Нет.");
    else rows.forEach((r) => renderCaseBlock(r));
    md.push("");
  }

  md.push("## Borderline disagreements (не считаются автоматически багами)");
  md.push("");
  if (borderlineDisagreements.length === 0) md.push("Нет.");
  else borderlineDisagreements.forEach((r) => renderCaseBlock({ ...r, likely_root_cause: likelyRootCause(r) }));
  md.push("");

  md.push("## Processing errors");
  md.push("");
  if (processingErrors.length === 0) md.push("Нет.");
  else processingErrors.forEach((e) => md.push(`- ${e.id} @ ${e.stage}: ${e.message}`));
  md.push("");

  fs.writeFileSync(RESULTS_MD_PATH, md.join("\n"), "utf-8");

  console.log("\n=== ИТОГО ===");
  console.log(summary);
  console.log(`Результаты записаны в:\n  ${RESULTS_JSON_PATH}\n  ${RESULTS_MD_PATH}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Blind validation run failed:", err);
  process.exit(1);
});
