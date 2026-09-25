import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getSql, schema, assertLocalTestDatabase } from "@ustal/database";
import { findOntologyNodeForPhrase } from "@ustal/ontology";
import { mockProviders } from "@ustal/ai";
import { SEMANTIC_POLICY } from "@ustal/matching";
import { handleMatchingRun } from "./matching-run.js";

/**
 * Интеграционный тест НА РЕАЛЬНОЙ БД (getDb()/getSql() из @ustal/database —
 * подключается к тому же DATABASE_URL, что и worker/api в проде, см.
 * packages/database/src/env.ts). Ничего не мокается — это намеренно: сам баг
 * жил на стыке ontology-mapping (реальный SQL exact-match) и SQL-фильтров
 * matching-run.ts (city/author/blocks), которые юнит-тесты пакета
 * packages/matching (evaluation.test.ts) в принципе не видят — там на вход
 * подаются уже готовые синтетические ontologyNodeId, минуя ontology-mapping
 * и SQL-выборку кандидатов целиком.
 *
 * ВАЖНО ПРО БЕЗОПАСНОСТЬ ДАННЫХ: прогоняйте только против тестовой/
 * изолированной БД, НЕ против продакшна — хотя весь тестовый набор данных
 * создаётся с явным префиксом TEST_ и полностью удаляется в afterAll (city
 * помечен isActive=false, чтобы даже при сбое очистки не попасть в реальный
 * выбор города при регистрации), тест на несколько секунд вставляет
 * настоящие строки orders/users с published-статусом в ту БД, что видит
 * DATABASE_URL. См. docs/order-processing-incident-20260914.md — та же
 * оговорка стояла и у предыдущего интеграционного прогона matching (41/41
 * прошли только после переключения на изолированное окружение).
 *
 * ROOT CAUSE, который здесь регрессионно закрыт (см. также
 * packages/ontology/src/mapping.test.ts): у профессии "Грузчик" не было ни
 * узла, ни синонима в ontology_nodes/ontology_synonyms, поэтому ни capability
 * пользователя-исполнителя, ни requiredCapability заказа не находили
 * canonical-узел — заказ никогда не набирал matchType и не появлялся в
 * matching_candidates для подходящего исполнителя. Фикс —
 * packages/database/src/seed.ts (синонимы "грузчик"/"грузчики" на узел
 * "loading").
 */

assertLocalTestDatabase();
const db = getDb();
const sql = getSql();
const RUN_ID = Date.now().toString(36);

const createdCityIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];

async function makeTestCity(label: string) {
  const [city] = await db
    .insert(schema.cities)
    .values({
      name: `TEST_matching_${RUN_ID}_${label}`,
      regionName: "TEST",
      federalDistrict: "TEST",
      timezone: "Asia/Vladivostok",
      // Намеренно неактивен — тестовый город никогда не должен всплывать в
      // обычном выборе города при регистрации, даже если очистка почему-то
      // не отработает. matching-run.ts/feed.ts city-фильтр на isActive не
      // смотрит вовсе, так что на сам тест это не влияет.
      isActive: false,
    })
    .returning();
  if (!city) throw new Error("test setup: не удалось создать тестовый город");
  createdCityIds.push(city.id);
  return city;
}

async function makeUser(label: string) {
  const [user] = await db
    .insert(schema.users)
    .values({
      phone: `+7900${RUN_ID.slice(-3)}${label}`.slice(0, 20),
      passwordHash: "test-fixture-not-a-real-hash",
      status: "active",
    })
    .returning();
  if (!user) throw new Error("test setup: не удалось создать тестового пользователя");
  createdUserIds.push(user.id);
  return user;
}

async function makeProfile(userId: string, cityId: string, name: string) {
  await db.insert(schema.userProfiles).values({
    userId,
    cityId,
    name,
    acceptedRulesAt: new Date(),
    acceptedPdnAt: new Date(),
  });
}

/** Реальный ontology-mapping (та же функция, что и profile-extraction.ts) — сознательно не мокается, в этом весь смысл теста. */
async function giveCapability(userId: string, label: string) {
  const match = await findOntologyNodeForPhrase(label);
  if (!match) {
    throw new Error(
      `test setup: онтология не резолвит "${label}" — сид (packages/database/src/seed.ts) не применён или синоним ещё не добавлен`,
    );
  }
  const [profile] = await db
    .insert(schema.capabilityProfiles)
    .values({
      userId,
      summary: `Тестовый профиль: ${label}`,
      profileVersion: 1,
      extractionVersion: "test-fixture",
      status: "applied",
    })
    .returning();
  if (!profile) throw new Error("test setup: не удалось создать capability_profiles");
  await db.insert(schema.userCapabilities).values({
    capabilityProfileId: profile.id,
    ontologyNodeId: match.ontologyNodeId,
    label,
    proficiency: "basic",
    evidenceType: "explicit",
    confidence: "0.9",
  });
  return match.ontologyNodeId;
}

