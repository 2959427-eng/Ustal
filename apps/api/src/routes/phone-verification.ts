import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { loadEnv } from "@ustal/config";
import { otpCodeSchema } from "@ustal/validation";
import { OtpError, requestOtp, verifyOtp } from "../lib/otp.js";

const NOT_AVAILABLE = { error: { code: "not_found", message: "Метод недоступен" } };
const ALREADY_VERIFIED = { error: { code: "already_verified", message: "Телефон уже подтверждён" } };

/**
 * Постепенное подтверждение номера УЖЕ существующими пользователями:
 * предлагается при входе (POST /auth/login → phoneVerificationSuggested),
 * но ничего не блокирует — пользователь может подтвердить сейчас, позже
 * или никогда, пока PHONE_VERIFICATION_MODE не требует этого явно для всех
 * (сейчас требуется только для НОВЫХ регистраций, см. routes/auth.ts).
 */
export default async function phoneVerificationRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/me/phone/otp/request", { preHandler: app.authenticate }, async (request, reply) => {
    if (loadEnv().PHONE_VERIFICATION_MODE === "disabled") {
      return reply.code(404).send(NOT_AVAILABLE);
    }
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, request.userId) });
    if (!user) return reply.code(404).send({ error: { code: "not_found", message: "Пользователь не найден" } });
    if (user.phoneVerifiedAt) return reply.code(409).send(ALREADY_VERIFIED);

    try {
      await requestOtp(user.phone, "existing_user");
    } catch (err) {
      if (err instanceof OtpError) return reply.code(429).send({ error: { code: err.code, message: err.message } });
      throw err;
    }
    return reply.code(202).send({ sent: true });
  });

  app.post("/me/phone/otp/verify", { preHandler: app.authenticate }, async (request, reply) => {
    if (loadEnv().PHONE_VERIFICATION_MODE === "disabled") {
      return reply.code(404).send(NOT_AVAILABLE);
    }
    const body = otpCodeSchema.parse(request.body);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, request.userId) });
    if (!user) return reply.code(404).send({ error: { code: "not_found", message: "Пользователь не найден" } });
    if (user.phoneVerifiedAt) return reply.code(409).send(ALREADY_VERIFIED);

    const ok = await verifyOtp(user.phone, body.code, "existing_user");
    if (!ok) return reply.code(400).send({ error: { code: "invalid_code", message: "Неверный или истёкший код" } });

    await db
      .update(schema.users)
      .set({ phoneVerifiedAt: new Date(), verificationLevel: "phone" })
      .where(eq(schema.users.id, user.id));
    return reply.code(204).send();
  });
}
