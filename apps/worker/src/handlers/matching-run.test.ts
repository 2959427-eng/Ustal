import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb, getSql, schema } from "@ustal/database";
import { findOntologyNodeForPhrase } from "@ustal/ontology";
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
