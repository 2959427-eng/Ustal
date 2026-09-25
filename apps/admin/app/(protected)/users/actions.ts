"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@ustal/database";
import { requireAdminSession } from "../../../lib/session";

/**
 * Блокировка аккаунта — сразу разрывает возможность получать новые access
 * token'ы (см. фикс POST /auth/refresh, docs/architecture.md §5): уже
 * выданный access token недолго проживёт сам (ACCESS_TOKEN_TTL_MINUTES), а
 * следующий refresh получит 401 и отзовёт сессию.
 */
export async function setUserStatusAction(userId: string, status: "active" | "blocked") {
  requireAdminSession();
  const db = getDb();
  await db.update(schema.users).set({ status }).where(eq(schema.users.id, userId));
  if (status === "blocked") {
    // Разрываем уже выданные refresh-сессии; access-токен перестаёт работать сам (проверка status в API).
    await db
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.userSessions.userId, userId), isNull(schema.userSessions.revokedAt)));
  }
  revalidatePath("/users");
}
