import jwt from "jsonwebtoken";
import { loadEnv } from "@ustal/config";

/**
 * Короткоживущий токен «этот номер только что подтверждён кодом из SMS»
 * (POST /auth/otp/verify → POST /auth/register с PHONE_VERIFICATION_MODE=
 * required_for_new). Секрет отдельный от JWT_ACCESS_SECRET: чужой access
 * token не должен по форме подходить под подтверждение телефона, и наоборот.
 */
interface PhoneVerificationPayload {
  phone: string;
  typ: "phone_verification";
}

function getSecret(): string {
  const env = loadEnv();
  if (!env.PHONE_VERIFICATION_SECRET) {
    throw new Error("PHONE_VERIFICATION_SECRET не задан — подтверждение телефона недоступно");
  }
  return env.PHONE_VERIFICATION_SECRET;
}

export function signPhoneVerificationToken(phone: string): string {
  return jwt.sign({ phone, typ: "phone_verification" } satisfies PhoneVerificationPayload, getSecret(), {
    expiresIn: "15m",
  });
}

/** Возвращает подтверждённый номер или null (истёк / подделан / не тот формат токена). */
export function verifyPhoneVerificationToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, getSecret()) as Partial<PhoneVerificationPayload>;
    if (payload.typ !== "phone_verification" || typeof payload.phone !== "string") return null;
    return payload.phone;
  } catch {
    return null;
  }
}