/** Реальный ontology-mapping для требования заказа — тот же паттерн, что order-extraction.ts. */
async function makeOrder(authorId: string, cityId: string, requirementLabel: string) {
  const match = await findOntologyNodeForPhrase(requirementLabel);
  if (!match) {
    throw new Error(`test setup: онтология не резолвит "${requirementLabel}"`);
  }
  const [order] = await db
    .insert(schema.orders)
    .values({
      authorId,
      cityId,
      sourceText: "Нужно помочь загрузить коробки и мебель в машину",
      normalizedTitle: "Нужен грузчик",
      normalizedDescription: "Нужно помочь загрузить коробки и мебель в машину",
      status: "published",
    })
    .returning();
  if (!order) throw new Error("test setup: не удалось создать заказ");
  createdOrderIds.push(order.id);
  await db.insert(schema.orderRequirements).values({
    orderId: order.id,
    ontologyNodeId: match.ontologyNodeId,
    requirementType: "required_capability",
    isMandatory: true,
  });
  return order;
}

describe("handleMatchingRun — «Грузчик» находит заказ «Нужен грузчик» (интеграционный тест, реальная БД)", () => {
  let cityMain: Awaited<ReturnType<typeof makeTestCity>>;
  let cityOther: Awaited<ReturnType<typeof makeTestCity>>;
  let author: Awaited<ReturnType<typeof makeUser>>;
  let loader: Awaited<ReturnType<typeof makeUser>>; // User B из репро
  let otherCityLoader: Awaited<ReturnType<typeof makeUser>>;
  let unrelatedSkillUser: Awaited<ReturnType<typeof makeUser>>;
  let order: Awaited<ReturnType<typeof makeOrder>>;
  let matchingResult: Extract<Awaited<ReturnType<typeof handleMatchingRun>>, { matchingRunId: string }>;

  beforeAll(async () => {
    cityMain = await makeTestCity("main");
    cityOther = await makeTestCity("other");

    author = await makeUser("1");
    await makeProfile(author.id, cityMain.id, "TEST Заказчик");
    // Автор тоже "умеет" быть грузчиком — иначе negative-тест "автор не видит
    // свой заказ" был бы бессмысленным (он и так не кандидат — profile нет).
    await giveCapability(author.id, "Грузчик");

    loader = await makeUser("2");
    await makeProfile(loader.id, cityMain.id, "TEST Грузчик Города А");
    await giveCapability(loader.id, "Грузчик"); // User B из репро пользователя

    otherCityLoader = await makeUser("3");
    await makeProfile(otherCityLoader.id, cityOther.id, "TEST Грузчик Города Б");
    await giveCapability(otherCityLoader.id, "Грузчик");

    unrelatedSkillUser = await makeUser("4");
    await makeProfile(unrelatedSkillUser.id, cityMain.id, "TEST Без Нужного Навыка");
    await giveCapability(unrelatedSkillUser.id, "уборка"); // другая, не пересекающаяся способность

    // User A из репро: заказ "Нужно помочь загрузить коробки и мебель в
    // машину" в том же городе, требование = "Грузчик" (ontology-mapping
    // реальный, как и в order-extraction.ts).
    order = await makeOrder(author.id, cityMain.id, "Грузчик");

    const result = await handleMatchingRun({
      id: `test-job-${RUN_ID}`,
      data: { orderId: order.id },
    } as never);
    if (!("matchingRunId" in result)) throw new Error("test setup: matching unexpectedly skipped");
    matchingResult = result;
  }, 30000);

  afterAll(async () => {
    // FK-safe порядок: orders каскадно тянет order_requirements/matching_runs/
    // matching_candidates; users каскадно тянет user_profiles/
    // capability_profiles/user_capabilities. cities — последними.
    if (createdOrderIds.length) {
      await db.delete(schema.orders).where(
        inArray(schema.orders.id, createdOrderIds),
      );
    }
    if (createdUserIds.length) {
      await db.delete(schema.users).where(
        inArray(schema.users.id, createdUserIds),
      );
    }
    if (createdCityIds.length) {
      await db.delete(schema.cities).where(
        inArray(schema.cities.id, createdCityIds),
      );
    }
  }, 30000);

  it("ROOT CAUSE регрессия: ontology-mapping резолвит «Грузчик» и для профиля, и для заказа в один и тот же узел", async () => {
    const forProfile = await findOntologyNodeForPhrase("Грузчик");
    expect(forProfile).not.toBeNull();
    expect(forProfile?.canonicalKey).toBe("loading");
  });

  it("позитивный сценарий пользователя: подходящий исполнитель из того же города получает заказ в matching_candidates", () => {
    expect(matchingResult.candidatesCount).toBeGreaterThan(0);
  });

  it("подходящий исполнитель — matchType 'exact', явное совпадение способности", async () => {
    const candidates = await db.query.matchingCandidates.findMany({
      where: eq(schema.matchingCandidates.matchingRunId, matchingResult.matchingRunId),
    });
    const forLoader = candidates.find((c) => c.userId === loader.id);
    expect(forLoader).toBeDefined();
    expect(forLoader?.matchType).toBe("exact");
    expect(Number(forLoader?.score)).toBeGreaterThan(0);
  });

  it("эквивалент GET /feed (apps/api/src/routes/feed.ts) реально отдаёт этот заказ подходящему исполнителю", async () => {
    const feedRows = await sql<{ order_id: string }[]>`
      SELECT o.id AS order_id
      FROM matching_candidates mc
      JOIN matching_runs mr ON mr.id = mc.matching_run_id
      JOIN orders o ON o.id = mr.order_id
      WHERE mc.user_id = ${loader.id}
        AND o.status = 'published'
        AND mr.id = (
          SELECT mr2.id FROM matching_runs mr2
          WHERE mr2.order_id = o.id
          ORDER BY mr2.started_at DESC LIMIT 1
        )
    `;
    expect(feedRows.some((r) => r.order_id === order.id)).toBe(true);
  });

  it("negative: исполнитель из другого города НЕ получает заказ (жёсткий city-фильтр)", async () => {
    const candidates = await db.query.matchingCandidates.findMany({
      where: eq(schema.matchingCandidates.matchingRunId, matchingResult.matchingRunId),
    });
    expect(candidates.some((c) => c.userId === otherCityLoader.id)).toBe(false);
  });

  it("negative: автор заказа никогда не получает собственный заказ (даже имея подходящий навык)", async () => {
    const candidates = await db.query.matchingCandidates.findMany({
      where: eq(schema.matchingCandidates.matchingRunId, matchingResult.matchingRunId),
    });
    expect(candidates.some((c) => c.userId === author.id)).toBe(false);
  });

  it("negative: пользователь без подходящего навыка НЕ получает заказ (обязательное требование не выполнено)", async () => {
    const candidates = await db.query.matchingCandidates.findMany({
      where: eq(schema.matchingCandidates.matchingRunId, matchingResult.matchingRunId),
    });
    expect(candidates.some((c) => c.userId === unrelatedSkillUser.id)).toBe(false);
  });
});


