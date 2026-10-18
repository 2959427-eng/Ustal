import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { areBlocked } from "../lib/blocks.js";
import { authorTitle } from "../lib/order-text.js";
import { responsesOpen } from "@ustal/domain";

/** Public order fields only. Does not expose transcripts, AI drafts or contacts.
 * Uses the same public-state/participant boundary as the existing order-author route.
 */
export default async function orderViewRoutes(app: FastifyInstance) {
  const db = getDb();
  app.get("/orders/:id/view", { preHandler: app.authenticate, schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const missing = () => reply.code(404).send({ error: { code: "not_found", message: "Заказ недоступен" } });
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, id) });
    if (!order) return missing();
    const author = await db.query.users.findFirst({ where: eq(schema.users.id, order.authorId) });
    if (author?.status !== "active" || await areBlocked(db, order.authorId, request.userId)) return missing();
    const own = order.authorId === request.userId;
    if (!own && !["published", "negotiating", "closed"].includes(order.status)) {
      const response = await db.query.responses.findFirst({ where: and(eq(schema.responses.orderId, id), eq(schema.responses.executorId, request.userId)) });
      if (!response) return missing();
    }
    const [city, media] = await Promise.all([
      db.query.cities.findFirst({ where: eq(schema.cities.id, order.cityId) }),
      db.query.orderMedia.findMany({ where: and(eq(schema.orderMedia.orderId, id), sql`${schema.orderMedia.position} >= 0`), orderBy: (t, { asc }) => asc(t.position) }),
    ]);
    // Приём откликов закрыт заказчиком или набран лимит (2026-10-15) — новый отклик невозможен.
    const active = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.responses)
      .where(and(eq(schema.responses.orderId, id), eq(schema.responses.status, "active"))))[0]?.n ?? 0;
    const accepting = responsesOpen(order, active);
    return reply.send({ id, status: order.status, title: authorTitle(order.sourceText) ?? order.normalizedTitle,
      description: order.sourceText ?? order.normalizedDescription, cityId: order.cityId, cityName: city?.name ?? null,
      priceMinor: order.priceMinor, currency: order.currency, acceptsPriceOffers: order.acceptsPriceOffers,
      photoMediaIds: media.map((m) => m.mediaId), canRespond: !own && ["published", "negotiating"].includes(order.status) && accepting,
      acceptingResponses: ["published", "negotiating"].includes(order.status) && accepting,
    });
  });
}
