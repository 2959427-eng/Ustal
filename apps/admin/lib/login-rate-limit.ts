/**
 * Защита формы входа в админку от подбора пароля (аудит безопасности,
 * 2026-09-06). Раньше `loginAction` не имел вообще никакой защиты от
 * перебора: это Next.js server action, а не Fastify-роут, так что
 * глобальный @fastify/rate-limit из apps/api на него не действует, а
 * админка торчит на публичном домене (Caddy + TLS, без IP-ограничения).
 *
 * In-memory, по IP — не отдельная БД-таблица и не новая зависимость
 * (осознанно, чтобы не трогать миграции/package.json без возможности
 * прогнать npm install на реальной машине из этой сессии). При перезапуске
 * контейнера счётчик сбрасывается — приемлемо для MVP с одним инстансом
 * admin (docker-compose.prod.yml — один контейнер `admin`, не реплики).
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Bucket {
  count: number;
  windowStart: number;
  lockedUntil?: number;
}

const buckets = new Map<string, Bucket>();

export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket?.lockedUntil && bucket.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

export function recordFailedLoginAttempt(key: string): void {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
  }
  bucket.count += 1;
  if (bucket.count >= MAX_ATTEMPTS) {
    bucket.lockedUntil = now + WINDOW_MS;
  }
  buckets.set(key, bucket);
}

export function resetLoginAttempts(key: string): void {
  buckets.delete(key);
}
