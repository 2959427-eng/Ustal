import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";

const queue = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue("job") }));
vi.mock("@ustal/queue", () => ({ getBoss: async () => queue, JOB_TYPES: { NOTIFICATION_DISPATCH: "notification_dispatch" } }));
import { notifyUser } from "./notify.js";

assertLocalTestDatabase();
const db = getDb(), users: string[] = [];
afterAll(async () => {
  for (const id of users) await db.delete(schema.users).where(eq(schema.users.id, id));
  await getSql().end();
});

describe("late notification after account deletion", () => {
  it("does not recreate a notification or queue a push, and is a harmless no-op for the sender", async () => {
    const [u] = await db.insert(schema.users).values({ phone: `del_${randomUUID().replace(/-/g, "").slice(0, 16)}`, passwordHash: "unusable", status: "deleted" }).returning();
    users.push(u!.id);
    expect(await notifyUser(u!.id, "new_response", { body: "late payload" })).toBeNull();
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, u!.id))).toEqual([]);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("waits for an in-flight deletion fence and never inserts behind its commit", async () => {
    queue.send.mockClear();
    const [u] = await db.insert(schema.users).values({ phone: `+7${Math.floor(1e9 + Math.random() * 9e9)}`, passwordHash: "unused" }).returning();
    users.push(u!.id);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deleting = db.transaction(async (tx) => {
      await tx.execute(sql`select id from users where id=${u!.id}::uuid for update`);
      entered(); await gate;
      await tx.update(schema.users).set({ status: "deleted" }).where(eq(schema.users.id, u!.id));
    });
    await started;
    const notice = notifyUser(u!.id, "new_response", {});
    try {
      const deadline = Date.now() + 5000; let blocked = false;
      while (Date.now() < deadline) {
        const rows = await getSql()`select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike 'insert into "notifications"%'`;
        if (rows.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked, "notification must reach the held user fence").toBe(true);
    } finally { release(); }
    await deleting;
    expect(await notice).toBeNull();
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, u!.id))).toEqual([]);
    expect(queue.send).not.toHaveBeenCalled();
  });
});
