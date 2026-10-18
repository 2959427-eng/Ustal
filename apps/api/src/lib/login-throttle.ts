/**
 * Ограничение подбора пароля ПО НОМЕРУ (в дополнение к лимиту по IP): подбор с ротацией IP
 * упирается в счётчик аккаунта. Считаем только неудачные попытки; считаем и для несуществующих
 * номеров, чтобы ответ не выдавал, зарегистрирован ли номер. Хранилище в памяти процесса
 * (для одного экземпляра API достаточно; при масштабировании вынести в общее хранилище).
 * Компромисс: чужой неверный ввод может временно заблокировать вход на конкретный номер.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

interface Bucket { count: number; windowStart: number }
const buckets = new Map<string, Bucket>();

export function isLoginThrottled(phone: string, now = Date.now()): boolean {
  const b = buckets.get(phone);
  if (!b) return false;
  if (now - b.windowStart > WINDOW_MS) {
    buckets.delete(phone);
    return false;
  }
  return b.count >= MAX_FAILURES;
}

export function recordLoginFailure(phone: string, now = Date.now()): void {
  const b = buckets.get(phone);
  if (!b || now - b.windowStart > WINDOW_MS) {
    buckets.set(phone, { count: 1, windowStart: now });
    return;
  }
  b.count += 1;
}

export function resetLoginFailures(phone: string): void {
  buckets.delete(phone);
}

export function _clearLoginThrottleForTests(): void {
  buckets.clear();
}
