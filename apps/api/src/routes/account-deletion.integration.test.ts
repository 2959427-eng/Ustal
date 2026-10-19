import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";

/**
 * DELETE /me (2026-10-19): удаление аккаунта на настоящей PostgreSQL, настоящий authenticate/auth/contacts.
 * Строка users остаётся (status='deleted') ради чужой истории; личные данные удаляются; открытые договорённости
 * закрываются; работа в процессе блокирует удаление.
 */
const MEDIA_DIR = await mkdtemp(path.join(tmpdir(), "ustal-media-"));
process.env.MEDIA_STORAGE_PROVIDER = "local";
process.env.MEDIA_LOCAL_DIR = MEDIA_DIR;
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-0123456789";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-0123456789";
const notification = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../lib/notify.js", () => ({ notifyUser: notification.send }));
beforeEach(() => { notification.send.mockReset(); notification.send.mockResolvedValue("n"); });

const { default: authenticatePlugin } = await import("../plugins/authenticate.js");
const { default: authRoutes } = await import("./auth.js");
const { default: meRoutes } = await import("./me.js");
const { default: contactsRoutes } = await import("./contacts.js");
const { default: responsesRoutes } = await import("./responses.js");
const { default: profileRoutes } = await import("./profile.js");
const { deleteAccount } = await import("../lib/account-deletion.js");
const { hashPassword } = await import("../lib/password.js");
const { _clearLoginThrottleForTests } = await import("../lib/login-throttle.js");

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [], orderIds: string[] = [];
let cityId: string;
const PASSWORD = "Correct-horse-1";

