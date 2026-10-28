import { describe, expect, it } from "vitest";
import { formatPhoneDigits, isCompletePhone, phoneDigitsFromInput, phoneFromDigits } from "./phone-input";

describe("ввод телефона на регистрации", () => {
  it("принимает только цифры и не больше 10", () => {
    expect(phoneDigitsFromInput("900 123-45-67")).toBe("9001234567");
    expect(phoneDigitsFromInput("90012345678")).toBe("9001234567");
    expect(phoneDigitsFromInput("abc9")).toBe("9");
  });
  it("вставка полного номера с +7, 7 или 8 не дублирует код страны", () => {
    for (const pasted of ["+7 900 123-45-67", "79001234567", "8 (900) 123-45-67"]) expect(phoneDigitsFromInput(pasted)).toBe("9001234567");
  });
  it("форматирует по мере ввода", () => {
    expect(formatPhoneDigits("")).toBe("");
    expect(formatPhoneDigits("900")).toBe("900");
    expect(formatPhoneDigits("90012")).toBe("900 12");
    expect(formatPhoneDigits("9001234")).toBe("900 123-4");
    expect(formatPhoneDigits("9001234567")).toBe("900 123-45-67");
  });
  it("на сервер уходит прежний формат +7XXXXXXXXXX", () => {
    expect(phoneFromDigits("9001234567")).toBe("+79001234567");
    expect(/^\+7\d{10}$/.test(phoneFromDigits("9001234567"))).toBe(true);
    expect(isCompletePhone("900123456")).toBe(false);
    expect(isCompletePhone("9001234567")).toBe(true);
  });
});
