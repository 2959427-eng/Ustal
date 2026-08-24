"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@ustal/database";
import { assertOrderTransition } from "@ustal/domain";
import { requireAdminSession } from "../../../lib/session";
import { notifyUser } from "../../../lib/notify";

export type ModerationDecision = "allow" | "allow_with_warning" | "reject";

/**
 * Решение админа по заказу в moderation_hold (docs/api.md
 * `PATCH /admin/moderation/{id}`, architecture.md §5 п.7). Не перезаписывает
 * исходное AI/rule-решение — добавляет НОВУЮ строку в moderation_cases,
 * помеченную resolved_by_admin_id (тот же принцип «AI-результаты
 * версионируются», применённый к решению живого модератора). orders.status
 * машина уже поддерживает moderation_hold -> published напрямую (см.
 * packages/domain/src/order.ts) — override на allow НЕ меняет order.status,
 * просто снимает блокировку с POST /orders/{id}/publish (публикация всё
 * равно остаётся отдельным явным действием автора); override на reject
 * переводит заказ в терминальный статус rejected.
 */
export async function resolveModerationAction(orderId: string, decision: ModerationDecision, formData: FormData) {
  const admin = requireAdminSession();
  const note = String(formData.get("note") ?? "");
  const db = getDb();

  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  if (!order || order.status !== "moderation_hold") {
    throw new Error("Заказ не найден или уже не в статусе moderation_hold");
  }

  await db.insert(schema.moderationCases).values({
    orderId,
    decision,
    reason: note || `Решение администратора (${admin.email})`,
    resolvedByAdminId: admin.sub,
  });

  await db.update(schema.orders).set({ moderationStatus: decision }).where(eq(schema.orders.id, orderId));

  if (decision === "reject") {
    assertOrderTransition("moderation_hold", "rejected");
    await db.update(schema.orders).set({ status: "rejected" }).where(eq(schema.orders.id, orderId));
  }

  await notifyUser(order.authorId, decision === "reject" ? "order_rejected_by_admin" : "order_approved_by_admin", {
    orderId,
    title: decision === "reject" ? "Заказ отклонён модератором" : "Заказ прошёл проверку",
    body: order.normalizedTitle
      ? `«${order.normalizedTitle}»: ${decision === "reject" ? "отклонён" : "можно публиковать"}`
      : decision === "reject"
        ? "Ваш заказ отклонён модератором"
        : "Ваш заказ прошёл проверку — можно публиковать",
  });

  revalidatePath("/moderation");
}
