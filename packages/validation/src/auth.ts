import { z } from "zod";

// +7 и 10 цифр, как того требует раздел 4 ТЗ (формат +7)
export const ruPhoneSchema = z
  .string()
  .regex(/^\+7\d{10}$/, "Телефон должен быть в формате +7XXXXXXXXXX");

export const registerSchema = z.object({
  name: z.string().min(1).max(100),
  phone: ruPhoneSchema,
  password: z.string().min(8).max(200),
  cityId: z.string().uuid(),
  acceptedRules: z.literal(true),
  acceptedPdn: z.literal(true),
  // Заполняется, только когда PHONE_VERIFICATION_MODE=required_for_new (POST /auth/otp/verify
  // выдаёт токен). Пока флаг выключен, поле игнорируется — регистрация не меняется.
  phoneVerificationToken: z.string().optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  phone: ruPhoneSchema,
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;
