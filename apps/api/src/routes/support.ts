import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@ustal/database";
import { loadEnv } from "@ustal/config";
import { createSupportSender, type SupportSender } from "../lib/support-mail.js";

const bodySchema = z.object({
  text: z.string().trim().min(5).max(2000),
  appVersion: z.string().max(40).optional(),
}).strict();

const PER_USER_PER_HOUR = 5;

/**
 * POST /support — обращение из приложения уходит письмом на адрес поддержки (SUPPORT_EMAIL_TO).
 * Только для вошедшего пользователя; имя и телефон берутся из БД, а не из тела запроса.
 * В БД ничего не пишется; лимит — 5 обращений в час на пользователя (в памяти процесса).
 */
export default async function supportRoutes(app: FastifyInstance, options: { sender?: SupportSender | null } = {}) {
  const sender = options.sender !== undefined ? options.sender : createSupportSender(loadEnv());
  const recent = new Map<string, number[]>();

  app.post("/support", { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_support_message", message: "Опишите проблему (от 5 до 2000 символов)" } });
    if (!sender) return reply.code(503).send({ error: { code: "support_unavailable", message: "Отправка обращений временно недоступна" } });

    const now = Date.now();
    const times = (recent.get(request.userId) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= PER_USER_PER_HOUR) return reply.code(429).send({ error: { code: "rate_limited", message: "Слишком много обращений — попробуйте через час" } });

    const db = getDb();
    const [user] = await db.select({ phone: schema.users.phone }).from(schema.users).where(eq(schema.users.id, request.userId));
    const profile = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, request.userId) });
    try {
      await sender({ userId: request.userId, name: profile?.name ?? null, phone: user?.phone ?? null,
        text: parsed.data.text, appVersion: parsed.data.appVersion ?? null, sentAt: new Date(now) });
    } catch (err) {
      request.log.error({ err: { message: (err as Error).message } }, "support mail failed");
      return reply.code(502).send({ error: { code: "support_send_failed", message: "Не удалось отправить обращение — попробуйте позже" } });
    }
    times.push(now);
    recent.set(request.userId, times);
    return reply.code(202).send({ sent: true });
  });
}
