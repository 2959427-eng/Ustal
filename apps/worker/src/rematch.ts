import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getBoss, JOB_TYPES } from "@ustal/queue";

/** A durable, coalescing profile-change event. At most five cities/users x 25 orders per tick. */
export async function dispatchRematches(
  enqueue = async (orderId: string) => {
    const boss = await getBoss();
    await boss.send(JOB_TYPES.MATCHING_RUN, { orderId }, { retryLimit: 3 });
  },
) {
  return getDb().transaction(async (tx) => {
    const requests = await tx
      .select()
      .from(schema.rematchRequests)
      .where(
        sql`cursor is null or cursor <> 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid`,
      )
      .orderBy(schema.rematchRequests.requestedAt)
      .limit(5)
      .for("update", { skipLocked: true });
    let queued = 0;
    for (const request of requests) {
      const user = await tx.query.userProfiles.findFirst({
        where: eq(schema.userProfiles.userId, request.userId),
      });
      if (!user) {
        await tx
          .delete(schema.rematchRequests)
          .where(eq(schema.rematchRequests.userId, request.userId));
        continue;
      }
      const orders = await tx
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.cityId, user.cityId),
            eq(schema.orders.status, "published"),
            sql`${schema.orders.authorId} <> ${request.userId}`,
            sql`${schema.orders.id} > ${request.cursor ?? "00000000-0000-0000-0000-000000000000"}::uuid`,
          ),
        )
        .orderBy(schema.orders.id)
        .limit(25);
      for (const order of orders) {
        await enqueue(order.id);
        queued++;
      }
      // Retain the event watermark after dispatch. Old feed rows must stay hidden while
      // queued jobs are still pending (deleting this row would briefly resurrect them).
      if (orders.length < 25)
        await tx
          .update(schema.rematchRequests)
          .set({ cursor: "ffffffff-ffff-ffff-ffff-ffffffffffff" })
          .where(eq(schema.rematchRequests.userId, request.userId));
      else
        await tx
          .update(schema.rematchRequests)
          .set({ cursor: orders.at(-1)!.id })
          .where(eq(schema.rematchRequests.userId, request.userId));
    }
    return queued;
  });
}
