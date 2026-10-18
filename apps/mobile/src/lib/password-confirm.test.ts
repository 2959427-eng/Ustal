import { expect, it } from "vitest";
import { passwordConfirmError } from "./password-confirm";

it("accepts identical passwords", () => {
  expect(passwordConfirmError("secret123", "secret123")).toBeNull();
});
it("rejects different passwords", () => {
  expect(passwordConfirmError("secret123", "secret124")).toBe("Пароли не совпадают");
});
it("asks to repeat when the confirmation is empty", () => {
  expect(passwordConfirmError("secret123", "")).toBe("Повторите пароль");
});
it("is case and whitespace sensitive", () => {
  expect(passwordConfirmError("Secret123", "secret123")).not.toBeNull();
  expect(passwordConfirmError("secret123", "secret123 ")).not.toBeNull();
});