/**
 * Дефект (claude/matching-quality-audit-2026-09-23.md, п.1 — «самый опасный
 * дефект»): при исчерпании бюджета LLM-review (`SEMANTIC_POLICY.reviewLimit`)
 * весь прогон матчинга раньше падал (`throw`) внутри транзакции — заказ не
 * публиковался НИКОМУ, включая кандидатов, уже прошедших review до лимита.
 * Фикс: лимит увеличен 20 -> 100, при исчерпании review просто больше не
 * вызывается (оставшиеся кандидаты идут по deterministic/semantic fallback —
 * тому же результату evaluateSemantic(), что и без review), прогон
 * завершается штатно, ранее найденные кандидаты сохраняются.
 *
 * Реальная БД (тот же интеграционный стиль, что и выше), но LLM-провайдер
 * подменяется точечно: `mockProviders.extraction.reviewSemantic` спаится,
 * чтобы (а) детерминированно считать число реальных вызовов review и (б)
 * гарантировать, что review, когда он вызывается, подтверждает совместимость
 * — иначе даже прошедшие review кандидаты остались бы reject (дефолтный мок
 * всегда возвращает compatible:false, что не годится для этого теста).
 *
 * Заказ с riskLevel=1 заставляет КАЖДОГО кандидата пройти через review-гейт
 * (`evaluateSemantic`: `input.riskLevel > 0` требует semanticReview), при
 * этом capability-требование у всех 101 кандидатов совпадает точно —
 * единственное, что отличает прошедших лимит от не прошедших, это сам факт
 * вызова review.
 */
