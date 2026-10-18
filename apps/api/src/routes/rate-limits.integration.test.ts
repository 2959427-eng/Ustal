import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import ordersRoutes from "./orders.js";
import reportsRoutes from "./reports.js";
import mediaRoutes from "./media.js";
import contactsRoutes from "./contacts.js";
import responsesRoutes from "./responses.js";
import profileRoutes from "./profile.js";

vi.mock("../lib/notify.js", () => ({ notifyUser: vi.fn(async () => "n") }));
// POST /orders и POST /profile/inputs ставят задачи в pg-boss после создания
// строки — для тестов гонки rate-limit это нерелевантная сторона эффекта
// (сама очередь здесь не тестируется, см. другие integration-тесты worker'а),
// мокаем, чтобы не тянуть реальный pg-boss в этот файл и не завязываться на
// его старт/остановку.
vi.mock("@ustal/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ustal/queue")>();
  return { ...actual, getBoss: vi.fn(async () => ({ send: vi.fn(async () => "test-job-id") })) };
});

process.env.NODE_ENV = "test"; // включает пропуск кеша в loadEnv() (packages/config) — нужно переключать лимиты между кейсами

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
const orderIds: string[] = [];
let author: string, other: string, cityId: string;
const as = (user: string) => ({ "x-test-user": user });

async function makeUser(label: string) {
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  userIds.push(u!.id);
  await db.insert(schema.userProfiles).values({
    userId: u!.id, name: `TEST ${label}`, cityId, whatsappPhone: "+79990000000", acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
  });
  return u!.id;
}

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  for (const r of [ordersRoutes, reportsRoutes, mediaRoutes, contactsRoutes, responsesRoutes, profileRoutes]) await app.register(r);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST rate-limits", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id;
  cityIds.push(cityId);
  author = await makeUser("author");
  other = await makeUser("other");
});

