import { randomInt, createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { loadEnv } from "@ustal/config";
import { getSmsProvider } from "./sms/index.js";

const CODE_LENGTH = 6;

export type OtpPurpose = "register" | "existing_user";

export class OtpError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function hashCode(phone: string, purpose: OtpPurpose, code: string): string {
  return createHash("sha256").update(`${phone}:${purpose}:${code}`).digest("hex");
}

/**
 * Запрашивает код и отправляет его через getSmsProvider(). Лимиты — по
 * номеру (не по IP: у SMS есть собственная цена, IP-лимит её не защищает).
 */
export async function requestOtp(phone: string, purpose: OtpPurpose): Promise<void> {
  const env = loadEnv();
  const db = getDb();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Race-фикс: count(recent)+insert раньше шли отдельными запросами вне
  // транзакции -- тот же класс гонки, уже найденный и исправленный в
  // POST /orders, /profile/inputs, /media, /reports (см.
  // claude/security-audit-2026-09-22.md): под параллельными запросами на
  // один и тот же номер все читали cooldown/дневной лимит ДО того, как
  // хоть один insert зафиксируется, и оба лимита обходились полностью --
  // SMS-бомбардировка ПРОИЗВОЛЬНОГО номера (purpose="register" анонимный,
  // не требует владения номером). pg_advisory_xact_lock по номеру телефона
  // (эндпоинт анонимный -- нет userId для ключа блокировки, как в остальных
  // 4 местах).
  let cooldownRetryAfter: number | null = null;
  let dailyLimitExceeded = false;
  let code = "";
  const inserted = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${phone}))`);

    const recent = await tx.query.phoneOtpCodes.findMany({
      where: and(eq(schema.phoneOtpCodes.phone, phone), eq(schema.phoneOtpCodes.purpose, purpose), gt(schema.phoneOtpCodes.createdAt, dayAgo)),
      orderBy: (t, { desc: d }) => d(t.createdAt),
    });

    if (recent.length > 0) {
      const secondsSinceLast = (now.getTime() - recent[0]!.createdAt.getTime()) / 1000;
      if (secondsSinceLast < env.OTP_REQUEST_COOLDOWN_SECONDS) {
        cooldownRetryAfter = Math.ceil(env.OTP_REQUEST_COOLDOWN_SECONDS - secondsSinceLast);
        return false;
      }
    }
    if (recent.length >= env.OTP_REQUESTS_PER_PHONE_PER_DAY) {
      dailyLimitExceeded = true;
      return false;
    }

    code = String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, "0");
    const expiresAt = new Date(now.getTime() + env.OTP_CODE_TTL_MINUTES * 60 * 1000);
    await tx.insert(schema.phoneOtpCodes).values({ phone, purpose, codeHash: hashCode(phone, purpose, code), expiresAt });
    return true;
  });

  if (cooldownRetryAfter !== null) {
    throw new OtpError("rate_limited", `Подождите ${cooldownRetryAfter} с перед повторной отправкой кода`);
  }
  if (dailyLimitExceeded) {
    throw new OtpError("rate_limited", "Превышен дневной лимит запросов кода для этого номера");
  }
  if (!inserted) throw new Error("Failed to record OTP code");

  // Отправка SMS -- сетевой I/O, намеренно вне транзакции (тот же паттерн,
  // что storage.upload в POST /media) -- не держит соединение из пула на
  // время внешнего запроса.
  await getSmsProvider().send(phone, code);
}

/** true — код верный и ещё не использован; попытка расходуется на каждый неверный ввод. */
export async function verifyOtp(phone: string, code: string, purpose: OtpPurpose): Promise<boolean> {
  const env = loadEnv();
  const db = getDb();
  const now = new Date();

  // Race-фикс: select(attempts) и update(attempts+1) раньше шли отдельными
  // запросами вне транзакции -- параллельные попытки подбора кода читали
  // один и тот же attempts ДО того, как конкурирующий update
  // зафиксируется, теряя инкременты и фактически снимая ограничение
  // OTP_MAX_ATTEMPTS на число попыток (позволяя перебрать больше кодов за
  // время жизни кода, чем задумано защитой от подбора). Тот же
  // pg_advisory_xact_lock, что и в requestOtp выше, по (телефон, purpose).
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${phone + ":" + purpose}))`);

    const row = await tx.query.phoneOtpCodes.findFirst({
      where: and(
        eq(schema.phoneOtpCodes.phone, phone),
        eq(schema.phoneOtpCodes.purpose, purpose),
        isNull(schema.phoneOtpCodes.consumedAt),
        gt(schema.phoneOtpCodes.expiresAt, now),
      ),
      orderBy: (t, { desc: d }) => d(t.createdAt),
    });
    if (!row || row.attempts >= env.OTP_MAX_ATTEMPTS) return false;

    if (row.codeHash !== hashCode(phone, purpose, code)) {
      await tx.update(schema.phoneOtpCodes).set({ attempts: row.attempts + 1 }).where(eq(schema.phoneOtpCodes.id, row.id));
      return false;
    }
    await tx.update(schema.phoneOtpCodes).set({ consumedAt: now }).where(eq(schema.phoneOtpCodes.id, row.id));
    return true;
  });
}
