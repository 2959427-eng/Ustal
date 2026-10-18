import { describe, it, expect } from "vitest";
import { planCarryForward } from "./profile-merge.js";

const item = (id: string, label: string) => ({ ontologyNodeId: id, label });

describe("planCarryForward (накопительный профиль)", () => {
  it("тот же узел с другим label: прежний label сохраняется, дубликат не переносится", () => {
    const plan = planCarryForward([item("n1", "сборка мебели")], [item("n1", "Могу собирать мебель")], new Set());
    expect(plan.toInsert).toEqual([]);
    expect(plan.preserved.get("n1")?.label).toBe("сборка мебели");
  });

  it("новый узел остаётся в черновике (в перенос не попадает)", () => {
    const plan = planCarryForward([item("n1", "сборка мебели")], [item("n1", "x"), item("n2", "покос травы")], new Set());
    expect(plan.toInsert).toEqual([]);
    expect(plan.preserved.has("n2")).toBe(false);
  });

  it("старый узел, отсутствующий в новом extraction, переносится", () => {
    const plan = planCarryForward([item("n1", "сборка мебели"), item("n2", "дрель")], [item("n3", "автомобиль")], new Set());
    expect(plan.toInsert.map((i) => i.label)).toEqual(["сборка мебели", "дрель"]);
  });

  it("явно исключённый узел не переносится", () => {
    const plan = planCarryForward([item("n1", "сборка мебели"), item("n2", "дрель")], [], new Set(["n2"]));
    expect(plan.toInsert.map((i) => i.label)).toEqual(["сборка мебели"]);
  });

  it("пример из продукта: 2 старых + 4 новых => 6 пунктов", () => {
    const prior = [item("assembly", "сборка мебели"), item("drill", "дрель")];
    const draft = [
      item("assembly", "Могу собирать мебель"),
      item("drill", "есть дрель"),
      item("labor", "физическая работа"),
      item("car_repair", "ремонт машины"),
      item("lawn", "покос травы"),
      item("car", "автомобиль"),
    ];
    const plan = planCarryForward(prior, draft, new Set());
    const finalLabels = draft.map((d) => plan.preserved.get(d.ontologyNodeId)?.label ?? d.label);
    expect(finalLabels).toEqual(["сборка мебели", "дрель", "физическая работа", "ремонт машины", "покос травы", "автомобиль"]);
    expect(plan.toInsert).toEqual([]);
  });
});
