import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";

export default async function citiesRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/cities", async (_request, reply) => {
    const cities = await db.query.cities.findMany({ where: eq(schema.cities.isActive, true) });
    return reply.send(cities);
  });
}