describe("handleMatchingRun — бюджет LLM-review (100/прогон) не валит весь прогон при исчерпании", () => {
  const BRUN = `${RUN_ID}bud`;
  const CANDIDATE_COUNT = 101;
  const cityIds: string[] = [];
  const userIds: string[] = [];
  const orderIds: string[] = [];
  let matchingResult: Extract<Awaited<ReturnType<typeof handleMatchingRun>>, { matchingRunId: string }>;
  let reviewSpy: import("vitest").MockInstance<typeof mockProviders.extraction.reviewSemantic>;

  beforeAll(async () => {
    reviewSpy = vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue({
      data: { compatible: true, confidence: 0.95, reason: "test: force review pass" },
      provider: "mock",
      model: "mock-v1",
      tokensInput: 0,
      tokensOutput: 0,
      latencyMs: 1,
    });

    const [city] = await db
      .insert(schema.cities)
      .values({
        name: `TEST_matching_${BRUN}`,
        regionName: "TEST",
        federalDistrict: "TEST",
        timezone: "Asia/Vladivostok",
        isActive: false,
      })
      .returning();
    if (!city) throw new Error("test setup: не удалось создать тестовый город");
    cityIds.push(city.id);

    const [author] = await db
      .insert(schema.users)
      .values({ phone: `+7900${BRUN.slice(-4)}au`.slice(0, 20), passwordHash: "test-fixture-not-a-real-hash", status: "active" })
      .returning();
    if (!author) throw new Error("test setup: не удалось создать заказчика");
    userIds.push(author.id);
    await db.insert(schema.userProfiles).values({
      userId: author.id, cityId: city.id, name: "TEST Заказчик budget", acceptedRulesAt: new Date(), acceptedPdnAt: new Date(),
    });

    const match = await findOntologyNodeForPhrase("Грузчик");
    if (!match) throw new Error('test setup: онтология не резолвит "Грузчик"');

    const [order] = await db
      .insert(schema.orders)
      .values({
        authorId: author.id,
        cityId: city.id,
        sourceText: "TEST budget: нужно перенести мебель",
        normalizedTitle: "TEST budget: нужно перенести мебель",
        normalizedDescription: "TEST budget: нужно перенести мебель",
        status: "published",
        riskLevel: 1, // форсирует review-гейт для КАЖДОГО кандидата, вне зависимости от совпадения способности
      })
      .returning();
    if (!order) throw new Error("test setup: не удалось создать заказ");
    orderIds.push(order.id);
    await db.insert(schema.orderRequirements).values({
      orderId: order.id, ontologyNodeId: match.ontologyNodeId, requirementType: "required_capability", isMandatory: true,
    });

    // 101 кандидат одним bulk-insert'ом на таблицу: все в одном городе, у всех
    // точное совпадение способности — единственное, что отличает прошедших
    // лимит 100 от не прошедших, это сам факт вызова review.
    const candidateRows = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
      phone: `+7900${BRUN.slice(-4)}${String(i).padStart(3, "0")}`.slice(0, 20),
      passwordHash: "test-fixture-not-a-real-hash",
      status: "active" as const,
    }));
    const insertedUsers = await db.insert(schema.users).values(candidateRows).returning();
    userIds.push(...insertedUsers.map((u) => u.id));

    await db.insert(schema.userProfiles).values(
      insertedUsers.map((u, i) => ({
        userId: u.id, cityId: city.id, name: `TEST Кандидат budget ${i}`, acceptedRulesAt: new Date(), acceptedPdnAt: new Date(),
      })),
    );
    const profiles = await db
      .insert(schema.capabilityProfiles)
      .values(
        insertedUsers.map((u) => ({
          userId: u.id, summary: "TEST budget candidate", profileVersion: 1, extractionVersion: "test-fixture", status: "applied" as const,
        })),
      )
      .returning();
    await db.insert(schema.userCapabilities).values(
      profiles.map((p) => ({
        capabilityProfileId: p.id,
        ontologyNodeId: match.ontologyNodeId,
        label: "Грузчик",
        proficiency: "basic" as const,
        evidenceType: "explicit" as const,
        confidence: "0.9",
      })),
    );

    const result = await handleMatchingRun({ id: `test-job-budget-${BRUN}`, data: { orderId: order.id } } as never);
    if (!("matchingRunId" in result)) throw new Error("test setup: matching unexpectedly skipped");
    matchingResult = result;
  }, 60000);

  afterAll(async () => {
    reviewSpy?.mockRestore();
    if (orderIds.length) await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
    if (userIds.length) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    if (cityIds.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  }, 60000);

  it("ровно 100 review-вызовов на 101 нуждающегося кандидата — лимит не превышен", () => {
    expect(reviewSpy).toHaveBeenCalledTimes(100);
  });

  it("прогон завершается штатно: completedAt проставлен, без throw/отката", async () => {
    const run = await db.query.matchingRuns.findFirst({ where: eq(schema.matchingRuns.id, matchingResult.matchingRunId) });
    expect(run).toBeDefined();
    expect(run?.completedAt).not.toBeNull();
    expect(run?.candidatesCount).toBe(100);
  });

  it("100 кандидатов, прошедших review до исчерпания лимита, сохранены как matchType='exact'", async () => {
    const candidates = await db.query.matchingCandidates.findMany({
      where: eq(schema.matchingCandidates.matchingRunId, matchingResult.matchingRunId),
    });
    expect(candidates).toHaveLength(100);
    expect(candidates.every((c) => c.matchType === "exact")).toBe(true);
  });

  it("101-й (сверх лимита) не публикуется, но не роняет прогон — trace есть у всех 101, без rollback", async () => {
    const traces = await db.query.matchingTraces.findMany({
      where: eq(schema.matchingTraces.matchingRunId, matchingResult.matchingRunId),
    });
    expect(traces).toHaveLength(101);
    const rejected = traces.filter((t) => t.decision === "reject");
    expect(rejected).toHaveLength(0);
  });

  it("кандидат сверх лимита получает deferred, а не финальный reject только из-за budget", async () => {
    const traces = await db.query.matchingTraces.findMany({
      where: eq(schema.matchingTraces.matchingRunId, matchingResult.matchingRunId),
    });
    const deferred = traces.filter((t) => t.decision === "deferred_review_budget");
    expect(deferred).toHaveLength(1);
    expect((deferred[0]?.detail as { deferred?: boolean; deferredReason?: string })?.deferredReason).toBe("review_budget_exhausted");
    // Safety-gated кандидат не публикуется до review: deferred не должен попасть в matching_candidates.
    const deferredUserId = deferred[0]?.userId;
    const candidates = await db.query.matchingCandidates.findMany({
      where: eq(schema.matchingCandidates.matchingRunId, matchingResult.matchingRunId),
    });
    expect(candidates.some((c) => c.userId === deferredUserId)).toBe(false);
  });
});


