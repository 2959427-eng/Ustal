/**
 * Клиентский идемпотентный ключ для AI-эндпоинтов (POST /profile/inputs,
 * POST /orders, ...) — backend требует непустой Idempotency-Key
 * (apps/api/src/lib/idempotency.ts: значение хранится как обычная строка,
 * формат не проверяется). Не криптографический UUID — `expo-crypto` не
 * входит в зависимости мобильного приложения; для цели (не задвоить один и
 * тот же AI-запрос при повторном тапе/ретрае сети в пределах одной сессии)
 * достаточно уникальности без криптостойкости.
 */
export function generateIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
