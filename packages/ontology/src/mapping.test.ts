import { describe, expect, it } from "vitest";
import { findOntologyNodeForPhrase } from "./mapping.js";

/**
 * Регрессионный тест на РЕАЛЬНОЙ БД — findOntologyNodeForPhrase ходит прямо в
 * Postgres (packages/database/src/client.ts), замокать здесь нечего. Требует
 * применённого seed (packages/database/src/seed.ts — `npm run db:seed
 * --workspace=@ustal/database`) и настоящего DATABASE_URL (env.ts). ВАЖНО:
 * прогоняйте против тестовой/изолированной БД, не против продакшна — этот
 * тест только читает, ничего не пишет, но подключается к тому DATABASE_URL,
 * что настроен в окружении, как и любой другой код пакета.
 *
 * ROOT CAUSE критического бага matching (2026-09-14, докладная от
 * пользователя: "User 2 добавил навык Грузчик, User 1 создал заказ на
 * грузчика, заказ не появился в Возможностях"): профессия "Грузчик" не имела
 * НИ узла, НИ синонима во всём справочнике ontology_nodes/ontology_synonyms.
 * findOntologyNodeForPhrase (см. mapping.ts) делает ТОЛЬКО точное (без учёта
 * регистра) совпадение с name_ru либо ontology_synonyms.phrase_ru — никакой
 * fuzzy/семантической логики на этом уровне нет и не должно быть (это
 * низкоуровневый canonical-matching слой; семантика — отдельный сигнал через
 * pgvector embeddings в matching-run.ts). Из-за отсутствия записи ни
 * capability пользователя ("Грузчик"), ни requiredCapability заказа ("Нужен
 * грузчик") не находили canonical-узел независимо друг от друга — оба уходили
 * в ontology_candidates как несовпавший текст, structural-сигналы matching
 * оставались нулевыми, и единственным сигналом оставалась слабая (вес 0.15)
 * semantic similarity, не гарантированно проходящая порог. Фикс — добавлены
 * синонимы "грузчик"/"грузчики" на узел "loading" (погрузка) в
 * packages/database/src/seed.ts, по тому же паттерну, что уже применён для
 * других профессий-синонимов в этом справочнике (электрик -> electrical_work,
 * газовщик -> gas_work, сантехник -> plumbing_repair).
 */
describe("findOntologyNodeForPhrase — регрессия «Грузчик»", () => {
  it("резолвит «Грузчик» в активный узел онтологии (было: null)", async () => {
    const match = await findOntologyNodeForPhrase("Грузчик");
    expect(match).not.toBeNull();
    expect(match?.canonicalKey).toBe("loading");
  });

  it("резолвит множественное число «грузчики» в тот же узел, что и единственное", async () => {
    const singular = await findOntologyNodeForPhrase("Грузчик");
    const plural = await findOntologyNodeForPhrase("грузчики");
    expect(plural).not.toBeNull();
    expect(plural?.ontologyNodeId).toBe(singular?.ontologyNodeId);
  });

  it("не зависит от регистра (findOntologyNodeForPhrase сравнивает lower() с обеих сторон)", async () => {
    const upper = await findOntologyNodeForPhrase("ГРУЗЧИК");
    const mixed = await findOntologyNodeForPhrase("Грузчик");
    expect(upper).not.toBeNull();
    expect(upper?.ontologyNodeId).toBe(mixed?.ontologyNodeId);
  });

  it("не задевает существующий узел «переезд под ключ» (синоним «услуги грузчиков» остаётся на moving_full)", async () => {
    const movingService = await findOntologyNodeForPhrase("услуги грузчиков");
    expect(movingService).not.toBeNull();
    expect(movingService?.canonicalKey).toBe("moving_full");
  });
});
