import { describe, expect, it } from "vitest";
import { parsePriceInput } from "./price-input";

describe("parsePriceInput (F06)", () => {
  it.each([
    ["2000", 200000], ["2000.50", 200050], ["2000,50", 200050], ["2000,5", 200050], [" 2 000,50 ", 200050],
    ["2 000", 200000], ["0,99", 99],
  ])("%j → %i копеек", (text, minor) => expect(parsePriceInput(text)).toEqual({ kind: "ok", minor }));
  it.each(["", "   "])("%j → empty", (text) => expect(parsePriceInput(text)).toEqual({ kind: "empty" }));
  it.each(["20abc", "2000,505", "-5", "0", "1,2,3", ",50", "2000.", "1e3", "NaN"])("%j → invalid", (text) =>
    expect(parsePriceInput(text)).toEqual({ kind: "invalid" }));
});
