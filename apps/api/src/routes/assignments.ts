import { authorTitle } from "../lib/order-text.js";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { assertOrderTransition } from "@ustal/domain";
import { createAssignmentSchema, notCompletedSchema } from "@ustal/validation";
import { notifyUser } from "../lib/notify.js";
import { areBlocked } from "../lib/blocks.js";

/**
 * «Договорились» и закрытие заказа (docs/api.md, docs/data-model.md
 * `order_assignments`, plan.md Фаза 6). Намеренно НЕТ
 * required_executors_count/confirmed_executors_count (docs/data-model.md —
 * заказ может иметь сколько угодно `order_assignments`, без счётчика в UI):
 * автор выбирает столько исполнителей, сколько нужно, по одному вызову
 * `POST /orders/{id}/assignments` на каждого — множественные назначения на
 * один заказ такая же нормальная ситуация, как и единственное.
 *
 * Первое назначение переводит заказ `published` → `negotiating` (не
 * блокирует новые отклики само по себе — их по-прежнему можно оставлять,
 * пока заказ не закрыт явно, см. `responses.ts`); `POST /orders/{id}/close`
 * — единственное действие, которое блокирует дальнейшие отклики
 * (`orders.status = 'closed'` не входит в допустимые статусы для создания
 * отклика) и транзакционно переводит все ещё активные, но не выбранные
 * отклики в `not_selected` с уведомлением каждому.
 */
