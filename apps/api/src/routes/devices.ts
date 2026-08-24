import type { FastifyInstance } from "fastify";
import { getDb, schema } from "@ustal/database";
import { registerDeviceSchema } from "@ustal/validation";

/**
 * Регистрация устройства для push (docs/api.md «Уведомления и устройства»):
 * идемпотентно по `expo_push_token` (upsert, не дубли) — повторная
 * регистрация того же устройства (перезапуск приложения, обновление токена
 * Expo) не должна плодить строки в `device_installations`. Уникальность
 * самого токена (а не пары user+token) обеспечена миграцией
 * `device_installations_token_unique` — тот же токен, переехавший на другой
 * аккаунт (переустановка на том же устройстве под другим пользователем),
 * должен просто переписать владельца, а не завести вторую строку.
 */
export default async function devicesRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/devices", { preHandler: app.authenticate }, async (request, reply) => {
    const body = registerDeviceSchema.parse(request.body);

    const [device] = await db
      .insert(schema.deviceInstallations)
      .values({
        userId: request.userId,
        expoPushToken: body.expoPushToken,
        platform: body.platform,
        lastSeenAt: new Date(),
        isActive: true,
      })
      .onConflictDoUpdate({
        target: schema.deviceInstallations.expoPushToken,
        set: {
          userId: request.userId,
          platform: body.platform,
          lastSeenAt: new Date(),
          isActive: true,
        },
      })
      .returning();
    if (!device) throw new Error("Failed to upsert device_installations row");

    return reply.code(200).send({ id: device.id, platform: device.platform, isActive: device.isActive });
  });
}
