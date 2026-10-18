import { z } from "zod";
import { ruPhoneSchema } from "./auth.js";

// POST /auth/otp/request (регистрация, номер ещё не привязан к аккаунту) и
// /me/phone/otp/request (существующий пользователь подтверждает свой номер).
export const otpRequestSchema = z.object({ phone: ruPhoneSchema });
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;

const otpCode = z.string().regex(/^\d{6}$/, "Код должен состоять из 6 цифр");

export const otpVerifySchema = z.object({ phone: ruPhoneSchema, code: otpCode });
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

export const otpCodeSchema = z.object({ code: otpCode });
export type OtpCodeInput = z.infer<typeof otpCodeSchema>;
