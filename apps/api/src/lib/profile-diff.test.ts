import { describe, it, expect } from "vitest";
import { diffByNode, diffUnmapped, pickUnmappedFacts } from "./profile-diff.js";

const item = (id: string, label: string) => ({ ontologyNodeId: id, label });

describe("diffByNode", () => {
  it("тот же ontologyNodeId с другим label => без remove/add", () => {
    const d = diffByNode([item("n1", "сборка мебели")], [item("n1", "Могу собирать мебель")]);
    expect(d).toEqual({ added: [], removed: [] });
  });

  it("новый узел => added", () => {
    const d = diffByNode([item("n1", "сборка мебели")], [item("n1", "x"), item("n2", "покос травы")]);
    expect(d).toEqual({ added: ["покос травы"], removed: [] });
  });

  it("узел исчез из черновика (явное удаление) => removed с прежним label", () => {
    const d = diffByNode([item("n1", "сборка мебели"), item("n2", "дрель")], [item("n1", "сборка мебели")]);
    expect(d).toEqual({ added: [], removed: ["дрель"] });
  });
});

describe("pickUnmappedFacts / diffUnmapped", () => {
  const fact = (kind: string, phrase: string, nodeIds: string[] = [], resourceRole: string | null = null) => ({ kind, phrase, nodeIds, resourceRole });

  it("returns only capability/resource facts without ontology node, deduped and excluding already mapped labels", () => {
    const out = pickUnmappedFacts(
      [
        fact("capability", "создаю мобильные приложения"),
        fact("capability", "Создаю мобильные приложения "),
        fact("capability", "программирование", ["n1"]),
        fact("capability", "Вождение"),
        fact("exclude", "не работаю ночью"),
        fact("availability", "по выходным"),
        fact("resource", "свой ноутбук", [], "available"),
      ],
      ["вождение"],
    );
    expect(out).toEqual([
      { kind: "capability", phrase: "создаю мобильные приложения" },
      { kind: "resource", phrase: "свой ноутбук" },
    ]);
  });

  it("hides resources that are not the executor's own assets", () => {
    const out = pickUnmappedFacts([
      fact("resource", "материалы заказчика", [], "provided_by_customer"),
      fact("resource", "нет перфоратора", [], "missing"),
      fact("resource", "доступ на 5 этаж", [], "compatibility"),
    ]);
    expect(out).toEqual([]);
  });

  it("diffUnmapped reports only phrases new in the draft", () => {
    const applied = [{ kind: "capability" as const, phrase: "таксист" }];
    const draft = [{ kind: "capability" as const, phrase: "Таксист" }, { kind: "capability" as const, phrase: "делаю сайты" }];
    expect(diffUnmapped(applied, draft)).toEqual(["делаю сайты"]);
  });
});

describe("negative facts are never displayed as skills/resources", () => {
  it("hides refusals (kind exclude or constraintType exclusion) and missing/customer/compatibility resources", () => {
    const out = pickUnmappedFacts([
      { kind: "exclude", phrase: "больше не работаю таксистом", nodeIds: [] },
      { kind: "capability", phrase: "не беру ночные заказы", nodeIds: [], constraintType: "exclusion" },
      { kind: "resource", phrase: "продал машину", nodeIds: [], resourceRole: "missing" },
      { kind: "resource", phrase: "материалы заказчика", nodeIds: [], resourceRole: "provided_by_customer" },
      { kind: "resource", phrase: "доступ на крышу", nodeIds: [], resourceRole: "compatibility" },
      { kind: "capability", phrase: "делаю сайты", nodeIds: [] },
    ]);
    expect(out).toEqual([{ kind: "capability", phrase: "делаю сайты" }]);
  });
});