afterAll(async () => {
  await db.delete(schema.media).where(inArray(schema.media.ownerId, userIds));
  await db.delete(schema.reports).where(inArray(schema.reports.reporterId, userIds));
  const allOrders = await db.query.orders.findMany({ where: inArray(schema.orders.authorId, userIds) });
  const allOrderIds = [...new Set([...orderIds, ...allOrders.map((o) => o.id)])];
  if (allOrderIds.length) {
    await db.delete(schema.contactUnlocks).where(inArray(schema.contactUnlocks.orderId, allOrderIds));
    await db.delete(schema.responses).where(inArray(schema.responses.orderId, allOrderIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, allOrderIds));
  }
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

function buildMultipart(kind: string, buffer: Buffer, mimeType: string) {
  const boundary = `----testBoundary${randomUUID().replace(/-/g, "")}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="test.bin"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { boundary, body: Buffer.concat([head, buffer, tail]) };
}

const uploadMedia = (user: string, buffer: Buffer, kind = "photo", mimeType = "image/jpeg") => {
  const { boundary, body } = buildMultipart(kind, buffer, mimeType);
  return app.inject({
    method: "POST",
    url: "/media",
    headers: { ...as(user), "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
};

it("POST /orders: превышение ORDERS_PER_HOUR отдаёт 429 раньше остальной обработки", async () => {
  process.env.ORDERS_PER_HOUR = "2";
  try {
    const seeded = await db
      .insert(schema.orders)
      .values([
        { authorId: author, cityId, sourceText: "TEST rl seed 1" },
        { authorId: author, cityId, sourceText: "TEST rl seed 2" },
      ])
      .returning();
    orderIds.push(...seeded.map((o) => o.id));

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { ...as(author), "idempotency-key": randomUUID() },
      payload: { inputType: "text", text: "TEST rl ещё один заказ сверх лимита" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
  } finally {
    delete process.env.ORDERS_PER_HOUR;
  }
});

it("POST /reports: до REPORTS_PER_HOUR жалобы проходят, дальше 429", async () => {
  process.env.REPORTS_PER_HOUR = "2";
  try {
    const payload = { targetType: "user" as const, targetId: other, reason: "spam" };
    const r1 = await app.inject({ method: "POST", url: "/reports", headers: as(author), payload });
    expect(r1.statusCode).toBe(201);
    const r2 = await app.inject({ method: "POST", url: "/reports", headers: as(author), payload });
    expect(r2.statusCode).toBe(201);
    const r3 = await app.inject({ method: "POST", url: "/reports", headers: as(author), payload });
    expect(r3.statusCode).toBe(429);
    expect(r3.json().error.code).toBe("rate_limited");
  } finally {
    delete process.env.REPORTS_PER_HOUR;
  }
});

it("POST /media: до MEDIA_UPLOADS_PER_HOUR загрузки проходят, дальше 429", async () => {
  process.env.MEDIA_UPLOADS_PER_HOUR = "2";
  try {
    const small = Buffer.alloc(100, 0x11);
    const r1 = await uploadMedia(author, small);
    expect(r1.statusCode).toBe(201);
    const r2 = await uploadMedia(author, small);
    expect(r2.statusCode).toBe(201);
    const r3 = await uploadMedia(author, small);
    expect(r3.statusCode).toBe(429);
    expect(r3.json().error.code).toBe("rate_limited");
  } finally {
    delete process.env.MEDIA_UPLOADS_PER_HOUR;
  }
});

it("POST /media: превышение MEDIA_STORAGE_MAX_BYTES_PER_USER отдаёт 400 storage_quota_exceeded", async () => {
  process.env.MEDIA_STORAGE_MAX_BYTES_PER_USER = "15000";
  try {
    const chunk = Buffer.alloc(9000, 0x22); // под лимитом на файл (10 МБ), но два таких файла превышают квоту 15000
    const r1 = await uploadMedia(other, chunk);
    expect(r1.statusCode).toBe(201);
    const r2 = await uploadMedia(other, chunk);
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe("storage_quota_exceeded");
  } finally {
    delete process.env.MEDIA_STORAGE_MAX_BYTES_PER_USER;
  }
});

it("POST /orders/:id/contact-unlocks: конкурентные запросы не превышают CONTACT_UNLOCKS_PER_HOUR (гонка устранена транзакцией+advisory lock)", async () => {
  process.env.CONTACT_UNLOCKS_PER_HOUR = "3";
  try {
    const customer = await makeUser("race-customer");
    const executors = await Promise.all(Array.from({ length: 6 }, (_, i) => makeUser(`race-exec-${i}`)));

    const [order] = await db
      .insert(schema.orders)
      .values({ authorId: customer, cityId, sourceText: "TEST race order", status: "published" })
      .returning();
    orderIds.push(order!.id);

    const responseIds: string[] = [];
    for (const executorId of executors) {
      const [resp] = await db.insert(schema.responses).values({ orderId: order!.id, executorId }).returning();
      responseIds.push(resp!.id);
    }

    // Шесть параллельных попыток раскрыть контакт шести разных исполнителей одним заказчиком —
    // до фикса count-then-insert не был атомарным, и параллельные запросы могли проскочить
    // проверку лимита до фиксации инсерта друг друга.
    const results = await Promise.all(
      responseIds.map((responseId) =>
        app.inject({
          method: "POST",
          url: `/orders/${order!.id}/contact-unlocks`,
          headers: as(customer),
          payload: { responseId },
        }),
      ),
    );

    const succeeded = results.filter((r) => r.statusCode === 201);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(succeeded.length).toBe(3);
    expect(limited.length).toBe(3);
    for (const r of limited) expect(r.json().error.code).toBe("rate_limited");

    const rows = await db.query.contactUnlocks.findMany({ where: eq(schema.contactUnlocks.orderId, order!.id) });
    expect(rows.length).toBe(3);
  } finally {
    delete process.env.CONTACT_UNLOCKS_PER_HOUR;
  }
});

// Security-фикс (2026-09-22): count (проверка per-user лимита) и insert
// раньше шли отдельными запросами вне транзакции в POST /orders, POST
// /profile/inputs, POST /media и POST /reports — тот же класс гонки, что
// был найден и устранён ранее для POST /orders/{id}/contact-unlocks (см.
// тест выше). Под параллельными запросами одного пользователя все они могли
// пройти проверку лимита до того, как хоть один insert зафиксируется, и
// лимит превышался на гонке (реальный вектор: неограниченный расход на
// AI-провайдера для orders/profile-inputs, неограниченное хранилище для
// media). Исправлено тем же pg_advisory_xact_lock-паттерном; ниже — те же
// конкурентные regression-тесты, что и для contact-unlocks выше.

it("POST /orders: конкурентные запросы не превышают ORDERS_PER_HOUR (security-фикс 2026-09-22, гонка устранена транзакцией+advisory lock)", async () => {
  process.env.ORDERS_PER_HOUR = "3";
  try {
    const raceAuthor = await makeUser("orders-race");

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: "POST",
          url: "/orders",
          headers: { ...as(raceAuthor), "idempotency-key": randomUUID() },
          payload: { inputType: "text", text: "TEST orders race" },
        }),
      ),
    );

    const succeeded = results.filter((r) => r.statusCode === 201);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(succeeded.length).toBe(3);
    expect(limited.length).toBe(3);
    for (const r of limited) expect(r.json().error.code).toBe("rate_limited");

    const rows = await db.query.orders.findMany({ where: eq(schema.orders.authorId, raceAuthor) });
    expect(rows.length).toBe(3);
  } finally {
    delete process.env.ORDERS_PER_HOUR;
  }
});

it("POST /media: конкурентные запросы не превышают MEDIA_UPLOADS_PER_HOUR (security-фикс 2026-09-22, гонка устранена транзакцией+advisory lock)", async () => {
  process.env.MEDIA_UPLOADS_PER_HOUR = "3";
  try {
    const raceUser = await makeUser("media-race");
    const small = Buffer.alloc(100, 0x33);

    const results = await Promise.all(Array.from({ length: 6 }, () => uploadMedia(raceUser, small)));

    const succeeded = results.filter((r) => r.statusCode === 201);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(succeeded.length).toBe(3);
    expect(limited.length).toBe(3);
    for (const r of limited) expect(r.json().error.code).toBe("rate_limited");

    const rows = await db.query.media.findMany({ where: eq(schema.media.ownerId, raceUser) });
    expect(rows.length).toBe(3);
  } finally {
    delete process.env.MEDIA_UPLOADS_PER_HOUR;
  }
});

it("POST /reports: конкурентные запросы не превышают REPORTS_PER_HOUR (security-фикс 2026-09-22, гонка устранена транзакцией+advisory lock)", async () => {
  process.env.REPORTS_PER_HOUR = "3";
  try {
    const raceReporter = await makeUser("reports-race");
    const payload = { targetType: "user" as const, targetId: other, reason: "spam" };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => app.inject({ method: "POST", url: "/reports", headers: as(raceReporter), payload })),
    );

    const succeeded = results.filter((r) => r.statusCode === 201);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(succeeded.length).toBe(3);
    expect(limited.length).toBe(3);
    for (const r of limited) expect(r.json().error.code).toBe("rate_limited");

    const rows = await db.query.reports.findMany({ where: eq(schema.reports.reporterId, raceReporter) });
    expect(rows.length).toBe(3);
  } finally {
    delete process.env.REPORTS_PER_HOUR;
  }
});

it("POST /profile/inputs: конкурентные запросы не превышают PROFILE_FREEFORM_EDITS_PER_HOUR (security-фикс 2026-09-22, гонка устранена транзакцией+advisory lock)", async () => {
  process.env.PROFILE_FREEFORM_EDITS_PER_HOUR = "3";
  try {
    const raceUser = await makeUser("profile-inputs-race");

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: "POST",
          url: "/profile/inputs",
          headers: { ...as(raceUser), "idempotency-key": randomUUID() },
          payload: { inputType: "text", text: "TEST profile inputs race" },
        }),
      ),
    );

    const succeeded = results.filter((r) => r.statusCode === 202);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(succeeded.length).toBe(3);
    expect(limited.length).toBe(3);
    for (const r of limited) expect(r.json().error.code).toBe("rate_limited");

    const rows = await db.query.profileSourceInputs.findMany({ where: eq(schema.profileSourceInputs.userId, raceUser) });
    expect(rows.length).toBe(3);
  } finally {
    delete process.env.PROFILE_FREEFORM_EDITS_PER_HOUR;
  }
});

