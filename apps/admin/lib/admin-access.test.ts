import { beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import {
  assertOneOf, authorizeAdmin, hasPermission, MODERATION_DECISIONS, passwordFingerprint, REPORT_STATUS_VALUES, USER_STATUS_VALUES,
  type AdminRow,
} from "./admin-access";

const SECRET = "admin-session-secret-for-tests-0123456789";
beforeAll(() => {
  process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
  process.env.JWT_ACCESS_SECRET = "jwt-access-secret-for-tests-0123456789";
  process.env.JWT_REFRESH_SECRET = "jwt-refresh-secret-for-tests-012345678";
  process.env.ADMIN_SESSION_SECRET = SECRET;
});

const owner: AdminRow = { id: "11111111-1111-4111-8111-111111111111", email: "owner@ustal.ru", role: "superadmin", passwordHash: "$argon2id$v=19$owner" };
const moderator: AdminRow = { id: "22222222-2222-4222-8222-222222222222", email: "mod@ustal.ru", role: "moderator", passwordHash: "$argon2id$v=19$mod" };
const claimsFor = (row: AdminRow) => ({ sub: row.id, pwv: passwordFingerprint(row.passwordHash) });

describe("authorizeAdmin: сессия сверяется с admin_users", () => {
  it("действующий администратор и модератор проходят, роль берётся из БД", () => {
    expect(authorizeAdmin(claimsFor(owner), owner)).toEqual({ sub: owner.id, email: owner.email, role: "superadmin" });
    expect(authorizeAdmin(claimsFor(moderator), moderator)?.role).toBe("moderator");
  });
  it("удалённый администратор теряет доступ сразу", () => {
    expect(authorizeAdmin(claimsFor(owner), undefined)).toBeNull();
    expect(authorizeAdmin(claimsFor(owner), null)).toBeNull();
  });
  it("отключённый (роль вне списка) и неизвестная роль — нет доступа", () => {
    for (const role of ["disabled", "", "admin", "SUPERADMIN", "superadmin "])
      expect(authorizeAdmin(claimsFor(owner), { ...owner, role })).toBeNull();
  });
  it("понижение роли в БД действует сразу, а роль в токене игнорируется", () => {
    const claims = { ...claimsFor(owner), role: "superadmin" };
    expect(authorizeAdmin(claims, { ...owner, role: "moderator" })?.role).toBe("moderator");
  });
  it("смена пароля отзывает прежние сессии", () => {
    expect(authorizeAdmin(claimsFor(owner), { ...owner, passwordHash: "$argon2id$v=19$new" })).toBeNull();
  });
  it("старый токен без pwv (до исправления) недействителен", () => {
    expect(authorizeAdmin({ sub: owner.id }, owner)).toBeNull();
    expect(authorizeAdmin({ sub: owner.id, pwv: 1 }, owner)).toBeNull();
  });
  it("sub чужой строки или не строка — отказ", () => {
    expect(authorizeAdmin({ ...claimsFor(owner), sub: moderator.id }, owner)).toBeNull();
    expect(authorizeAdmin({ ...claimsFor(owner), sub: 42 }, owner)).toBeNull();
    expect(authorizeAdmin(null, owner)).toBeNull();
  });
  it("отпечаток не раскрывает хеш пароля", () => {
    expect(passwordFingerprint(owner.passwordHash)).not.toContain("argon2");
    expect(passwordFingerprint(owner.passwordHash)).toHaveLength(32);
  });
});

describe("права ролей", () => {
  it("superadmin может всё", () => {
    for (const p of ["moderation.resolve", "reports.resolve", "users.set_status", "ontology.manage"] as const)
      expect(hasPermission("superadmin", p)).toBe(true);
  });
  it("moderator: только модерация и жалобы", () => {
    expect(hasPermission("moderator", "moderation.resolve")).toBe(true);
    expect(hasPermission("moderator", "reports.resolve")).toBe(true);
    expect(hasPermission("moderator", "users.set_status")).toBe(false);
    expect(hasPermission("moderator", "ontology.manage")).toBe(false);
  });
  it("неизвестная/отключённая роль — ничего", () => {
    for (const role of ["disabled", undefined, null, "constructor", "__proto__"])
      expect(hasPermission(role, "reports.resolve")).toBe(false);
  });
});

describe("аргументы server actions от клиента", () => {
  it("принимаются только допустимые значения", () => {
    expect(assertOneOf("blocked", USER_STATUS_VALUES)).toBe("blocked");
    expect(() => assertOneOf("deleted", USER_STATUS_VALUES)).toThrow();
    expect(() => assertOneOf("active ", USER_STATUS_VALUES)).toThrow();
    expect(() => assertOneOf({ toString: () => "active" }, USER_STATUS_VALUES)).toThrow();
    expect(() => assertOneOf("published", MODERATION_DECISIONS)).toThrow();
    expect(() => assertOneOf("open", REPORT_STATUS_VALUES)).toThrow();
  });
});

describe("подпись cookie-сессии (admin-auth.ts)", () => {
  it("валидный токен читается; поддельный, alg=none, другой алгоритм и истёкший — нет", async () => {
    const { signAdminSession, verifyAdminSession } = await import("./admin-auth");
    const payload = { sub: owner.id, email: owner.email, role: owner.role, pwv: passwordFingerprint(owner.passwordHash) };
    const good = signAdminSession(payload);
    expect(verifyAdminSession(good)?.sub).toBe(owner.id);
    expect(verifyAdminSession(jwt.sign(payload, "other-secret-0123456789abcdef"))).toBeNull();
    const [h, b] = good.split(".");
    void h;
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${b}.`;
    expect(verifyAdminSession(none)).toBeNull();
    expect(verifyAdminSession(jwt.sign(payload, SECRET, { algorithm: "HS512" }))).toBeNull();
    expect(verifyAdminSession(jwt.sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET))).toBeNull();
    const tampered = `${good.split(".")[0]}.${Buffer.from(JSON.stringify({ ...payload, role: "superadmin", sub: moderator.id })).toString("base64url")}.${good.split(".")[2]}`;
    expect(verifyAdminSession(tampered)).toBeNull();
  });
  it("даже валидно подписанный токен без строки в БД не даёт доступа", async () => {
    const { signAdminSession, verifyAdminSession } = await import("./admin-auth");
    const claims = verifyAdminSession(signAdminSession({ sub: owner.id, email: owner.email, role: "superadmin", pwv: passwordFingerprint(owner.passwordHash) }));
    expect(authorizeAdmin(claims, undefined)).toBeNull();
    expect(authorizeAdmin(claims, owner)?.role).toBe("superadmin");
  });
});