export default async function assignmentsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/orders/:id/assignments", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: orderId } = request.params as { id: string };
    const body = createAssignmentSchema.parse(request.body);

    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
    if (!order || order.authorId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    if (!["published", "negotiating"].includes(order.status)) {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Нельзя выбрать исполнителя для заказа в статусе "${order.status}"` },
      });
    }

    const response = await db.query.responses.findFirst({ where: eq(schema.responses.id, body.responseId) });
    if (!response || response.orderId !== orderId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Отклик не найден" } });
    }
    if (await areBlocked(db, request.userId, response.executorId)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Отклик не найден" } });
    }

    if (response.status !== "active") {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Отклик в статусе "${response.status}" нельзя выбрать` },
      });
    }

    const executor = await db.query.users.findFirst({ where: eq(schema.users.id, response.executorId), columns: { status: true } });
    if (executor?.status !== "active") {
      return reply.code(409).send({ error: { code: "invalid_status", message: "Исполнитель недоступен — выбрать его нельзя" } });
    }

    const unlock = await db.query.contactUnlocks.findFirst({
      where: and(eq(schema.contactUnlocks.orderId, orderId), eq(schema.contactUnlocks.executorId, response.executorId)),
    });
    if (!unlock) {
      return reply.code(409).send({
        error: {
          code: "contact_not_unlocked",
          message: "Сначала нужно раскрыть контакт исполнителя (POST /orders/{id}/contact-unlocks)",
        },
      });
    }

    let created: typeof schema.orderAssignments.$inferSelect | undefined;
    let orderNoLongerOpen = false;
    try {
      created = await db.transaction(async (tx) => {
        // Тот же замок, что и при отзыве отклика: либо отзыв успел раньше и
        // выбрать уже нельзя, либо выбор успел раньше и отозвать нельзя.
        await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`);
        await tx.execute(sql`SELECT 1 FROM responses WHERE id = ${response.id} FOR UPDATE`);
        // Race-фикс (2026-09-22, второй security-проход): статус заказа
        // читаем СВЕЖИМ, под тем же замком orders FOR UPDATE выше — раньше
        // переход published->negotiating делался ПОСЛЕ коммита транзакции по
        // старому (до-локового) снимку `order`, безусловным UPDATE. Под
        // гонкой (например, параллельная отмена выбора другого исполнителя)
        // это могло либо перезаписать более новый статус заказа, либо не
        // выставить negotiating вовсе, хотя назначение уже создано —
        // см. claude/... security-audit (второй проход).
        const [freshOrder] = await tx.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, orderId));
        const [fresh] = await tx.select().from(schema.responses).where(eq(schema.responses.id, response.id));
        if (!fresh || fresh.status !== "active") return undefined;
        // ЭТАП 2 переговоров (2026-09-22, negotiation-architecture-audit):
        // MVP под одного исполнителя снят — несколько кандидатов теперь могут
        // быть `selected` одновременно (см. также /start ниже, где ровно один
        // из них становится `in_progress`). Раньше здесь была проверка
        // "уже есть другой selected/in_progress" (alreadyHasExecutor), которая
        // ограничивала заказ одним кандидатом; вместо неё — свежая (под тем же
        // замком orders FOR UPDATE) проверка, что заказ вообще ещё открыт для
        // переговоров: он мог успеть закрыться (/close) или уйти в работу по
        // другому кандидату (/start) между внешней проверкой выше и получением
        // блокировки здесь.
        if (!freshOrder || !["published", "negotiating"].includes(freshOrder.status)) {
          orderNoLongerOpen = true;
          return undefined;
        }
        const [row] = await tx
          .insert(schema.orderAssignments)
          .values({ orderId, executorId: response.executorId, responseId: response.id })
          .returning();
        if (freshOrder.status === "published") {
          assertOrderTransition("published", "negotiating");
          await tx
            .update(schema.orders)
            .set({ status: "negotiating" })
            .where(and(eq(schema.orders.id, orderId), eq(schema.orders.status, "published")));
        }
        return row;
      });
      if (!created) {
        if (orderNoLongerOpen) {
          return reply.code(409).send({
            error: { code: "invalid_status", message: "Заказ уже не принимает новых кандидатов для переговоров" },
          });
        }
        return reply.code(409).send({
          error: { code: "invalid_status", message: "Исполнитель отозвал отклик — выбрать его нельзя" },
        });
      }
    } catch (err) {
      // См. docs/architecture.md §5 п.15: код ошибки Postgres у drizzle-orm
      // postgres-js лежит на err.cause.code, а не на err.code напрямую.
      const pgCode = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
      if (pgCode === "23505") {
        return reply.code(409).send({ error: { code: "already_selected", message: "Этот исполнитель уже выбран по заказу" } });
      }
      throw err;
    }
    if (!created) throw new Error("Failed to create order_assignment");

    await notifyUser(response.executorId, "selected", {
      orderId,
      assignmentId: created.id,
      title: "Заказчик открыл с вами переговоры",
      body: (authorTitle(order.sourceText) ?? order.normalizedTitle) ? `Обсудите детали по «${(authorTitle(order.sourceText) ?? order.normalizedTitle)}»` : "Обсудите детали заказа",
    });

    return reply.code(201).send({
      id: created.id,
      orderId: created.orderId,
      executorId: created.executorId,
      status: created.status,
      selectedAt: created.selectedAt,
    });
  });

  app.post("/orders/:id/close", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: orderId } = request.params as { id: string };
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
    if (!order || order.authorId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    if (!["published", "negotiating"].includes(order.status)) {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Нельзя закрыть заказ в статусе "${order.status}"` },
      });
    }

    assertOrderTransition(order.status as "published" | "negotiating", "closed");

    const notSelected = await db.transaction(async (tx) => {
      // «Идут переговоры» с выбранным, но не начавшим работу исполнителем: закрытие заказа снимает и выбор,
      // иначе назначение selected остаётся висеть на закрытом заказе.
      await tx
        .delete(schema.orderAssignments)
        .where(and(eq(schema.orderAssignments.orderId, orderId), eq(schema.orderAssignments.status, "selected")));
      const assignments = await tx.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.orderId, orderId) });
      const selectedExecutorIds = assignments.map((a) => a.executorId);

      const activeResponses = await tx.query.responses.findMany({
        where: and(eq(schema.responses.orderId, orderId), eq(schema.responses.status, "active")),
      });
      const toMarkNotSelected = activeResponses.filter((r) => !selectedExecutorIds.includes(r.executorId));

      if (toMarkNotSelected.length > 0) {
        await tx
          .update(schema.responses)
          .set({ status: "not_selected", updatedAt: new Date() })
          .where(
            and(
              eq(schema.responses.orderId, orderId),
              eq(schema.responses.status, "active"),
              inArray(
                schema.responses.id,
                toMarkNotSelected.map((r) => r.id),
              ),
            ),
          );
      }

      await tx.update(schema.orders).set({ status: "closed", closedAt: new Date() }).where(eq(schema.orders.id, orderId));

      return toMarkNotSelected;
    });

    // Уведомления — вне транзакции (создают свои строки + ставят задачи в
    // pg-boss; не должны откатывать уже зафиксированное закрытие заказа при
    // сбое доставки одного уведомления).
    for (const r of notSelected) {
      await notifyUser(r.executorId, "not_selected", {
        orderId,
        responseId: r.id,
        title: "Заказ закрыт",
        body: (authorTitle(order.sourceText) ?? order.normalizedTitle)
          ? `На этот раз не сложилось: «${(authorTitle(order.sourceText) ?? order.normalizedTitle)}»`
          : "На этот раз выбрали другого исполнителя",
      });
    }

    return reply.send({ id: orderId, status: "closed", notSelectedCount: notSelected.length });
  });

  // «Договорились» / «Начать выполнение»: selected (идут переговоры) → in_progress («В работе»).
  // Это единственный переход, который закрывает заказ для остальных: новые отклики больше
  // не принимаются, ещё активные отклики других исполнителей → not_selected.
  app.post(
    "/orders/:id/assignments/:assignmentId/start",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const guard = await loadOwnedAssignment(db, request.params as { id: string; assignmentId: string }, request.userId, "selected");
      if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });

      // Race-фикс (2026-09-22, второй security-проход): UPDATE назначения
      // был безусловным (без проверки текущего статуса) — два параллельных
      // /start на одно и то же назначение оба отвечали 200. Переход статуса
      // заказа тоже читал СТАРЫЙ (до-локовый) guard.order.status — под
      // гонкой с параллельной отменой выбора (/cancel) заказ мог остаться
      // "in_progress", хотя назначение уже удалено. Теперь: условный UPDATE
      // (WHERE status='selected', с .returning()) — если 0 строк, назначение
      // уже не "selected" (гонка проиграна) — 409; статус заказа переводим
      // по свежему чтению под тем же замком orders FOR UPDATE.
      const txResult = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${guard.order.id} FOR UPDATE`);
        const [updatedAssignment] = await tx
          .update(schema.orderAssignments)
          .set({ status: "in_progress" })
          .where(and(eq(schema.orderAssignments.id, guard.assignment.id), eq(schema.orderAssignments.status, "selected")))
          .returning({ id: schema.orderAssignments.id });
        if (!updatedAssignment) return { conflict: true as const, rest: [] as (typeof schema.responses.$inferSelect)[] };

        // ЭТАП 2 переговоров (2026-09-22, negotiation-architecture-audit):
        // несколько кандидатов могут быть `selected` одновременно — «Договорились»
        // с одним из них обязано оставить максимум один `in_progress` на заказ.
        // Переводим ВСЕ ОСТАЛЬНЫЕ `selected` назначения этого заказа в `cancelled`
        // (статус уже объявлен в AssignmentStatus, но раньше нигде не проставлялся —
        // семантически подходит: mobile уже показывает для него «Отменено»
        // (ASSIGNMENT_LABELS), feed.integration.test.ts уже трактует его как
        // «не активно», а isContactAccessOpen/LIVE_ASSIGNMENT_STATUSES уже закрывает
        // по нему доступ к контактам без каких-либо дополнительных изменений — новая
        // миграция не нужна). Это же гарантирует «не более одного in_progress»:
        // замок orders FOR UPDATE выше сериализует все параллельные /start по этому
        // заказу, поэтому конкурирующий /start другого кандидата либо уже проиграл
        // условный UPDATE выше (его назначение ещё "selected", но лок он получит
        // только после нас и наш UPDATE ниже успеет перевести его в "cancelled" —
        // тогда его собственный условный UPDATE найдёт 0 строк и вернёт 409), либо
        // выполнился раньше нас (тогда наш собственный updatedAssignment выше уже
        // не нашёл бы строку в статусе "selected" и мы сами получили бы 409).
        await tx
          .update(schema.orderAssignments)
          .set({ status: "cancelled" })
          .where(and(eq(schema.orderAssignments.orderId, guard.order.id), eq(schema.orderAssignments.status, "selected")));

        const [freshOrder] = await tx.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, guard.order.id));
        if (freshOrder?.status === "negotiating") {
          assertOrderTransition("negotiating", "in_progress");
          await tx
            .update(schema.orders)
            .set({ status: "in_progress" })
            .where(and(eq(schema.orders.id, guard.order.id), eq(schema.orders.status, "negotiating")));
        }
        const active = await tx.query.responses.findMany({
          where: and(eq(schema.responses.orderId, guard.order.id), eq(schema.responses.status, "active")),
        });
        const rest = active.filter((r) => r.executorId !== guard.assignment.executorId);
        if (rest.length > 0) {
          await tx
            .update(schema.responses)
            .set({ status: "not_selected", updatedAt: new Date() })
            .where(inArray(schema.responses.id, rest.map((r) => r.id)));
        }
        return { conflict: false as const, rest };
      });
      if (txResult.conflict) {
        return reply.code(409).send({
          error: { code: "invalid_status", message: "Назначение уже не в статусе «выбран» — начать выполнение нельзя" },
        });
      }
      const others = txResult.rest;

      const title = authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle;
      await notifyUser(guard.assignment.executorId, "assignment_started", {
        orderId: guard.order.id,
        assignmentId: guard.assignment.id,
        title: "Вас выбрали исполнителем",
        body: title ? `Договорились по «${title}» — заказ в работе` : "Договорились — заказ в работе",
      });
      for (const r of others) {
        await notifyUser(r.executorId, "not_selected", {
          orderId: guard.order.id,
          responseId: r.id,
          title: "Заказ в работе",
          body: title ? `По «${title}» выбран другой исполнитель` : "По заказу выбран другой исполнитель",
        });
      }

      return reply.send({ id: guard.assignment.id, status: "in_progress" });
    },
  );

  // Отмена выбора: пока договорённости нет (selected), заказчик может передумать и выбрать другого.
  // Контакт снова закрывается, заказ возвращается в «Опубликован».
  app.post(
    "/orders/:id/assignments/:assignmentId/cancel",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const guard = await loadOwnedAssignment(db, request.params as { id: string; assignmentId: string }, request.userId, "selected");
      if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });

      // Race-фикс (2026-09-22, второй security-проход): та же пара проблем,
      // что и в /start — безусловный DELETE назначения и переход статуса
      // заказа по СТАРОМУ guard.order.status. Под гонкой с параллельным
      // /start проигравший /cancel мог удалить уже in_progress назначение и
      // безусловно откатить заказ в "published", затерев более новый статус.
      const cancelResult = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${guard.order.id} FOR UPDATE`);
        const [deleted] = await tx
          .delete(schema.orderAssignments)
          .where(and(eq(schema.orderAssignments.id, guard.assignment.id), eq(schema.orderAssignments.status, "selected")))
          .returning({ id: schema.orderAssignments.id });
        if (!deleted) return { conflict: true as const };
        await tx
          .delete(schema.contactUnlocks)
          .where(and(eq(schema.contactUnlocks.orderId, guard.order.id), eq(schema.contactUnlocks.executorId, guard.assignment.executorId)));
        // ЭТАП 2 переговоров (2026-09-22): несколько кандидатов могут быть
        // `selected` одновременно — откат заказа "negotiating" -> "published"
        // корректен, только если отменённый кандидат был ПОСЛЕДНИМ оставшимся
        // (иначе переговоры с другими кандидатами всё ещё идут). Проверяем под
        // тем же замком orders FOR UPDATE, что и остальные операции здесь.
        const [remaining] = await tx
          .select({ id: schema.orderAssignments.id })
          .from(schema.orderAssignments)
          .where(and(eq(schema.orderAssignments.orderId, guard.order.id), inArray(schema.orderAssignments.status, ["selected", "in_progress"])));
        const [freshOrder] = await tx.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, guard.order.id));
        if (!remaining && freshOrder?.status === "negotiating") {
          assertOrderTransition("negotiating", "published");
          await tx
            .update(schema.orders)
            .set({ status: "published" })
            .where(and(eq(schema.orders.id, guard.order.id), eq(schema.orders.status, "negotiating")));
        }
        return { conflict: false as const };
      });
      if (cancelResult.conflict) {
        return reply.code(409).send({
          error: { code: "invalid_status", message: "Назначение уже не в статусе «выбран» — отменить выбор нельзя" },
        });
      }

      const title = authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle;
      await notifyUser(guard.assignment.executorId, "selection_cancelled", {
        orderId: guard.order.id,
        title: "Выбор отменён",
        body: title ? `Заказчик отменил выбор по «${title}»` : "Заказчик отменил выбор по заказу",
      });

      return reply.send({ id: guard.assignment.id, status: "cancelled" });
    },
  );

  app.post(
    "/orders/:id/assignments/:assignmentId/complete",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const guard = await loadOwnedAssignment(db, request.params as { id: string; assignmentId: string }, request.userId, "in_progress");
      if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });

      // Race-фикс (2026-09-22, второй security-проход): раньше orders не
      // блокировался вообще, а UPDATE назначения был безусловным — два
      // параллельных complete (или complete+not-completed) оба отвечали 200.
      // Теперь: замок orders FOR UPDATE + условный UPDATE (WHERE
      // status='in_progress', .returning()) — проигравший получает 409,
      // finishOrder читает свежий статус заказа под тем же замком.
      const completeOutcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${guard.order.id} FOR UPDATE`);
        const [updated] = await tx
          .update(schema.orderAssignments)
          .set({ status: "completed", completedAt: new Date() })
          .where(and(eq(schema.orderAssignments.id, guard.assignment.id), eq(schema.orderAssignments.status, "in_progress")))
          .returning({ id: schema.orderAssignments.id });
        if (!updated) return "conflict" as const;
        await finishOrder(tx, guard.order.id, "completed");
        return "ok" as const;
      });
      if (completeOutcome === "conflict") {
        return reply.code(409).send({
          error: { code: "invalid_status", message: "Назначение уже не «в работе» — завершить нельзя" },
        });
      }

      // "Открывает форму оценки на клиенте" (docs/api.md) — сам отзыв
      // создаётся отдельным вызовом POST /reviews (Фаза 7, routes/reviews.ts),
      // который проверяет именно наличие completed order_assignment между
      // парой. Сигнал similarCompletedWork (evaluateSemantic, +5) пока
      // зарезервирован и НЕ подключён: matching-run.ts не читает
      // order_assignments. Подключение меняет ранжирование и требует
      // перепрогона holdout.
      await notifyUser(guard.assignment.executorId, "assignment_completed", {
        orderId: guard.order.id,
        assignmentId: guard.assignment.id,
        title: "Заказ отмечен как выполненный",
        body: (authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle)
          ? `«${(authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle)}» отмечен как выполненный — оцените друг друга`
          : "Заказ отмечен как выполненный — оцените друг друга",
      });

      return reply.send({ id: guard.assignment.id, status: "completed" });
    },
  );

  app.post(
    "/orders/:id/assignments/:assignmentId/not-completed",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = notCompletedSchema.parse(request.body);
      const guard = await loadOwnedAssignment(db, request.params as { id: string; assignmentId: string }, request.userId, "in_progress");
      if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });

      // Race-фикс (2026-09-22, второй security-проход): см. /complete выше —
      // тот же класс бага, тот же фикс (замок orders + условный UPDATE).
      const notCompletedOutcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${guard.order.id} FOR UPDATE`);
        const [updated] = await tx
          .update(schema.orderAssignments)
          .set({ status: "not_completed", notCompletedReason: body.reason ?? null })
          .where(and(eq(schema.orderAssignments.id, guard.assignment.id), eq(schema.orderAssignments.status, "in_progress")))
          .returning({ id: schema.orderAssignments.id });
        if (!updated) return "conflict" as const;
        await finishOrder(tx, guard.order.id, "not_completed");
        return "ok" as const;
      });
      if (notCompletedOutcome === "conflict") {
        return reply.code(409).send({
          error: { code: "invalid_status", message: "Назначение уже не «в работе» — отметить как невыполненный нельзя" },
        });
      }

      // Намеренно НЕ completedAt — семантически это поле «когда выполнено»,
      // а не «когда закрыт статус». matching не получает позитивный сигнал
      // (docs/api.md): worker считает только status = 'completed', эта ветка
      // никогда им не станет.
      await notifyUser(guard.assignment.executorId, "assignment_not_completed", {
        orderId: guard.order.id,
        assignmentId: guard.assignment.id,
        title: "Заказ отмечен как невыполненный",
        body: (authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle)
          ? `«${(authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle)}» отмечен как невыполненный`
          : "Заказ отмечен как невыполненный",
      });

      return reply.send({ id: guard.assignment.id, status: "not_completed" });
    },
  );

  // Security-этап «исполнитель не должен зависать в работе» (2026-09-22,
  // см. claude/ux-journey-audit-2026-09-22.md, MVP blocker #1): у
  // исполнителя раньше не было ни одной кнопки в статусе in_progress — если
  // заказчик забывал/не мог нажать «Выполнено»/«Не выполнено», заказ и
  // назначение зависали навсегда без какого-либо выхода. Эти два эндпоинта
  // дают исполнителю сигнал заказчику ("работа выполнена" / "не получилось
  // выполнить") — но НЕ финализируют заказ сами: единственный, кто реально
  // переводит in_progress → completed/not_completed, — заказчик (см. выше),
  // ровно как попросили. executor_report — только пуш-уведомление +
  // отметка, которую видит заказчик рядом с кнопками «Выполнено»/«Не
  // выполнено» (routes/responses.ts, GET /orders/{id}/responses).
  app.post(
    "/orders/:id/assignments/:assignmentId/executor-report-completed",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const guard = await loadOwnExecutorAssignment(db, request.params as { id: string; assignmentId: string }, request.userId);
      if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });

      const [updated] = await db
        .update(schema.orderAssignments)
        .set({ executorReport: "completed", executorReportAt: new Date() })
        .where(eq(schema.orderAssignments.id, guard.assignment.id))
        .returning();

      await notifyUser(guard.order.authorId, "executor_reported_completed", {
        orderId: guard.order.id,
        assignmentId: guard.assignment.id,
        title: "Исполнитель отметил работу выполненной",
        body: (authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle)
          ? `«${(authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle)}»: исполнитель сообщил, что работа выполнена — подтвердите результат`
          : "Исполнитель сообщил, что работа выполнена — подтвердите результат",
      });

      return reply.send({
        id: updated!.id,
        executorReport: updated!.executorReport,
        executorReportAt: updated!.executorReportAt,
      });
    },
  );

  app.post(
    "/orders/:id/assignments/:assignmentId/executor-report-issue",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const guard = await loadOwnExecutorAssignment(db, request.params as { id: string; assignmentId: string }, request.userId);
      if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });

      const [updated] = await db
        .update(schema.orderAssignments)
        .set({ executorReport: "issue", executorReportAt: new Date() })
        .where(eq(schema.orderAssignments.id, guard.assignment.id))
        .returning();

      await notifyUser(guard.order.authorId, "executor_reported_issue", {
        orderId: guard.order.id,
        assignmentId: guard.assignment.id,
        title: "Исполнитель сообщил о проблеме",
        body: (authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle)
          ? `«${(authorTitle(guard.order.sourceText) ?? guard.order.normalizedTitle)}»: исполнитель сообщил, что не может выполнить заказ — примите решение`
          : "Исполнитель сообщил, что не может выполнить заказ — примите решение",
      });

      return reply.send({
        id: updated!.id,
        executorReport: updated!.executorReport,
        executorReportAt: updated!.executorReportAt,
      });
    },
  );
}

