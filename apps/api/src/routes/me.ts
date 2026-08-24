import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";

export default async function meRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, request.userId),
    });
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, request.userId) });
    if (!user || !profile) {
      return reply.code(404).send({ error: { code: "not_found", message: "Пользователь не найден" } });
    }
    return reply.send({
      id: user.id,
      phone: user.phone,
      phoneVerified: !!user.phoneVerifiedAt,
      name: profile.name,
      cityId: profile.cityId,
      whatsappPhone: profile.whatsappPhone,
    });
  });
}
