import { and, eq, inArray, or, sql } from "drizzle-orm";
import { schema } from "@ustal/database";
import { assertOrderTransition } from "@ustal/domain";

// Работает и с getDb(), и с tx внутри транзакции.
type Db = Pick<ReturnType<typeof import("@ustal/database").getDb>, "select" | "update" | "delete" | "execute">;

/** Есть ли блокировка между двумя пользователями в любую сторону. */
export async function areBlocked(db: Pick<Db, "select">, a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.blocks.id })
    .from(schema.blocks)
    .where(
      or(
        and(eq(schema.blocks.blockerId, a), eq(schema.blocks.blockedId, b)),
        and(eq(schema.blocks.blockerId, b), eq(schema.blocks.blockedId, a)),
      ),
    )
    .limit(1);
  return !!row;
}

/** Все, с кем у пользователя есть блокировка в любую сторону. */
export async function blockedCounterparts(db: Pick<Db, "select">, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ blockerId: schema.blocks.blockerId, blockedId: schema.blocks.blockedId })
    .from(schema.blocks)
    .where(or(eq(schema.blocks.blockerId, userId), eq(schema.blocks.blockedId, userId)));
  return new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)));
}

/**
 * Разрывает живые отношения пары при блокировке (вызывать в транзакции):
 *  - выбор в статусе «Идут переговоры» отменяется (контакт закрывается, заказ снова «Опубликован»);
 *  - активные отклики между ними снимаются;
 *  - назначения «В работе» и завершённые НЕ трогаем — заказ можно довести до «Выполнено / Не выполнено»
 *    и оценить; контакты по ним закрыты самой блокировкой (см. чтение контактов).
 * Уведомления намеренно не отправляются: блокирующая сторона не должна «светиться».
 */
export async function severRelations(tx: Db, a: string, b: string): Promise<void> {
  const orders = await tx
    .select({ id: schema.orders.id, authorId: schema.orders.authorId })
    .from(schema.orders)
    .innerJoin(schema.responses, eq(schema.responses.orderId, schema.orders.id))
    .where(
      or(
        and(eq(schema.orders.authorId, a), eq(schema.responses.executorId, b)),
        and(eq(schema.orders.authorId, b), eq(schema.responses.executorId, a)),
      ),
    );
  const seen = new Set<string>();
  for (const o of orders) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const executorId = o.authorId === a ? b : a;
    await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${o.id} FOR UPDATE`);

    const [selected] = await tx
      .select({ id: schema.orderAssignments.id })
      .from(schema.orderAssignments)
      .where(
        and(
          eq(schema.orderAssignments.orderId, o.id),
          eq(schema.orderAssignments.executorId, executorId),
          eq(schema.orderAssignments.status, "selected"),
        ),
      );
    if (selected) {
      await tx.delete(schema.orderAssignments).where(eq(schema.orderAssignments.id, selected.id));
      await tx
        .delete(schema.contactUnlocks)
        .where(and(eq(schema.contactUnlocks.orderId, o.id), eq(schema.contactUnlocks.executorId, executorId)));
      const [current] = await tx.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, o.id));
      if (current?.status === "negotiating") {
        assertOrderTransition("negotiating", "published");
        await tx.update(schema.orders).set({ status: "published" }).where(eq(schema.orders.id, o.id));
      }
    }

    // Отклики тех, у кого нет назначения (назначенные — «В работе» и позже — остаются).
    const assigned = await tx
      .select({ id: schema.orderAssignments.id })
      .from(schema.orderAssignments)
      .where(and(eq(schema.orderAssignments.orderId, o.id), eq(schema.orderAssignments.executorId, executorId)));
    if (assigned.length === 0) {
      await tx
        .update(schema.responses)
        .set({ status: "withdrawn", updatedAt: new Date() })
        .where(
          and(
            eq(schema.responses.orderId, o.id),
            eq(schema.responses.executorId, executorId),
            inArray(schema.responses.status, ["active"]),
          ),
        );
    }
  }
}