/**
 * Deferred-кандидат (claude/matching-quality-audit... продолжение фикса
 * review-budget): кандидат, недобравший review из-за исчерпанного бюджета,
 * не должен: (а) публиковаться как safety-непроверенный, (б) навсегда
 * застревать как "reject". Следующий прогон matching (свежий бюджет
 * review=0) должен суметь его обработать и, если review подтверждает
 * совместимость, опубликовать.
 *
 * SEMANTIC_POLICY.reviewLimit временно уменьшается до 1 (обычный
 * mutable-объект, не заморожен) — чтобы не поднимать 100+ кандидатов ради
 * одного сценария; восстанавливается в afterAll.
 */
describe("handleMatchingRun — deferred-кандидат восстанавливается на следующем прогоне", () => {
  const BRUN = `${RUN_ID}def`;
  const cityIds: string[] = [];
  const userIds: string[] = [];
  const orderIds: string[] = [];
  const originalReviewLimit = SEMANTIC_POLICY.reviewLimit;
  let reviewSpy: import("vitest").MockInstance<typeof mockProviders.extraction.reviewSemantic>;
  let orderId: string;
  let firstRun: Extract<Awaited<ReturnType<typeof handleMatchingRun>>, { matchingRunId: string }>;
  let deferredUserId: string;
  let keptUserId: string;

  beforeAll(async () => {
    SEMANTIC_POLICY.reviewLimit = 1;
    reviewSpy = vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue({
      data: { compatible: true, confidence: 0.95, reason: "test: force review pass" },
      provider: "mock",
      model: "mock-v1",
      tokensInput: 0,
      tokensOutput: 0,
      latencyMs: 1,
    });

    const [city] = await db
      .insert(schema.cities)
      .values({ name: `TEST_matching_${BRUN}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false })
      .returning();
    if (!city) throw new Error("test setup: не удалось создать тестовый город");
    cityIds.push(city.id);

    const [author] = await db
      .insert(schema.users)
      .values({ phone: `+7900${BRUN.slice(-4)}au`.slice(0, 20), passwordHash: "test-fixture-not-a-real-hash", status: "active" })
      .returning();
    if (!author) throw new Error("test setup: не удалось создать заказчика");
    userIds.push(author.id);
    await db.insert(schema.userProfiles).values({
      userId: author.id, cityId: city.id, name: "TEST Заказчик deferred", acceptedRulesAt: new Date(), acceptedPdnAt: new Date(),
    });

    const match = await findOntologyNodeForPhrase("Грузчик");
    if (!match) throw new Error('test setup: онтология не резолвит "Грузчик"');

    const [order] = await db
      .insert(schema.orders)
      .values({
        authorId: author.id,
        cityId: city.id,
        sourceText: "TEST deferred: нужно перенести мебель",
        normalizedTitle: "TEST deferred: нужно перенести мебель",
        normalizedDescription: "TEST deferred: нужно перенести мебель",
        status: "published",
        riskLevel: 1, // форсирует review-гейт для каждого кандидата
      })
      .returning();
    if (!order) throw new Error("test setup: не удалось создать заказ");
    orderId = order.id;
    orderIds.push(order.id);
    await db.insert(schema.orderRequirements).values({
      orderId: order.id, ontologyNodeId: match.ontologyNodeId, requirementType: "required_capability", isMandatory: true,
    });

    // Ровно 2 кандидата c reviewLimit=1: один укладывается в бюджет и
    // публикуется, второй — deferred. Какой из двух — заранее неизвестно
    // (сортировка по user_id), поэтому определяем по факту после прогона.
    const candidateRows = ["a", "b"].map((suffix) => ({
      phone: `+7900${BRUN.slice(-4)}${suffix}`.slice(0, 20),
      passwordHash: "test-fixture-not-a-real-hash",
      status: "active" as const,
    }));
    const insertedUsers = await db.insert(schema.users).values(candidateRows).returning();
    userIds.push(...insertedUsers.map((u) => u.id));
    await db.insert(schema.userProfiles).values(
      insertedUsers.map((u, i) => ({
        userId: u.id, cityId: city.id, name: `TEST Кандидат deferred ${i}`, acceptedRulesAt: new Date(), acceptedPdnAt: new Date(),
      })),
    );
    const profiles = await db
      .insert(schema.capabilityProfiles)
      .values(
        insertedUsers.map((u) => ({
          userId: u.id, summary: "TEST deferred candidate", profileVersion: 1, extractionVersion: "test-fixture", status: "applied" as const,
        })),
      )
      .returning();
    await db.insert(schema.userCapabilities).values(
      profiles.map((p) => ({
        capabilityProfileId: p.id,
        ontologyNodeId: match.ontologyNodeId,
        label: "Грузчик",
        proficiency: "basic" as const,
        evidenceType: "explicit" as const,
        confidence: "0.9",
      })),
    );

    const result = await handleMatchingRun({ id: `test-job-deferred-1-${BRUN}`, data: { orderId: order.id } } as never);
    if (!("matchingRunId" in result)) throw new Error("test setup: matching unexpectedly skipped");
    firstRun = result;

    const traces = await db.query.matchingTraces.findMany({ where: eq(schema.matchingTraces.matchingRunId, firstRun.matchingRunId) });
    const deferredTrace = traces.find((t) => t.decision === "deferred_review_budget");
    if (!deferredTrace) throw new Error("test setup: ожидался ровно один deferred-кандидат в первом прогоне");
    deferredUserId = deferredTrace.userId;
    keptUserId = insertedUsers.map((u) => u.id).find((id) => id !== deferredUserId)!;
  }, 60000);

  afterAll(async () => {
    SEMANTIC_POLICY.reviewLimit = originalReviewLimit;
    reviewSpy?.mockRestore();
    if (orderIds.length) await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
    if (userIds.length) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    if (cityIds.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  }, 60000);

  it("safety-gated кандидат (review не пройден из-за budget) не публикуется в первом прогоне", async () => {
    const candidates = await db.query.matchingCandidates.findMany({ where: eq(schema.matchingCandidates.matchingRunId, firstRun.matchingRunId) });
    expect(candidates.some((c) => c.userId === deferredUserId)).toBe(false);
    expect(candidates.some((c) => c.userId === keptUserId)).toBe(true);
  });

  it("второй прогон (свежий бюджет review) обрабатывает deferred-кандидата и публикует его", async () => {
    // Убираем уже обработанного кандидата из выборки следующего прогона (имитация "прошёл ранее"),
    // и меняем сам заказ, чтобы inputHash не переиспользовал закешированный прогон.
    await db.delete(schema.userProfiles).where(eq(schema.userProfiles.userId, keptUserId));
    await db.update(schema.orders).set({ normalizedDescription: "TEST deferred: обновлено для второго прохода" }).where(eq(schema.orders.id, orderId));

    const second = await handleMatchingRun({ id: `test-job-deferred-2-${BRUN}`, data: { orderId } } as never);
    if (!("matchingRunId" in second)) throw new Error("второй прогон неожиданно пропущен");
    expect(second.matchingRunId).not.toBe(firstRun.matchingRunId);

    const traces = await db.query.matchingTraces.findMany({ where: eq(schema.matchingTraces.matchingRunId, second.matchingRunId) });
    const deferredTraceNow = traces.find((t) => t.userId === deferredUserId);
    expect(deferredTraceNow?.decision).not.toBe("deferred_review_budget");

    const candidates = await db.query.matchingCandidates.findMany({ where: eq(schema.matchingCandidates.matchingRunId, second.matchingRunId) });
    const nowMatched = candidates.find((c) => c.userId === deferredUserId);
    expect(nowMatched).toBeDefined();
    expect(nowMatched?.matchType).toBe("exact");
  });
});


/**
 * Retrieval-фикс (аудит claude/matching-quality-audit-2026-09-23.md, п.4/6):
 * ветки shortlist в matching-run.ts (canonical/semantic/city_fallback) раньше
 * привязывали "видимость" кандидата к текущей embedding_model — кандидат без
 * canonical-пересечения способностей и с embedding, посчитанным под старую/
 * другую модель, не попадал ни в одну ветку и не получал вообще никакой
 * оценки/trace. Фикс — две новые CTE: canonical_resource (ресурсы, как и
 * capability, находятся структурно — по ontology_node_id, без embedding
 * вообще) и stale_model_fallback (ограниченный тем же LIMIT, без ANN,
 * безопасная сетка для кандидатов с "устаревшим" embedding).
 */
describe("handleMatchingRun — retrieval не теряет кандидатов из-за версии embedding_model", () => {
  const BRUN = `${RUN_ID}emb`;
  const cityIds: string[] = [];
  const userIds: string[] = [];
  const orderIds: string[] = [];
  const VEC = Array.from({ length: 1536 }, () => 0.01);
  let cityId: string;
  let authorId: string;
  let capNodeId: string;
  let vanNodeId: string;

  beforeAll(async () => {
    const [city] = await db
      .insert(schema.cities)
      .values({ name: `TEST_matching_${BRUN}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false })
      .returning();
    if (!city) throw new Error("test setup: не удалось создать тестовый город");
    cityId = city.id;
    cityIds.push(cityId);

    const [author] = await db
      .insert(schema.users)
      .values({ phone: `+7900${BRUN.slice(-4)}au`.slice(0, 20), passwordHash: "test-fixture-not-a-real-hash", status: "active" })
      .returning();
    if (!author) throw new Error("test setup: не удалось создать заказчика");
    authorId = author.id;
    userIds.push(authorId);
    await db.insert(schema.userProfiles).values({
      userId: authorId, cityId, name: "TEST Заказчик emb", acceptedRulesAt: new Date(), acceptedPdnAt: new Date(),
    });

    const cap = await findOntologyNodeForPhrase("Грузчик");
    if (!cap) throw new Error('test setup: онтология не резолвит "Грузчик"');
    capNodeId = cap.ontologyNodeId;
    const van = await findOntologyNodeForPhrase("грузовой фургон");
    if (!van) throw new Error('test setup: онтология не резолвит "грузовой фургон"');
    vanNodeId = van.ontologyNodeId;
  }, 30000);

  afterAll(async () => {
    if (orderIds.length) await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
    if (userIds.length) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    if (cityIds.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  }, 30000);

  async function makeCandidate(
    suffix: string,
    opts: { capabilityNodeId?: string; resourceNodeId?: string; embeddingModel?: string; embeddingVec?: number[] },
  ) {
    const [user] = await db
      .insert(schema.users)
      .values({ phone: `+7900${BRUN.slice(-4)}${suffix}`.slice(0, 20), passwordHash: "test-fixture-not-a-real-hash", status: "active" })
      .returning();
    if (!user) throw new Error("test setup: не удалось создать кандидата");
    userIds.push(user.id);
    await db.insert(schema.userProfiles).values({
      userId: user.id, cityId, name: `TEST Кандидат emb ${suffix}`, acceptedRulesAt: new Date(), acceptedPdnAt: new Date(),
    });
    const [profile] = await db
      .insert(schema.capabilityProfiles)
      .values({ userId: user.id, summary: "TEST emb candidate", profileVersion: 1, extractionVersion: "test-fixture", status: "applied" })
      .returning();
    if (!profile) throw new Error("test setup: не удалось создать capability_profiles");
    if (opts.capabilityNodeId) {
      await db.insert(schema.userCapabilities).values({
        capabilityProfileId: profile.id, ontologyNodeId: opts.capabilityNodeId, label: "TEST capability",
        proficiency: "basic", evidenceType: "explicit", confidence: "0.9",
      });
    }
    if (opts.resourceNodeId) {
      await db.insert(schema.userResources).values({
        capabilityProfileId: profile.id, ontologyNodeId: opts.resourceNodeId, label: "TEST resource", resourceType: "vehicle", evidenceType: "explicit", confidence: "0.9",
      });
    }
    if (opts.embeddingModel) {
      await db.insert(schema.profileEmbeddings).values({
        capabilityProfileId: profile.id, embeddingModel: opts.embeddingModel, embedding: opts.embeddingVec ?? VEC,
      });
    }
    return user;
  }

  async function makeOrder(suffix: string, requirementNodeId: string, requirementType: "required_capability" | "required_resource") {
    const [order] = await db
      .insert(schema.orders)
      .values({
        authorId, cityId, sourceText: `TEST emb order ${suffix}`, normalizedTitle: `TEST emb order ${suffix}`,
        normalizedDescription: `TEST emb order ${suffix}`, status: "published", riskLevel: 0,
      })
      .returning();
    if (!order) throw new Error("test setup: не удалось создать заказ");
    orderIds.push(order.id);
    await db.insert(schema.orderRequirements).values({
      orderId: order.id, ontologyNodeId: requirementNodeId, requirementType, isMandatory: true,
    });
    return order;
  }

  it("кандидат с текущей embedding_model находится (semantic-ветка) и матчится — recall не ухудшился", async () => {
    const order = await makeOrder("cur", capNodeId, "required_capability");
    await db.insert(schema.orderEmbeddings).values({ orderId: order.id, embeddingModel: "test-model-v2", embedding: VEC });
    // Не пересекается с требованием заказа по capability-узлу — единственный
    // сигнал для этого кандидата — embedding-схожесть документа.
    const uncleanCap = await findOntologyNodeForPhrase("уборка");
    if (!uncleanCap) throw new Error('test setup: онтология не резолвит "уборка"');
    const current = await makeCandidate("cur", { capabilityNodeId: uncleanCap.ontologyNodeId, embeddingModel: "test-model-v2", embeddingVec: VEC });

    const result = await handleMatchingRun({ id: `test-job-emb-cur-${BRUN}`, data: { orderId: order.id } } as never);
    if (!("matchingRunId" in result)) throw new Error("test setup: matching unexpectedly skipped");

    const candidates = await db.query.matchingCandidates.findMany({ where: eq(schema.matchingCandidates.matchingRunId, result.matchingRunId) });
    expect(candidates.some((c) => c.userId === current.id)).toBe(true);
  });

  it("кандидат со старой embedding_model не теряется — получает trace через stale_model_fallback (не невидим)", async () => {
    const order = await makeOrder("stale", capNodeId, "required_capability");
    await db.insert(schema.orderEmbeddings).values({ orderId: order.id, embeddingModel: "test-model-v2", embedding: VEC });
    const uncleanCap = await findOntologyNodeForPhrase("уборка");
    if (!uncleanCap) throw new Error('test setup: онтология не резолвит "уборка"');
    const stale = await makeCandidate("stl", { capabilityNodeId: uncleanCap.ontologyNodeId, embeddingModel: "test-model-v1-old", embeddingVec: VEC });

    const result = await handleMatchingRun({ id: `test-job-emb-stale-${BRUN}`, data: { orderId: order.id } } as never);
    if (!("matchingRunId" in result)) throw new Error("test setup: matching unexpectedly skipped");

    // Раньше: ни canonical (нет пересечения способностей), ни semantic/city_fallback
    // (embedding не под текущей моделью) — кандидат не получал вообще никакого trace.
    const trace = await db.query.matchingTraces.findFirst({
      where: and(eq(schema.matchingTraces.matchingRunId, result.matchingRunId), eq(schema.matchingTraces.userId, stale.id)),
    });
    expect(trace).toBeDefined();
  });

  it("canonical (точное совпадение способности) не сломан добавлением новых CTE", async () => {
    const order = await makeOrder("canonical", capNodeId, "required_capability");
    const loader = await makeCandidate("cload", { capabilityNodeId: capNodeId });

    const result = await handleMatchingRun({ id: `test-job-emb-canonical-${BRUN}`, data: { orderId: order.id } } as never);
    if (!("matchingRunId" in result)) throw new Error("test setup: matching unexpectedly skipped");

    const candidates = await db.query.matchingCandidates.findMany({ where: eq(schema.matchingCandidates.matchingRunId, result.matchingRunId) });
    const forLoader = candidates.find((c) => c.userId === loader.id);
    expect(forLoader?.matchType).toBe("exact");
  });

  it("canonical_resource: кандидат без capability, только с ресурсом и без embedding, находится и публикуется", async () => {
    const order = await makeOrder("resource", vanNodeId, "required_resource");
    const withVan = await makeCandidate("van", { resourceNodeId: vanNodeId }); // без capability, без embedding вообще

    const result = await handleMatchingRun({ id: `test-job-emb-resource-${BRUN}`, data: { orderId: order.id } } as never);
    if (!("matchingRunId" in result)) throw new Error("test setup: matching unexpectedly skipped");

    const candidates = await db.query.matchingCandidates.findMany({ where: eq(schema.matchingCandidates.matchingRunId, result.matchingRunId) });
    const forVan = candidates.find((c) => c.userId === withVan.id);
    expect(forVan).toBeDefined();
    expect(forVan?.matchType).toBe("probable");
  });

  it("stale_model_fallback ограничен SEMANTIC_POLICY.shortlist — не безлимитный full scan", async () => {
    // Isolate this shortlist from candidates created by previous cases.
    const [isolatedCity] = await db.insert(schema.cities).values({ name: `TEST bounded ${BRUN}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
    cityId = isolatedCity!.id;
    cityIds.push(cityId);
    const order = await makeOrder("bounded", capNodeId, "required_capability");
    const uncleanCap = await findOntologyNodeForPhrase("уборка");
    if (!uncleanCap) throw new Error('test setup: онтология не резолвит "уборка"');

    const COUNT = SEMANTIC_POLICY.shortlist + 5;
    const rows = Array.from({ length: COUNT }, (_, i) => ({
      phone: `+7900${BRUN.slice(-4)}s${String(i).padStart(3, "0")}`.slice(0, 20),
      passwordHash: "test-fixture-not-a-real-hash",
      status: "active" as const,
    }));
    const inserted = await db.insert(schema.users).values(rows).returning();
    userIds.push(...inserted.map((u) => u.id));
    await db.insert(schema.userProfiles).values(
      inserted.map((u, i) => ({ userId: u.id, cityId, name: `TEST bounded ${i}`, acceptedRulesAt: new Date(), acceptedPdnAt: new Date() })),
    );
    const profiles = await db
      .insert(schema.capabilityProfiles)
      .values(inserted.map((u) => ({ userId: u.id, summary: "TEST bounded", profileVersion: 1, extractionVersion: "test-fixture", status: "applied" as const })))
      .returning();
    await db.insert(schema.userCapabilities).values(
      profiles.map((p) => ({
        capabilityProfileId: p.id, ontologyNodeId: uncleanCap.ontologyNodeId, label: "TEST unrelated",
        proficiency: "basic" as const, evidenceType: "explicit" as const, confidence: "0.9",
      })),
    );
    await db.insert(schema.profileEmbeddings).values(
      profiles.map((p) => ({ capabilityProfileId: p.id, embeddingModel: "test-model-v1-old", embedding: VEC })),
    );

    const result = await handleMatchingRun({ id: `test-job-emb-bounded-${BRUN}`, data: { orderId: order.id } } as never);
    if (!("matchingRunId" in result)) throw new Error("test setup: matching unexpectedly skipped");

    const traces = await db.query.matchingTraces.findMany({
      where: and(eq(schema.matchingTraces.matchingRunId, result.matchingRunId), inArray(schema.matchingTraces.userId, inserted.map((u) => u.id))),
    });
    expect(traces.length).toBe(SEMANTIC_POLICY.shortlist);
    expect(traces.length).toBeLessThan(COUNT);
  }, 60000);
});
