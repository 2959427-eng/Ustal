import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { schema, type getDb } from "@ustal/database";
import { hashPassword } from "./password.js";
import { authorTitle } from "./order-text.js";

type Db = ReturnType<typeof getDb>;

/**
 * Удаление аккаунта (Apple 5.1.1(v), Google Play account deletion; 2026-10-19).
 *
 * Строка users НЕ удаляется физически: на неё без каскада ссылаются заказы, отклики, назначения, отзывы,
 * оценки, раскрытия контактов, жалобы и блокировки других людей — их история и репутация должны остаться
 * целыми. Аккаунт переводится в status='deleted' (вход, refresh, access-токен, matching, лента, контакты и
 * push уже фильтруют по status='active'), телефон обезличивается (освобождает номер для новой регистрации),
 * пароль становится непригодным. Личные данные удаляются физически: профиль-описание, сообщения о себе и их
 * расшифровки, AI-профиль и его факты/решения/векторы, медиа (строки + файлы — после commit), сессии,
 * устройства, уведомления, ключи идемпотентности, результаты и следы matching (candidates/traces). Обезличенное имя остаётся для
 * чужой истории («Удалённый пользователь»).
 *
 * Открытые договорённости закрываются так же, как при ручной отмене: свои открытые заказы отменяются (отклики
 * → not_selected, переговоры → cancelled, исполнителям уведомление), свои отклики отзываются, переговоры, где
 * пользователь исполнитель, отменяются (заказ возвращается в published, если других нет; заказчику
 * уведомление). Работа в процессе (in_progress в любой роли) удаление блокирует: сначала завершить её.
 */
export const DELETABLE_ORDER_STATUSES = ["draft", "processing", "processing_failed", "moderation_hold", "published", "negotiating"] as const;

export type AccountDeletionResult =
  | { status: "deleted"; mediaKeys: { provider: string; key: string }[]; cleanupIds: string[]; notices: { userId: string; type: string; payload: Record<string, unknown> }[] }
  | { status: "active_work"; orderIds: string[] }
  | { status: "gone" };

