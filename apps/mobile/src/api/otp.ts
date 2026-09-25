import { apiClient } from "./client";

/**
 * Подтверждение телефона (OTP). Пока PHONE_VERIFICATION_MODE=disabled на сервере
 * (значение по умолчанию), все эти ручки отвечают 404 — экраны регистрации и
 * входа их не вызывают и работают как раньше. Готово заранее, чтобы включение
 * SMS на бэкенде не требовало переделки формы регистрации — только добавление
 * шага ввода кода в UI.
 */

export interface OtpSentResponse {
  sent: true;
}

export interface PhoneVerificationToken {
  phoneVerificationToken: string;
  expiresInSeconds: number;
}

/** POST /auth/otp/request — код на номер, который ещё не привязан к аккаунту (регистрация). */
export function requestRegistrationOtp(phone: string): Promise<OtpSentResponse> {
  return apiClient.request<OtpSentResponse>("/auth/otp/request", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
}

/** POST /auth/otp/verify — код подтверждён → короткоживущий токен для POST /auth/register. */
export function verifyRegistrationOtp(phone: string, code: string): Promise<PhoneVerificationToken> {
  return apiClient.request<PhoneVerificationToken>("/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phone, code }),
  });
}

/** POST /me/phone/otp/request — уже вошедший пользователь подтверждает свой номер (не блокирует). */
export function requestOwnPhoneOtp(): Promise<OtpSentResponse> {
  return apiClient.request<OtpSentResponse>("/me/phone/otp/request", { method: "POST" });
}

/** POST /me/phone/otp/verify — код на своём номере подтверждён. */
export function verifyOwnPhoneOtp(code: string): Promise<void> {
  return apiClient.request<void>("/me/phone/otp/verify", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}
