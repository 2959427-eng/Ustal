import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getBoss, JOB_TYPES, matchingRunJobOptions } from "@ustal/queue";
import { MAX_ACTIVE_RESPONSES, MAX_DELIVERY_WAVES, nextWaveDue } from "@ustal/domain";

/**
 * Тик показа волнами (2026-10-15, @ustal/domain order-delivery). Опубликованный заказ, у которого за окно ожидания
 * набралось меньше MAX_ACTIVE_RESPONSES активных откликов, получает следующую волну: номер волны растёт, и обычный
 * matching-прогон подбирает следующих по релевантности людей города. Состояние — в orders, поэтому перезапуск worker
 * продолжает с того же места; условный UPDATE по номеру волны не даёт двум worker'ам поднять волну дважды.
 */
export async function dispatchDeliveryWaves(
  enqueue = async (orderId: string) => {
    const boss = await getBoss();
    await boss.send(JOB_TYPES.MATCHING_RUN, { orderId }, matchingRunJobOptions({ retryLimit: 3 }));
  },
  now: Date = new Date(),
) {
  const db = getDb();
  const rows = await db.select({
    id: schema.orders.id, status: schema.orders.status, deliveryWave: schema.orders.deliveryWave,
    deliveryWaveAt: schema.orders.deliveryWaveAt, deliveredWave: schema.orders.deliveredWave, publishedAt: schema.orders.publishedAt,
    deliveryExhaustedAt: schema.orders.deliveryExhaustedAt, responsesClosedAt: schema.orders.responsesClosedAt,
    desiredAt: schema.orders.desiredAt,
    active: sql<number>`(SELECT count(*)::int FROM responses r WHERE r.order_id=${schema.orders.id} AND r.status='active')`,
  }).from(schema.orders).where(and(
    eq(schema.orders.status, "published"), isNull(schema.orders.deliveryExhaustedAt), isNull(schema.orders.responsesClosedAt),
    lt(schema.orders.deliveryWave, MAX_DELIVERY_WAVES),
    // Волна поднимается только после того, как подбор текущей волны опубликован.
    sql`${schema.orders.deliveredWave} >= ${schema.orders.deliveryWave}`,
  )).orderBy(schema.orders.publishedAt).limit(50);
  const raised: string[] = [];
  for (const o of rows) {
    if (o.active >= MAX_ACTIVE_RESPONSES || !nextWaveDue(o, o.active, now)) continue;
    const [updated] = await db.update(schema.orders)
      .set({ deliveryWave: o.deliveryWave + 1, deliveryWaveAt: now })
      .where(and(eq(schema.orders.id, o.id), eq(schema.orders.deliveryWave, o.deliveryWave), eq(schema.orders.status, "published")))
      .returning({ id: schema.orders.id });
    if (!updated) continue;
    await enqueue(o.id);
    raised.push(o.id);
  }
  if (raised.length) console.log(JSON.stringify({ event: "order_delivery_waves_raised", count: raised.length }));
  return raised;
}