export async function deleteAccount(db: Db, userId: string, storage?: { name: string; cleanupIdentity: string }): Promise<AccountDeletionResult> {
  return db.transaction(async (tx) => {
    // Запись этого пользователя, начатая раньше (вставка с FK/триггером держит FOR KEY SHARE на users), удаление
    // дожидается и затем закрывает/удаляет. Долгий прогон matching не держит запрос бесконечно: через 10 с —
    // 55P03 → 409 «повторите» (lib/pg-errors.ts), ничего не изменено.
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId)).for("update");
    if (!user || user.status === "deleted") return { status: "gone" as const };

    // Затронутые заказы: свои открытые + чужие, где у пользователя есть отклик/назначение. Замки orders FOR UPDATE
    // в порядке id — тот же замок, что у /assignments, /start, /cancel, /close (никаких гонок с ними).
    const myOrders = await tx.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.authorId, userId));
    const myResponses = await tx.select({ orderId: schema.responses.orderId }).from(schema.responses).where(eq(schema.responses.executorId, userId));
    const ids = [...new Set([...myOrders.map((o) => o.id), ...myResponses.map((r) => r.orderId)])].sort();
    const locked = ids.length
      ? await tx.select().from(schema.orders).where(inArray(schema.orders.id, ids)).orderBy(asc(schema.orders.id)).for("update")
      : [];

    // Работа в процессе — блокирует удаление в любой роли.
    const working = ids.length
      ? await tx.select({ orderId: schema.orderAssignments.orderId, executorId: schema.orderAssignments.executorId })
        .from(schema.orderAssignments)
        .where(and(inArray(schema.orderAssignments.orderId, ids), eq(schema.orderAssignments.status, "in_progress")))
      : [];
    const authored = new Set(myOrders.map((o) => o.id));
    const blocking = working.filter((a) => a.executorId === userId || authored.has(a.orderId)).map((a) => a.orderId);
    if (blocking.length) return { status: "active_work" as const, orderIds: [...new Set(blocking)] };

    const now = new Date();
    const notices: { userId: string; type: string; payload: Record<string, unknown> }[] = [];
    const title = (o: (typeof locked)[number]) => authorTitle(o.sourceText) ?? o.normalizedTitle ?? null;

    // 1. Свои открытые заказы → cancelled.
    for (const o of locked.filter((x) => x.authorId === userId && (DELETABLE_ORDER_STATUSES as readonly string[]).includes(x.status))) {
      const active = await tx.update(schema.responses).set({ status: "not_selected", updatedAt: now })
        .where(and(eq(schema.responses.orderId, o.id), eq(schema.responses.status, "active"))).returning();
      const selected = await tx.update(schema.orderAssignments).set({ status: "cancelled" })
        .where(and(eq(schema.orderAssignments.orderId, o.id), eq(schema.orderAssignments.status, "selected"))).returning();
      await tx.update(schema.orders).set({ status: "cancelled" }).where(eq(schema.orders.id, o.id));
      const t = title(o);
      // Выбранный исполнитель (его отклик тоже active) получает одно уведомление — об отмене переговоров.
      const negotiating = new Set(selected.map((a) => a.executorId));
      for (const r of active.filter((x) => !negotiating.has(x.executorId))) notices.push({ userId: r.executorId, type: "order_cancelled_response",
        payload: { orderId: o.id, responseId: r.id, title: "Заказ отменён", body: t ? `Автор удалил аккаунт, заказ «${t}» отменён` : "Автор удалил аккаунт, заказ отменён" } });
      for (const a of selected) notices.push({ userId: a.executorId, type: "selection_cancelled",
        payload: { orderId: o.id, title: "Заказ отменён", body: t ? `Автор удалил аккаунт, переговоры по «${t}» отменены` : "Автор удалил аккаунт, переговоры отменены" } });
    }

    // 2. Мои переговоры как исполнителя на чужих заказах → cancelled; заказ без живых назначений → published.
    for (const o of locked.filter((x) => x.authorId !== userId)) {
      const cancelled = await tx.update(schema.orderAssignments).set({ status: "cancelled" })
        .where(and(eq(schema.orderAssignments.orderId, o.id), eq(schema.orderAssignments.executorId, userId), eq(schema.orderAssignments.status, "selected")))
        .returning();
      await tx.update(schema.responses).set({ status: "withdrawn", updatedAt: now })
        .where(and(eq(schema.responses.orderId, o.id), eq(schema.responses.executorId, userId), eq(schema.responses.status, "active")));
      if (!cancelled.length) continue;
      const [live] = await tx.select({ id: schema.orderAssignments.id }).from(schema.orderAssignments)
        .where(and(eq(schema.orderAssignments.orderId, o.id), inArray(schema.orderAssignments.status, ["selected", "in_progress"])));
      if (!live && o.status === "negotiating")
        await tx.update(schema.orders).set({ status: "published" }).where(and(eq(schema.orders.id, o.id), eq(schema.orders.status, "negotiating")));
      const t = title(o);
      notices.push({ userId: o.authorId, type: "executor_account_deleted",
        payload: { orderId: o.id, title: "Исполнитель удалил аккаунт", body: t ? `Переговоры по «${t}» отменены` : "Переговоры по заказу отменены" } });
    }

    // 3. Личные данные — физически. Порядок учитывает FK без каскада (capability_profiles → profile_source_inputs,
    //    push_deliveries → device_installations).
    const mediaRows = await tx.select().from(schema.media).where(eq(schema.media.ownerId, userId));
    // Persist the exact provider/key BEFORE erasing media rows, in this same transaction.
    const cleanup = mediaRows.length ? await tx.insert(schema.mediaCleanupRequests).values(mediaRows.map((m) => ({
      storageProvider: storage?.name === m.storageProvider ? storage.cleanupIdentity : `unbound:${m.storageProvider}`, storageKey: m.storageKey,
    }))).onConflictDoNothing().returning({ id: schema.mediaCleanupRequests.id }) : [];
    // Ожидающие задачи профиля этого пользователя снимаются в той же транзакции: ни AI, ни STT, ни пересборки
    // для удалённого аккаунта (у расшифровки в данных только sourceInputId). Уже идущая задача увидит, что
    // сообщения нет, и завершится без вызова AI.
    const [queue] = (await tx.execute(sql`select to_regclass('pgboss.job') is not null as present`)) as unknown as Array<{ present: boolean }>;
    if (queue?.present)
      await tx.execute(sql`update pgboss.job set state = 'cancelled'
        where state in ('created', 'retry')
          and name in ('profile_transcribe', 'profile_extraction', 'profile_facts_extraction', 'profile_rebuild', 'profile_embedding_refresh')
          and (data->>'userId' = ${userId}
            or data->>'sourceInputId' in (select id::text from profile_source_inputs where user_id = ${userId}))`);
    await tx.delete(schema.capabilityProfiles).where(eq(schema.capabilityProfiles.userId, userId));
    await tx.delete(schema.profileFacts).where(eq(schema.profileFacts.userId, userId));
    await tx.delete(schema.profileFactExtractions).where(eq(schema.profileFactExtractions.userId, userId));
    await tx.delete(schema.profileInputRecovery).where(eq(schema.profileInputRecovery.userId, userId));
    await tx.delete(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.userId, userId));
    await tx.delete(schema.profileItemDecisions).where(eq(schema.profileItemDecisions.userId, userId));
    await tx.delete(schema.profileEmbeddingRefreshRequests).where(eq(schema.profileEmbeddingRefreshRequests.userId, userId));
    await tx.delete(schema.learnedPreferences).where(eq(schema.learnedPreferences.userId, userId));
    await tx.delete(schema.rematchRequests).where(eq(schema.rematchRequests.userId, userId));
    // Производные результаты подбора с текстом/выводами из профиля. История заказа для других людей не страдает:
    // на эти строки ничто не ссылается, у каждого получателя — свои строки.
    await tx.delete(schema.matchingTraces).where(eq(schema.matchingTraces.userId, userId));
    await tx.delete(schema.matchingCandidates).where(eq(schema.matchingCandidates.userId, userId));
    await tx.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
    await tx.delete(schema.deviceInstallations).where(eq(schema.deviceInstallations.userId, userId));
    await tx.delete(schema.userSessions).where(eq(schema.userSessions.userId, userId));
    await tx.delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.userId, userId));
    await tx.delete(schema.media).where(eq(schema.media.ownerId, userId));

    await tx.update(schema.userProfiles)
      .set({ name: "Удалённый пользователь", whatsappPhone: null, avatarMediaId: null, about: null, updatedAt: now })
      .where(eq(schema.userProfiles.userId, userId));
    // varchar(20): "del_" + 16 символов id; номер освобождается (уникальность телефона — только среди active).
    await tx.update(schema.users)
      .set({ status: "deleted", phone: `del_${userId.replace(/-/g, "").slice(0, 16)}`, passwordHash: await hashPassword(randomUUID()), phoneVerifiedAt: null })
      .where(eq(schema.users.id, userId));
    await tx.insert(schema.auditLogs).values({ actorType: "user", actorId: userId, action: "account_deleted", targetType: "user", targetId: userId,
      metadata: { notices: notices.length, mediaFiles: mediaRows.length } });
    return { status: "deleted" as const, mediaKeys: mediaRows.map((m) => ({ provider: m.storageProvider, key: m.storageKey })), cleanupIds: cleanup.map((r) => r.id), notices };
  });
}