async function newUser(name: string) {
  const phone = `+7${Math.floor(1e9 + Math.random() * 9e9)}`;
  const [u] = await db.insert(schema.users).values({ phone, passwordHash: await hashPassword(PASSWORD) }).returning();
  userIds.push(u!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, name, cityId, whatsappPhone: "+79990000000", about: "о себе",
    acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { phone, password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  const { accessToken, refreshToken } = login.json();
  return { id: u!.id, phone, accessToken: accessToken as string, refreshToken: refreshToken as string };
}
type U = Awaited<ReturnType<typeof newUser>>;
const auth = (u: U) => ({ authorization: `Bearer ${u.accessToken}` });
const del = (u: U, password = PASSWORD) => app.inject({ method: "DELETE", url: "/me", headers: auth(u), payload: { password } });
async function order(authorId: string, status: string) {
  const [o] = await db.insert(schema.orders).values({ authorId, cityId, sourceText: "TEST account deletion order", status }).returning();
  orderIds.push(o!.id);
  return o!.id;
}
const row = async <T>(q: Promise<T[]>) => (await q)[0];
const userRow = (id: string) => row(db.select().from(schema.users).where(eq(schema.users.id, id)));
const orderRow = (id: string) => row(db.select().from(schema.orders).where(eq(schema.orders.id, id)));

beforeAll(async () => {
  const { mapPgError } = await import("../lib/pg-errors.js");
  app.setErrorHandler((error, _req, reply) => {
    const mapped = mapPgError(error);
    if (mapped) return reply.code(mapped.status).send(mapped.body);
    if (error.name === "ZodError") return reply.code(400).send({ error: { code: "validation_error", message: error.message } });
    return reply.code(error.statusCode ?? 500).send({ error: { code: "internal_error", message: "x" } });
  });
  await app.register(authenticatePlugin);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(contactsRoutes);
  await app.register(responsesRoutes);
  await app.register(profileRoutes);
  await app.ready();
  const [c] = await db.insert(schema.cities).values({ name: `TEST deletion ${randomUUID()}`, regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cityId = c!.id;
});
afterAll(async () => {
  if (orderIds.length) await db.delete(schema.orderAssignments).where(inArray(schema.orderAssignments.orderId, orderIds));
  if (orderIds.length) await db.delete(schema.contactUnlocks).where(inArray(schema.contactUnlocks.orderId, orderIds));
  if (orderIds.length) await db.delete(schema.responses).where(inArray(schema.responses.orderId, orderIds));
  if (orderIds.length) await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
  await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.actorId, userIds));
  await db.delete(schema.blocks).where(inArray(schema.blocks.blockerId, userIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(eq(schema.cities.id, cityId));
  await app.close();
  await getSql().end();
});

describe("DELETE /me", () => {
  it("deletes only the caller: personal data gone, row kept anonymized, sessions/login/refresh dead; another user untouched", async () => {
    _clearLoginThrottleForTests();
    const a = await newUser("TEST A"), b = await newUser("TEST B");
    // personal data of A
    const key = `photo/${a.id}/${randomUUID()}.jpg`;
    await mkdir(path.join(MEDIA_DIR, path.dirname(key)), { recursive: true });
    await writeFile(path.join(MEDIA_DIR, key), "x");
    const [m] = await db.insert(schema.media).values({ ownerId: a.id, kind: "photo", storageProvider: "local", storageKey: key, mimeType: "image/jpeg" }).returning();
    await db.update(schema.userProfiles).set({ avatarMediaId: m!.id }).where(eq(schema.userProfiles.userId, a.id));
    const [inp] = await db.insert(schema.profileSourceInputs).values({ userId: a.id, inputType: "text", rawText: "Я сантехник, телефон …", status: "confirmed" }).returning();
    await db.insert(schema.capabilityProfiles).values({ userId: a.id, summary: "сантехник", profileVersion: 1, extractionVersion: "t", status: "applied", sourceInputId: inp!.id });
    await db.insert(schema.deviceInstallations).values({ userId: a.id, platform: "ios", expoPushToken: `ExponentPushToken[${randomUUID()}]` });
    await db.insert(schema.notifications).values({ userId: a.id, type: "new_response", payload: {} });
    const [queue] = (await db.execute(sql`select to_regclass('pgboss.job') is not null as present`)) as unknown as Array<{ present: boolean }>;
    if (queue?.present) await db.execute(sql`insert into pgboss.job (name, data) values ('profile_extraction', ${JSON.stringify({ userId: a.id, sourceInputId: inp!.id })}::jsonb), ('profile_transcribe', ${JSON.stringify({ sourceInputId: inp!.id })}::jsonb)`);

    expect((await del(a, "wrong")).statusCode).toBe(403);
    expect((await userRow(a.id))!.status).toBe("active"); // wrong password changes nothing
    const res = await del(a);
    expect(res.statusCode).toBe(204);

    const u = (await userRow(a.id))!;
    expect(u.status).toBe("deleted");
    expect(u.phone).not.toBe(a.phone);
    expect(u.phone.startsWith("del_")).toBe(true);
    const p = await row(db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, a.id)));
    expect(p).toMatchObject({ name: "Удалённый пользователь", whatsappPhone: null, avatarMediaId: null, about: null });
    for (const [t, col] of [[schema.profileSourceInputs, schema.profileSourceInputs.userId], [schema.capabilityProfiles, schema.capabilityProfiles.userId],
      [schema.userSessions, schema.userSessions.userId], [schema.deviceInstallations, schema.deviceInstallations.userId],
      [schema.notifications, schema.notifications.userId], [schema.media, schema.media.ownerId]] as const)
      expect((await db.select().from(t as never).where(eq(col as never, a.id))).length).toBe(0);
    await expect(access(path.join(MEDIA_DIR, key))).rejects.toThrow(); // file removed
    if (queue?.present) {
      const jobs = (await db.execute(sql`select state from pgboss.job where data->>'sourceInputId' = ${inp!.id}`)) as unknown as Array<{ state: string }>;
      expect(jobs.map((j) => j.state)).toEqual(["cancelled", "cancelled"]);
      await db.execute(sql`delete from pgboss.job where data->>'sourceInputId' = ${inp!.id}`);
    }
    expect((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.actorId, a.id), eq(schema.auditLogs.action, "account_deleted")))).length).toBe(1);

    // the old session is dead everywhere; repeating is safe (401, nothing else happens)
    expect((await del(a)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me", headers: auth(a) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { phone: a.phone, password: PASSWORD } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: a.refreshToken } })).statusCode).toBe(401);
    // the phone is free for a new active account (unique only among active)
    const [again] = await db.insert(schema.users).values({ phone: a.phone, passwordHash: "x" }).returning();
    userIds.push(again!.id);

    // B is untouched
    expect((await app.inject({ method: "GET", url: "/me", headers: auth(b) })).statusCode).toBe(200);
    expect((await userRow(b.id))!.status).toBe("active");
  });

  it("open deals are closed with notices: own orders cancelled, own negotiation as executor ends, history kept", async () => {
    _clearLoginThrottleForTests();
    const a = await newUser("TEST author+executor"), b = await newUser("TEST B"), c = await newUser("TEST C");
    // A as author
    const pub = await order(a.id, "published");
    const [rb] = await db.insert(schema.responses).values({ orderId: pub, executorId: b.id }).returning();
    const neg = await order(a.id, "negotiating");
    const [rc] = await db.insert(schema.responses).values({ orderId: neg, executorId: c.id }).returning();
    const [asc] = await db.insert(schema.orderAssignments).values({ orderId: neg, executorId: c.id, responseId: rc!.id }).returning();
    const done = await order(a.id, "completed");
    // A as executor on C's negotiating order (selected), and an active response on C's published order
    const cneg = await order(c.id, "negotiating");
    const [ra] = await db.insert(schema.responses).values({ orderId: cneg, executorId: a.id }).returning();
    const [asa] = await db.insert(schema.orderAssignments).values({ orderId: cneg, executorId: a.id, responseId: ra!.id }).returning();
    await db.insert(schema.contactUnlocks).values({ orderId: cneg, customerId: c.id, executorId: a.id, responseId: ra!.id });
    const cpub = await order(c.id, "published");
    const [ra2] = await db.insert(schema.responses).values({ orderId: cpub, executorId: a.id }).returning();

    expect((await del(a)).statusCode).toBe(204);

    expect((await orderRow(pub))!.status).toBe("cancelled");
    expect((await row(db.select().from(schema.responses).where(eq(schema.responses.id, rb!.id))))!.status).toBe("not_selected");
    expect((await orderRow(neg))!.status).toBe("cancelled");
    expect((await row(db.select().from(schema.orderAssignments).where(eq(schema.orderAssignments.id, asc!.id))))!.status).toBe("cancelled");
    expect((await orderRow(done))!.status).toBe("completed"); // history untouched
    expect((await row(db.select().from(schema.orderAssignments).where(eq(schema.orderAssignments.id, asa!.id))))!.status).toBe("cancelled");
    expect((await orderRow(cneg))!.status).toBe("published"); // no live negotiation left
    expect((await row(db.select().from(schema.responses).where(eq(schema.responses.id, ra2!.id))))!.status).toBe("withdrawn");
    const notices = notification.send.mock.calls.map(([u, t]) => `${u === b.id ? "B" : u === c.id ? "C" : "?"}:${t}`).sort();
    expect(notices).toEqual(["B:order_cancelled_response", "C:executor_account_deleted", "C:selection_cancelled"]);
    // contact of the deleted executor is no longer disclosed
    const contact = await app.inject({ method: "GET", url: `/orders/${cneg}/contacts/${a.id}`, headers: auth(c) });
    expect(contact.statusCode).toBeGreaterThanOrEqual(400);
    expect(contact.body).not.toContain("del_");
  });

  it("work in progress (either role) blocks deletion; nothing is changed", async () => {
    _clearLoginThrottleForTests();
    const a = await newUser("TEST busy"), b = await newUser("TEST B");
    const o = await order(b.id, "in_progress");
    const [r] = await db.insert(schema.responses).values({ orderId: o, executorId: a.id }).returning();
    await db.insert(schema.orderAssignments).values({ orderId: o, executorId: a.id, responseId: r!.id, status: "in_progress" });
    const res = await del(a);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("active_work");
    expect((await userRow(a.id))!.status).toBe("active");
    expect((await app.inject({ method: "GET", url: "/me", headers: auth(a) })).statusCode).toBe(200);
    const mine = await order(a.id, "in_progress");
    const [r2] = await db.insert(schema.responses).values({ orderId: mine, executorId: b.id }).returning();
    await db.update(schema.orderAssignments).set({ status: "completed" }).where(eq(schema.orderAssignments.orderId, o));
    await db.insert(schema.orderAssignments).values({ orderId: mine, executorId: b.id, responseId: r2!.id, status: "in_progress" });
    expect((await del(a)).statusCode).toBe(409); // as author
  });

  it("password attempts are throttled like login", async () => {
    _clearLoginThrottleForTests();
    const a = await newUser("TEST throttle");
    for (let i = 0; i < 10; i++) expect((await del(a, "nope")).statusCode).toBe(403);
    expect((await del(a)).statusCode).toBe(429); // even the right password waits
    expect((await userRow(a.id))!.status).toBe("active");
  });
});

// ---- Codex audit 2026-10-19: deleted-user writes must be impossible, whatever the interleaving ----
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isDeletedAccountError = (e: unknown) => {
  const c = (e as { cause?: { code?: string }; code?: string });
  return (c.cause?.code ?? c.code) === "UX001";
};

describe("no writes for a deleted account (race-safe)", () => {
  it("account deletion and its cleanup outbox roll back together before commit", async () => {
    const a = await newUser("TEST cleanup atomic");
    const key = `photo/${a.id}/${randomUUID()}.jpg`;
    await db.insert(schema.media).values({ ownerId: a.id, kind: "photo", storageProvider: "local", storageKey: key, mimeType: "image/jpeg" });
    await expect(db.transaction(async (tx) => {
      expect((await deleteAccount(tx as unknown as typeof db, a.id)).status).toBe("deleted");
      throw Error("stop before commit");
    })).rejects.toThrow("stop before commit");
    expect((await userRow(a.id))!.status).toBe("active");
    expect(await db.select().from(schema.media).where(eq(schema.media.ownerId, a.id))).toHaveLength(1);
    expect(await getSql()`select id from media_cleanup_requests where storage_key=${key}`).toHaveLength(0);
  });

  it("failed physical media deletion retains a durable retry after the account and media rows are gone", async () => {
    const a = await newUser("TEST cleanup retry");
    const key = `photo/${a.id}/${randomUUID()}.jpg`;
    await db.insert(schema.media).values({ ownerId: a.id, kind: "photo", storageProvider: "local", storageKey: key, mimeType: "image/jpeg" });
    const { getMediaStorage } = await import("@ustal/storage");
    const remove = vi.spyOn(getMediaStorage(), "remove").mockRejectedValue(new Error("private provider response must not be persisted"));
    try {
      expect((await del(a)).statusCode).toBe(204);
      expect((await userRow(a.id))!.status).toBe("deleted");
      expect(await db.select().from(schema.media).where(eq(schema.media.ownerId, a.id))).toEqual([]);
      const [present] = await getSql()`select to_regclass('public.media_cleanup_requests') is not null as present`;
      expect(present!.present, "failed removal must survive process restart in a durable outbox").toBe(true);
      const rows = await getSql()`select * from media_cleanup_requests where storage_key=${key}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.attempts).toBe(1);
      expect(JSON.stringify(rows)).not.toContain("private provider response");
      await getSql()`delete from media_cleanup_requests where storage_key=${key}`;
    } finally { remove.mockRestore(); }
  });

  it("response committed while deletion runs: deletion waits and withdraws it (never an active response of a deleted user)", async () => {
    const a = await newUser("TEST race A"), b = await newUser("TEST race B");
    const o = await order(b.id, "published");
    const inserted = gate(), release = gate();
    const writer = db.transaction(async (tx) => {
      await tx.insert(schema.responses).values({ orderId: o, executorId: a.id });
      inserted.open();
      await release.p;
    });
    await inserted.p;
    const deletion = deleteAccount(db, a.id);
    await sleep(300);
    release.open();
    await writer;
    expect((await deletion).status).toBe("deleted");
    const left = await db.select().from(schema.responses).where(and(eq(schema.responses.executorId, a.id), eq(schema.responses.status, "active")));
    expect(left).toEqual([]);
  });

  it("deletion committed first: a late insert of a response / profile input / media / device / session is refused (UX001)", async () => {
    const a = await newUser("TEST late A"), b = await newUser("TEST late B");
    const o = await order(b.id, "published");
    expect((await deleteAccount(db, a.id)).status).toBe("deleted");
    const attempts = [
      () => db.insert(schema.responses).values({ orderId: o, executorId: a.id }),
      () => db.insert(schema.profileSourceInputs).values({ userId: a.id, inputType: "text", rawText: "late", status: "confirmed" }),
      () => db.insert(schema.media).values({ ownerId: a.id, kind: "photo", storageProvider: "local", storageKey: "photo/x/y.jpg", mimeType: "image/jpeg" }),
      () => db.insert(schema.deviceInstallations).values({ userId: a.id, platform: "ios", expoPushToken: `ExponentPushToken[${randomUUID()}]` }),
      () => db.insert(schema.userSessions).values({ userId: a.id, refreshTokenHash: "h", familyId: randomUUID(), expiresAt: new Date(Date.now() + 1e6) } as never),
      () => db.insert(schema.capabilityProfiles).values({ userId: a.id, summary: "x", profileVersion: 9, extractionVersion: "t", status: "draft" }),
      () => db.insert(schema.reports).values({ reporterId: a.id, targetType: "order", targetId: o, reason: "spam" } as never),
      () => db.insert(schema.blocks).values({ blockerId: a.id, blockedId: b.id }),
      () => db.update(schema.userProfiles).set({ name: "back" }).where(eq(schema.userProfiles.userId, a.id)),
    ];
    for (const attempt of attempts) {
      let error: unknown = null;
      try { await attempt(); } catch (e) { error = e; }
      expect(isDeletedAccountError(error), String(attempt)).toBe(true);
    }
    expect((await row(db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, a.id))))!.name).toBe("Удалённый пользователь");
    // B (live) still writes normally
    await db.insert(schema.blocks).values({ blockerId: b.id, blockedId: a.id });
  });

  it("matching results: existing candidates removed; a candidate written by an in-flight run is dropped at its commit", async () => {
    const a = await newUser("TEST mc A"), b = await newUser("TEST mc B");
    const o = await order(b.id, "published");
    const [run] = await db.insert(schema.matchingRuns).values({ orderId: o, startedAt: new Date() }).returning();
    await db.insert(schema.matchingCandidates).values({ matchingRunId: run!.id, userId: a.id, score: "70", matchType: "exact", explanation: "профиль A", breakdown: { semantic_review: { reason: "A чинит телефоны" } } });
    await db.insert(schema.matchingCandidates).values({ matchingRunId: run!.id, userId: b.id, score: "60", matchType: "exact", explanation: "b", breakdown: {} });
    const inserted = gate(), release = gate();
    const [run2] = await db.insert(schema.matchingRuns).values({ orderId: o, startedAt: new Date() }).returning();
    const inflight = db.transaction(async (tx) => {
      await tx.insert(schema.matchingCandidates).values({ matchingRunId: run2!.id, userId: a.id, score: "70", matchType: "exact", explanation: "профиль A", breakdown: {} });
      await tx.insert(schema.matchingTraces).values({ matchingRunId: run2!.id, userId: a.id, decision: "exact", detail: { reason: "A" } });
      inserted.open();
      await release.p;
    });
    await inserted.p;
    const deletion = deleteAccount(db, a.id); // waits for the in-flight run (same FOR KEY SHARE as the FK)
    await sleep(300);
    release.open();
    await inflight;
    expect((await deletion).status).toBe("deleted");
    // a run that writes after the deletion: its candidate/trace rows are silently skipped (the run itself does not fail)
    await db.insert(schema.matchingCandidates).values({ matchingRunId: run2!.id, userId: a.id, score: "70", matchType: "exact", explanation: "late", breakdown: {} });
    await db.insert(schema.matchingTraces).values({ matchingRunId: run2!.id, userId: a.id, decision: "exact", detail: {} });
    expect(await db.select().from(schema.matchingCandidates).where(eq(schema.matchingCandidates.userId, a.id))).toEqual([]);
    expect(await db.select().from(schema.matchingTraces).where(eq(schema.matchingTraces.userId, a.id))).toEqual([]);
    expect((await db.select().from(schema.matchingCandidates).where(eq(schema.matchingCandidates.userId, b.id))).length).toBe(1); // others' results intact
    await db.delete(schema.matchingRuns).where(inArray(schema.matchingRuns.id, [run!.id, run2!.id]));
  });

  it("HTTP race x20: DELETE /me vs POST response / POST profile input — never a write left for a deleted user", async () => {
    const b = await newUser("TEST http B");
    for (let i = 0; i < 20; i++) {
      _clearLoginThrottleForTests();
      const a = await newUser(`TEST http A${i}`);
      const o = await order(b.id, "published");
      const [delRes, respRes, inputRes] = await Promise.all([
        del(a),
        app.inject({ method: "POST", url: `/orders/${o}/responses`, headers: { ...auth(a), "idempotency-key": randomUUID() }, payload: { comment: "race" } }),
        app.inject({ method: "POST", url: "/profile/inputs", headers: { ...auth(a), "idempotency-key": randomUUID() }, payload: { inputType: "text", text: "Я плотник" } }),
      ]);
      expect(delRes.statusCode).toBe(204);
      for (const r of [respRes, inputRes]) expect(r.statusCode, r.body).toBeLessThan(500);
      expect(await db.select().from(schema.responses).where(and(eq(schema.responses.executorId, a.id), eq(schema.responses.status, "active")))).toEqual([]);
      expect(await db.select().from(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.userId, a.id))).toEqual([]);
    }
  }, 120000);
});
