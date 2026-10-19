import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, drainMediaCleanup, getDb, getSql, schema } from "@ustal/database";

assertLocalTestDatabase();
const db = getDb(), ids: string[] = [];
const now = new Date();
async function request(provider = "s3") {
  const [r] = await db.insert(schema.mediaCleanupRequests).values({ storageProvider: provider,
    storageKey: `photo/audit/${randomUUID()}.jpg`, nextAttemptAt: now }).returning();
  ids.push(r!.id); return r!;
}
const load = (id: string) => db.query.mediaCleanupRequests.findFirst({ where: eq(schema.mediaCleanupRequests.id, id) });
afterAll(async () => {
  if (ids.length) await db.delete(schema.mediaCleanupRequests).where(inArray(schema.mediaCleanupRequests.id, ids));
  await getSql().end();
});

describe("durable physical media cleanup", () => {
  it("the same provider name with a different bucket/directory identity must not acknowledge old objects", async () => {
    const r = await request("s3"); let calls = 0;
    const storage = { name: "s3", cleanupIdentity: "s3:another-bucket", remove: async () => { calls++; } };
    expect(await drainMediaCleanup(db, storage, { ids: [r.id], now })).toEqual({ removed: 0, failed: 0 });
    expect(calls).toBe(0); expect(await load(r.id)).toMatchObject({ attempts: 0 });
  });

  it("failure retains a sanitized retry; backoff prevents hot loops; a later worker removes it", async () => {
    const r = await request(); let calls = 0;
    const failing = { name: "s3", cleanupIdentity: "s3", remove: async () => { calls++; throw new Error("secret signed URL / private object key"); } };
    expect(await drainMediaCleanup(db, failing, { ids: [r.id], now })).toEqual({ removed: 0, failed: 1 });
    const pending = await load(r.id);
    expect(pending).toMatchObject({ attempts: 1, lastErrorCode: "delete_failed", leaseToken: null });
    expect(JSON.stringify(pending)).not.toContain("secret signed URL");
    expect(await drainMediaCleanup(db, failing, { ids: [r.id], now })).toEqual({ removed: 0, failed: 0 });
    expect(calls).toBe(1);
    const success = { name: "s3", cleanupIdentity: "s3", remove: async (key: string) => { expect(key).toBe(r.storageKey); } };
    expect(await drainMediaCleanup(db, success, { ids: [r.id], now: pending!.nextAttemptAt })).toEqual({ removed: 1, failed: 0 });
    expect(await load(r.id)).toBeUndefined();
  });

  it("storage I/O holds no outbox row lock and simultaneous drainers do not duplicate a live claim", async () => {
    const r = await request(); let entered!: () => void, release!: () => void, calls = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const storage = { name: "s3", cleanupIdentity: "s3", remove: async () => {
      calls++;
      await db.transaction(async (tx) => {
        await tx.execute((await import("drizzle-orm")).sql`select id from media_cleanup_requests where id=${r.id}::uuid for update nowait`);
      });
      entered(); await gate;
    } };
    const first = drainMediaCleanup(db, storage, { ids: [r.id], now });
    await started;
    try { expect(await drainMediaCleanup(db, storage, { ids: [r.id], now })).toEqual({ removed: 0, failed: 0 }); }
    finally { release(); }
    expect(await first).toEqual({ removed: 1, failed: 0 }); expect(calls).toBe(1);
  });

  it("expired crash lease is recoverable; an old acknowledgement cannot erase a newer failed claim", async () => {
    const r = await request(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = drainMediaCleanup(db, { name: "s3", cleanupIdentity: "s3", remove: async () => { entered(); await gate; } }, { ids: [r.id], now });
    await started;
    try {
      expect(await drainMediaCleanup(db, { name: "s3", cleanupIdentity: "s3", remove: async () => { throw Error("failed"); } },
        { ids: [r.id], now: new Date(now.getTime() + 121_000) })).toEqual({ removed: 0, failed: 1 });
    } finally { release(); }
    expect(await first).toEqual({ removed: 0, failed: 0 });
    const pending = await load(r.id);
    expect(pending).toMatchObject({ attempts: 2, lastErrorCode: "delete_failed" });
    await drainMediaCleanup(db, { name: "s3", cleanupIdentity: "s3", remove: async () => undefined }, { ids: [r.id], now: pending!.nextAttemptAt });
    expect(await load(r.id)).toBeUndefined();
  });

  it("provider mismatch and explicit empty ids never delete another provider's object or another request", async () => {
    const r = await request("local"); let calls = 0;
    const storage = { name: "s3", cleanupIdentity: "s3", remove: async () => { calls++; } };
    expect(await drainMediaCleanup(db, storage, { ids: [r.id], now })).toEqual({ removed: 0, failed: 0 });
    expect(await drainMediaCleanup(db, { ...storage, name: "local" }, { ids: [], now })).toEqual({ removed: 0, failed: 0 });
    expect(calls).toBe(0); expect(await load(r.id)).toMatchObject({ attempts: 0 });
  });
});
