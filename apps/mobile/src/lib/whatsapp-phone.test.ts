import { expect, it } from "vitest";
import { updateProfileSchema } from "@ustal/validation";
import { normalizeWhatsappPhone, profileSaveError, WHATSAPP_PHONE_ERROR } from "./whatsapp-phone";

it.each(["+79001234567", "89001234567", "9001234567", "+7 (900) 123-45-67", "8 (900) 123 45 67"])("normalizes %s to the unchanged API contract", (raw) => {
  const body = { whatsappPhone: normalizeWhatsappPhone(raw) };
  expect(body.whatsappPhone).toBe("+79001234567");
  expect(updateProfileSchema.parse(body)).toEqual(body);
  expect(updateProfileSchema.safeParse({ whatsappPhone: raw }).success).toBe(raw === "+79001234567");
});
it.each(["", "   "])("empty WhatsApp clears the optional API field", (raw) => {
  expect(updateProfileSchema.parse({ whatsappPhone: normalizeWhatsappPhone(raw) })).toEqual({ whatsappPhone: null });
});
it.each(["123", "+790012345678", "abc9001234567", "+49001234567", "+7900123456", "+9001234567"])("rejects invalid input without truncation: %s", (raw) => {
  expect(() => normalizeWhatsappPhone(raw)).toThrow(WHATSAPP_PHONE_ERROR);
});
it("shows Russian copy rather than technical JSON", () => {
  expect(profileSaveError(new Error('[{"path":["whatsappPhone"],"code":"invalid_string"}]'))).toBe(WHATSAPP_PHONE_ERROR);
  expect(profileSaveError(new Error('[{"code":"invalid_type"}]'))).not.toContain("invalid_type");
});
