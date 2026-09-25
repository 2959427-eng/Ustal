/**
 * Мок-провайдер SMS — только для разработки и тестов. Код никуда не уходит:
 * пишется в лог процесса и хранится в памяти, чтобы dev/тесты могли его
 * прочитать через getLastMockCode(). packages/config/src/env.ts не даёт
 * запустить его в production, пока PHONE_VERIFICATION_MODE не disabled.
 */
const lastCodes = new Map<string, string>();

export const mockSmsProvider = {
  async send(phone: string, code: string): Promise<void> {
    lastCodes.set(phone, code);
    // eslint-disable-next-line no-console
    console.log(`[sms:mock] ${phone} -> ${code}`);
  },
};

/** Только для dev/тестов — реальный провайдер такого способа прочитать код не имеет. */
export function getLastMockCode(phone: string): string | undefined {
  return lastCodes.get(phone);
}