/**
 * Общая проверка для start/complete/not-completed: назначение существует,
 * принадлежит указанному заказу, заказ принадлежит вызывающему (автору), и
 * назначение в ожидаемом статусе: start — `selected`, complete/not-completed —
 * `in_progress` («Выполнено / Не выполнено» доступны только после «Договорились»).
 */
async function loadOwnedAssignment(
  db: ReturnType<typeof getDb>,
  params: { id: string; assignmentId: string },
  userId: string,
  requiredStatus: "selected" | "in_progress",
): Promise<
  | { assignment: typeof schema.orderAssignments.$inferSelect; order: typeof schema.orders.$inferSelect }
  | { status: number; error: { code: string; message: string } }
> {
  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, params.id) });
  if (!order || order.authorId !== userId) {
    return { status: 404, error: { code: "not_found", message: "Заказ не найден" } };
  }
  const assignment = await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.id, params.assignmentId) });
  if (!assignment || assignment.orderId !== order.id) {
    return { status: 404, error: { code: "not_found", message: "Назначение не найдено" } };
  }
  if (assignment.status !== requiredStatus) {
    return {
      status: 409,
      error: {
        code: "invalid_status",
        message:
          requiredStatus === "in_progress"
            ? `Назначение в статусе "${assignment.status}" — отметить результат можно только в статусе "in_progress" (после «Договорились»)`
            : `Назначение уже в статусе "${assignment.status}" — начать выполнение нельзя`,
      },
    };
  }
  return { assignment, order };
}

