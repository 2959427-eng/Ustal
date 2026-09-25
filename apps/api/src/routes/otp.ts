import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { loadEnv } from "@ustal/config";
import { otpRequestSchema, otpVerifySchema } from "@ustal/validation";
import { OtpError, requestOtp, verifyOtp } from "../lib/otp.js";
import { signPhoneVerificationToken } from "../lib/phone-verification-token.js";

const NOT_AVAILABLE = { error: { code: "not_found", message: "Метод недоступен" } };

/**
 * OTP для АНОНИМНОГО пользователя — только регистрация нового аккаунта
 * (номер ещё никому не принадлежит). Подтверждение номера уже существующим
 * пользователем — отдельные ручки /me/phone/otp/* (routes/phone-verification.ts),
 * там нужна авторизация и телефон берётся из аккаунта, а не из тела запроса.
 *
 * Пока PHONE_VERIFICATION_MODE=disabled (dev/ранний запуск, по умолчанию) обе
 * ручки отвечают 404 — фича есть в коде, но не выставлена наружу, и
 * POST /auth/register работает как раньше, без токена подтверждения.
 */
export default async function otpRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post(
    "/auth/otp/request",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (loadEnv().PHONE_VERIFICATION_MODE === "disabled") {
        return reply.code(404).send(NOT_AVAILABLE);
      }
      const body = otpRequestSchema.parse(request.body);

      const existing = await db.query.users.findFirst({
        where: and(eq(schema.users.phone, body.phone), eq(schema.users.status, "active")),
      });
      if (existing) {
        // Тот же код и сообщение, что и в POST /auth/register — не даём OTP-ручке стать
        // отдельным способом проверить занятость номера с более узким ответом.
        return reply.code(409).send({ error: { code: "phone_taken", message: "Этот номер уже используется" } });
      }

      try {
        await requestOtp(body.phone, "register");
      } catch (err) {
        if (err instanceof OtpError) return reply.code(429).send({ error: { code: err.code, message: err.message } });
        throw err;
      }
      return reply.code(202).send({ sent: true });
    },
  );

  app.post(
    "/auth/otp/verify",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (loadEnv().PHONE_VERIFICATION_MODE === "disabled") {
        return reply.code(404).send(NOT_AVAILABLE);
      }
      const body = otpVerifySchema.parse(request.body);

      const ok = await verifyOtp(body.phone, body.code, "register");
      if (!ok) {
        return reply.code(400).send({ error: { code: "invalid_code", message: "Неверный или истёкший код" } });
      }
      const phoneVerificationToken = signPhoneVerificationToken(body.phone);
      return reply.send({ phoneVerificationToken, expiresInSeconds: 15 * 60 });
    },
  );
}
