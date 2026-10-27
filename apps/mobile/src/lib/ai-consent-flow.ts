/** Порядок экранов согласия на ИИ. Чистая логика — покрыта тестами (ai-consent-flow.test.ts). */

/** Утверждённый владельцем текст окна (2026-10-26). Менять только с новым утверждением — тест сверяет дословно. */
export const AI_CONSENT_TEXT = [
  "USTAL использует искусственный интеллект OpenAI, чтобы понимать ваши навыки и ресурсы, анализировать заказы и находить подходящие предложения.",
  "Для этого необходимые данные профиля, тексты заказов и голосовые записи могут передаваться OpenAI для обработки.",
  "Подробнее — в Политике конфиденциальности.",
  "Нажимая «Разрешаю и продолжить», вы даёте разрешение на такую обработку и передачу данных. Разрешение можно отозвать, но без него основные функции USTAL будут недоступны.",
] as const;
export const AI_CONSENT_GRANT_LABEL = "Разрешаю и продолжить";
export const AI_CONSENT_REFUSE_LABEL = "Не разрешаю";

/** Режим off (окно не показывается, экран открыт из «Аккаунт»): честно — отдельного разрешения сервер не требует. */
export const AI_CONSENT_NOT_ENFORCED =
  "Сейчас сервер не запрашивает отдельного разрешения: тексты и голос, которые вы отправляете, обрабатываются ИИ (OpenAI) сразу.";

/**
 * Куда вести после решения. `next` принимается только как внутренний путь приложения
 * (защита от подмены на внешний адрес через параметры ссылки).
 */
export function afterAiConsentRoute(input: { onboarding: boolean; next?: string | null }): string {
  const next = input.next;
  if (next && next.startsWith("/") && !next.startsWith("//") && !next.includes("://") && !next.startsWith("/ai-consent")) return next;
  return "/(tabs)";
}

type PendingOrderRoute = { pathname: "/order/[id]"; params: { id: string } };
/**
 * Маршрут сразу после успешной регистрации — сразу в приложение, без окна согласия (2026-10-26):
 * окно показывается при первом заполнении профиля, до первой ИИ-обработки.
 */
export function postRegistrationRoute(pendingOrder: PendingOrderRoute | null): PendingOrderRoute | "/(tabs)" {
  return pendingOrder ?? "/(tabs)";
}

/** Экран заполнения профиля и переход к окну согласия с возвратом на него. */
export const PROFILE_FILL_ROUTE = "/(tabs)/profile";
export const CONSENT_FOR_PROFILE_ROUTE = { pathname: "/ai-consent", params: { next: PROFILE_FILL_ROUTE } } as const;

export type AiActionCheck = { ok: true } | { ok: false; gate: "ask" | "blocked" | "unknown"; message: string };
export const AI_ACTION_MESSAGES = {
  ask: "Перед обработкой ИИ нужно решение о передаче данных в OpenAI. Данные не отправлены.",
  refused: "Вы не разрешили передачу данных в OpenAI, поэтому ИИ не обрабатывает профиль и заказы. Разрешить можно в любой момент: «Аккаунт» → «Передача данных AI».",
  unavailable: "Обработка ИИ временно недоступна: данные в OpenAI не передаются.",
  unknown: "Не удалось проверить разрешение на обработку ИИ. Данные не отправлены — проверьте подключение и попробуйте ещё раз.",
} as const;

/**
 * Куда вести, если ИИ-действие заблокировано. С экрана профиля: ask → окно согласия с возвратом в профиль,
 * отказ — сообщение на месте. С других экранов (заказ, повтор разбора): ask → окно согласия, затем профиль;
 * отказ/нет условий → к заполнению профиля. Ошибка проверки — только сообщение.
 */
export function aiBlockedRoute(check: AiActionCheck, from: "profile" | "other"):
  typeof CONSENT_FOR_PROFILE_ROUTE | typeof PROFILE_FILL_ROUTE | null {
  if (check.ok || check.gate === "unknown") return null;
  if (check.gate === "ask") return CONSENT_FOR_PROFILE_ROUTE;
  return from === "profile" ? null : PROFILE_FILL_ROUTE;
}