/**
 * Проверка для executor-report-*: назначение существует, принадлежит
 * указанному заказу и именно вызывающему исполнителю (не автору — в
 * отличие от loadOwnedAssignment выше), и ещё "в работе" (после того как
 * заказчик уже отметил результат, сигнал от исполнителя терять смысл —
 * назад в in_progress пути нет, см. ALLOWED_TRANSITIONS в @ustal/domain).
 */
async function loadOwnExecutorAssignment(
  db: ReturnType<typeof getDb>,
  params: { id: string; assignmentId: string },
  userId: string,
): Promise<
  | { assignment: typeof schema.orderAssignments.$inferSelect; order: typeof schema.orders.$inferSelect }
  | { status: number; error: { code: string; message: string } }
> {
  const assignment = await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.id, params.assignmentId) });
  if (!assignment || assignment.orderId !== params.id || assignment.executorId !== userId) {
    return { status: 404, error: { code: "not_found", message: "Назначение не найдено" } };
  }
  if (assignment.status !== "in_progress") {
    return {
      status: 409,
      error: { code: "invalid_status", message: `Отметить статус можно только пока заказ "в работе" (сейчас "${assignment.status}")` },
    };
  }
  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, assignment.orderId) });
  if (!order) {
    return { status: 404, error: { code: "not_found", message: "Заказ не найден" } };
  }
  return { assignment, order };
}

/**
 * Завершение заказа: in_progress → completed | not_completed. Заказы, у которых договорённость
 * уже стала in_progress до появления статуса заказа «В работе» (order.status всё ещё negotiating),
 * сначала переводятся в in_progress — так старые данные не ломаются.
 */
async function finishOrder(
  tx: Pick<ReturnType<typeof getDb>, "select" | "update">,
  orderId: string,
  to: "completed" | "not_completed",
): Promise<void> {
  // Свежее чтение ПОД ЗАМКОМ orders FOR UPDATE, который вызывающий код уже
  // держит внутри той же транзакции — раньше сюда передавался старый
  // (до-локовый) снимок order, из-за чего под гонкой (два параллельных
  // complete/not-completed) оба запроса писали в orders, основываясь на
  // одном и том же устаревшем статусе.
  const [fresh] = await tx.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, orderId));
  const currentStatus = fresh?.status ?? "in_progress";
  let from = currentStatus as "negotiating" | "in_progress";
  if (from === "negotiating") {
    assertOrderTransition("negotiating", "in_progress");
    from = "in_progress";
  }
  assertOrderTransition(from, to);
  await tx
    .update(schema.orders)
    .set({ status: to })
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.status, currentStatus)));
}
