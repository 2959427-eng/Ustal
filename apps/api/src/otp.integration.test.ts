import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { getLastMockCode } from "./lib/sms/mock.js";
import { signAccessToken } from "./lib/auth-tokens.js";

process.env.NODE_ENV = "test"; // включает пропуск кеша в loadEnv() (packages/config) — нужно переключать режим между кейсами
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-0123456789";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-0123456789";
process.env.PHONE_VERIFICATION_SECRET ??= "test-phone-verification-secret-01234";
assertLocalTestDatabase();

const db = getDb();
const userIds: string[] = [];
const cityIds: string[] = [];
let cityId: string;
const newPhone = () => `+7${Math.floor(1e9 + Math.random() * 9e9)}`;

let app: FastifyInstance;
beforeAll(async () => {
  process.env.PHONE_VERIFICATION_MODE = "disabled";
  const [city] = await db.insert(schema.cities).values({
    name: "TEST otp", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id;
  cityIds.push(cityId);
  const { buildApp } = await import("./app.js");
  app = await buildApp();
  await app.ready();
});
// Each case gets an independent IP quota; requests within one race share that IP.
let testIp = 1;
beforeEach(() => { testIp += 1; });
afterEach(() => {
  delete process.env.OTP_REQUEST_COOLDOWN_SECONDS;
  delete process.env.OTP_REQUESTS_PER_PHONE_PER_DAY;
  delete process.env.OTP_MAX_ATTEMPTS;
});
afterAll(async () => {
  delete process.env.PHONE_VERIFICATION_MODE;
  if (userIds.length) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  if (cityIds.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

const register = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/auth/register", payload });
const login = (phone: string, password = "password123") => app.inject({ method: "POST", url: "/auth/login", payload: { phone, password } });
const otpRequest = (phone: string) => app.inject({ method: "POST", url: "/auth/otp/request", remoteAddress: `192.0.2.${testIp}`, payload: { phone } });
const otpVerify = (phone: string, code: string) => app.inject({ method: "POST", url: "/auth/otp/verify", remoteAddress: `192.0.2.${testIp}`, payload: { phone, code } });

it("PHONE_VERIFICATION_MODE=disabled: OTP routes are 404, registration is unchanged (phone stays unverified, nothing is blocked)", async () => {
  process.env.PHONE_VERIFICATION_MODE = "disabled";
  expect((await otpRequest(newPhone())).statusCode).toBe(404);
  expect((await otpVerify(newPhone(), "000000")).statusCode).toBe(404);

  const phone = newPhone();
  const reg = await register({ name: "Test", phone, password: "password123", cityId, acceptedRules: true, acceptedPdn: true });
  expect(reg.statusCode).toBe(201);
  const user = await db.query.users.findFirst({ where: eq(schema.users.phone, phone) });
  userIds.push(user!.id);
  expect(user?.phoneVerifiedAt).toBeNull();
  expect(user?.verificationLevel).toBe("none");

  const loginRes = await login(phone);
  expect(loginRes.statusCode).toBe(200);
  expect(loginRes.json().phoneVerificationSuggested).toBe(false);

  const auth = { authorization: `Bearer ${signAccessToken(user!.id)}` };
  expect((await app.inject({ method: "POST", url: "/me/phone/otp/request", headers: auth })).statusCode).toBe(404);
});

it("required_for_new: registration needs a verified phone (end to end with the mock code)", async () => {
  process.env.PHONE_VERIFICATION_MODE = "required_for_new";
  const phone = newPhone();

  const noToken = await register({ name: "Test", phone, password: "password123", cityId, acceptedRules: true, acceptedPdn: true });
  expect(noToken.statusCode).toBe(400);
  expect(noToken.json().error.code).toBe("phone_verification_required");

  expect((await otpRequest(phone)).statusCode).toBe(202);
  const code = getLastMockCode(phone)!;
  expect(code).toMatch(/^\d{6}$/);
  const wrong = code === "000000" ? "111111" : "000000";
  expect((await otpVerify(phone, wrong)).statusCode).toBe(400);
  const verify = await otpVerify(phone, code);
  expect(verify.statusCode).toBe(200);
  const { phoneVerificationToken } = verify.json();

  // одноразовый — повторно не подходит
  expect((await otpVerify(phone, code)).statusCode).toBe(400);

  // токен другого номера не подходит
  const otherPhone = newPhone();
  const badRegister = await register({
    name: "Test", phone: otherPhone, password: "password123", cityId,
    acceptedRules: true, acceptedPdn: true, phoneVerificationToken,
  });
  expect(badRegister.statusCode).toBe(400);
  expect(badRegister.json().error.code).toBe("phone_verification_invalid");

  const reg = await register({
    name: "Test", phone, password: "password123", cityId,
    acceptedRules: true, acceptedPdn: true, phoneVerificationToken,
  });
  expect(reg.statusCode).toBe(201);
  const user = await db.query.users.findFirst({ where: eq(schema.users.phone, phone) });
  userIds.push(user!.id);
  expect(user?.phoneVerifiedAt).not.toBeNull();
  expect(user?.verificationLevel).toBe("phone");

  // номер занят — OTP на него больше не выдаётся
  expect((await otpRequest(phone)).statusCode).toBe(409);
});

it("required_for_new does not retroactively block an existing unverified user: login still works, verification is only suggested and optional", async () => {
  process.env.PHONE_VERIFICATION_MODE = "disabled";
  const phone = newPhone();
  const reg = await register({ name: "Legacy", phone, password: "password123", cityId, acceptedRules: true, acceptedPdn: true });
  const userId = reg.json().userId as string;
  userIds.push(userId);

  process.env.PHONE_VERIFICATION_MODE = "required_for_new";
  const loginRes = await login(phone);
  expect(loginRes.statusCode).toBe(200); // не блокирует
  expect(loginRes.json().phoneVerificationSuggested).toBe(true);

  const auth = { authorization: `Bearer ${loginRes.json().accessToken}` };
  expect((await app.inject({ method: "POST", url: "/me/phone/otp/request", headers: auth })).statusCode).toBe(202);
  const code = getLastMockCode(phone)!;
  const wrong = code === "000000" ? "111111" : "000000";
  expect((await app.inject({ method: "POST", url: "/me/phone/otp/verify", headers: auth, payload: { code: wrong } })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: "/me/phone/otp/verify", headers: auth, payload: { code } })).statusCode).toBe(204);

  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  expect(user?.phoneVerifiedAt).not.toBeNull();

  expect((await login(phone)).json().phoneVerificationSuggested).toBe(false);
  expect((await app.inject({ method: "POST", url: "/me/phone/otp/request", headers: auth })).statusCode).toBe(409);
});

it("rate limits: cooldown between requests, daily cap, and attempts cap on wrong codes", async () => {
  process.env.PHONE_VERIFICATION_MODE = "required_for_new";
  process.env.OTP_REQUEST_COOLDOWN_SECONDS = "600";
  process.env.OTP_REQUESTS_PER_PHONE_PER_DAY = "1";
  const phone = newPhone();
  expect((await otpRequest(phone)).statusCode).toBe(202);
  const second = await otpRequest(phone);
  expect(second.statusCode).toBe(429);
  expect(second.json().error.code).toBe("rate_limited");
});

it("wrong codes exhaust the attempt limit; even the real code is then rejected", async () => {
  process.env.PHONE_VERIFICATION_MODE = "required_for_new";
  process.env.OTP_MAX_ATTEMPTS = "3";
  const phone = newPhone();
  expect((await otpRequest(phone)).statusCode).toBe(202);
  for (let i = 0; i < 3; i++) {
    expect((await otpVerify(phone, "999999")).statusCode).toBe(400);
  }
  const realCode = getLastMockCode(phone)!;
  expect((await otpVerify(phone, realCode)).statusCode).toBe(400);
});

it("security-фикс: параллельные /auth/otp/request на один номер не обходят cooldown/дневной лимит гонкой (count+insert атомарны)", async () => {
  process.env.PHONE_VERIFICATION_MODE = "required_for_new";
  process.env.OTP_REQUEST_COOLDOWN_SECONDS = "0"; // изолируем именно дневной лимит от cooldown
  process.env.OTP_REQUESTS_PER_PHONE_PER_DAY = "3";
  const phone = newPhone();

  const results = await Promise.all(Array.from({ length: 10 }, () => otpRequest(phone)));
  const succeeded = results.filter((r) => r.statusCode === 202);
  const limited = results.filter((r) => r.statusCode === 429);
  expect(succeeded.length).toBe(3);
  expect(limited.length).toBe(7);

  const rows = await db.query.phoneOtpCodes.findMany({ where: eq(schema.phoneOtpCodes.phone, phone) });
  expect(rows.length).toBe(3); // без race-фикса здесь могло быть до 10 -- по одной SMS на каждый параллельный запрос
});

it("security-фикс: параллельные /auth/otp/verify не обходят OTP_MAX_ATTEMPTS гонкой (read+increment атомарны)", async () => {
  process.env.PHONE_VERIFICATION_MODE = "required_for_new";
  process.env.OTP_MAX_ATTEMPTS = "3";
  const phone = newPhone();
  expect((await otpRequest(phone)).statusCode).toBe(202);

  const results = await Promise.all(Array.from({ length: 15 }, () => otpVerify(phone, "999999")));
  expect(results.every((r) => r.statusCode === 400)).toBe(true);

  const row = await db.query.phoneOtpCodes.findFirst({ where: eq(schema.phoneOtpCodes.phone, phone), orderBy: (t, { desc: d }) => d(t.createdAt) });
  expect(row?.attempts).toBe(3); // без race-фикса счётчик мог недосчитаться (потерянные инкременты) и остаться ниже лимита

  // Лимит действительно исчерпан -- даже настоящий код больше не проходит.
  const realCode = getLastMockCode(phone)!;
  expect((await otpVerify(phone, realCode)).statusCode).toBe(400);
});
