import { describe, it, expect } from "vitest";
import { diffByNode, diffUnmapped, pickRestrictions, pickUnmappedFacts } from "./profile-diff.js";

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

describe("unknown physical resources (2026-10-05)", () => {
  it("a resource without ontology node is shown as a resource, never as a skill", () => {
    const facts = ["есть кофемашина", "есть стол", "есть грабли", "есть самолёт"].map((phrase) => ({ kind: "resource", phrase, nodeIds: [], resourceRole: "available" }));
    expect(pickUnmappedFacts([...facts, { kind: "capability", phrase: "вайбкодер", nodeIds: [] }])).toEqual([
      ...facts.map((f) => ({ kind: "resource", phrase: f.phrase })),
      { kind: "capability", phrase: "вайбкодер" },
    ]);
  });
});

describe("pickRestrictions — раздел «Ограничения» (2026-10-06)", () => {
  const MSG = "Умею чинить технику. Не занимаюсь доставкой после 22:00. Не выполняю перевозки. Делаю только iOS-приложения.";
  const f = (o: Record<string, unknown>) => ({ kind: "capability", phrase: "", evidence: MSG, constraintType: "none", constraintScope: "whole_task", startHour: null, endHour: null, daysOfWeek: null, ...o });
  it("builds each restriction from its saved fields (evidence is a whole message), typed time/work/scope", () => {
    expect(pickRestrictions([
      f({ kind: "availability", phrase: "доставка", constraintType: "availability", constraintScope: "fact", endHour: 22 }),
      f({ kind: "availability", phrase: "после 22:00 не работаю", constraintType: "availability", endHour: 22 }),
      f({ kind: "exclude", phrase: "перевозки", constraintType: "exclusion" }),
      f({ kind: "capability", phrase: "делаю только iOS-приложения", constraintType: "scope" }),
      f({ kind: "availability", phrase: "будни", constraintType: "availability", daysOfWeek: [4, 0, 1, 2, 3], startHour: 9, endHour: 18 }),
    ])).toEqual([
      { type: "time", text: "Доставка — до 22:00" },
      { type: "time", text: "Работаю до 22:00" },
      { type: "work", text: "Не выполняю: перевозки" },
      { type: "scope", text: "Делаю только iOS-приложения" },
      { type: "time", text: "Работаю с 9:00 до 18:00, по дням: пн, вт, ср, чт, пт" },
    ]);
  });
  it("hours attached to a skill are shown as that work's time limit", () => {
    expect(pickRestrictions([f({ kind: "capability", phrase: "ремонт бытовой техники", endHour: 18 })])).toEqual([{ type: "time", text: "Ремонт бытовой техники — до 18:00" }]);
  });
  it("the same hours repeated on a skill and as all-work hours are shown once", () => {
    expect(pickRestrictions([
      f({ kind: "capability", phrase: "ремонт бытовой техники", endHour: 18 }),
      f({ kind: "availability", phrase: "работаю до 18:00", constraintType: "availability", endHour: 18 }),
    ])).toEqual([{ type: "time", text: "Работаю до 18:00" }]);
  });
  it("never shows positive facts or resources as restrictions", () => {
    expect(pickRestrictions([
      f({ kind: "resource", phrase: "есть кофемашина" }),
      f({ kind: "resource", phrase: "машина" }),
      f({ kind: "capability", phrase: "вайбкодер" }),
    ])).toEqual([]);
  });
  it("dedupes the same restriction repeated in a cumulative profile", () => {
    const r = f({ kind: "exclude", phrase: "перевозки", constraintType: "exclusion" });
    expect(pickRestrictions([r, { ...r, evidence: "Не выполняю перевозки." }])).toHaveLength(1);
  });
});

it("lifted (superseded) restrictions are history only and never shown", () => {
  expect(pickRestrictions([{ kind: "superseded", phrase: "не работаю после 22:00", evidence: "Не работаю после 22:00.", constraintType: "none" }])).toEqual([]);
});

it("a revoked skill («Не хочу больше копать») is not a restriction; a restriction of a kept skill is", () => {
  const r = (o: Record<string, unknown>) => ({ kind: "capability", phrase: "", evidence: "x", constraintType: "none", constraintScope: "whole_task", ...o });
  expect(pickRestrictions([
    r({ kind: "exclude", phrase: "копать", constraintType: "exclusion", constraintScope: "whole_task", resourceCapacity: { value: null, unit: null, kind: "revoked" } }),
  ])).toEqual([]);
  expect(pickRestrictions([
    r({ kind: "capability", phrase: "копать" }),
    r({ kind: "exclude", phrase: "копать", constraintType: "exclusion", constraintScope: "whole_task" }),
  ])).toEqual([{ type: "work", text: "Не выполняю: копать" }]);
});

it("a sold / removed resource is not a restriction; a skill phrase as a refusal label drops «могу/умею»", () => {
  const r = (o: Record<string, unknown>) => ({ kind: "capability", phrase: "", evidence: "x", constraintType: "none", constraintScope: "whole_task", ...o });
  expect(pickRestrictions([
    r({ kind: "resource", resourceRole: "missing", phrase: "Генератор я продал", constraintType: "exclusion" }),
    r({ kind: "resource", resourceRole: "missing", phrase: "кофемашина" }),
  ])).toEqual([]);
  expect(pickRestrictions([r({ kind: "exclude", phrase: "Могу копать", constraintType: "exclusion" })])).toEqual([{ type: "work", text: "Не выполняю: копать" }]);
});

// Дни недели (2026-10-17): daysOfWeek — разрешённые дни; «Не работаю по воскресеньям» после нормализации = [0..5].
it("GET /profile shows allowed days: «Не работаю по воскресеньям» → «по дням: пн, вт, ср, чт, пт, сб»", () => {
  const [r] = pickRestrictions([{ kind: "availability", phrase: "Не работаю по воскресеньям", constraintType: "availability", constraintScope: "whole_task",
    startHour: null, endHour: null, daysOfWeek: [0, 1, 2, 3, 4, 5] }] as never);
  expect(r!.text).toMatch(/по дням: пн, вт, ср, чт, пт, сб/);
  expect(r!.text).not.toMatch(/вс/);
});
