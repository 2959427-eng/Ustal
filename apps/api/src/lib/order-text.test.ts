import { describe, it, expect } from "vitest";
import { authorTitle } from "./order-text.js";

describe("authorTitle", () => {
  it("короткий текст возвращается как есть", () => {
    expect(authorTitle("Нужно подключить стиральную машину")).toBe("Нужно подключить стиральную машину");
  });
  it("берёт первое предложение", () => {
    expect(authorTitle("Собрать шкаф. Инструмент есть, приеду вечером.")).toBe("Собрать шкаф");
  });
  it("берёт первую строку", () => {
    expect(authorTitle("Переезд\nнужны двое грузчиков")).toBe("Переезд");
  });
  it("длинный текст обрезается по границе слова с многоточием", () => {
    const t = authorTitle("Нужно перевезти мебель из двухкомнатной квартиры на другой конец города в субботу утром, есть лифт", 40)!;
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(41);
    expect(t).not.toMatch(/\s…$/);
  });
  it("пусто => null", () => {
    expect(authorTitle("  ")).toBeNull();
    expect(authorTitle(null)).toBeNull();
  });
});
