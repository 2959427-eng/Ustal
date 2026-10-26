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

/** Маршрут сразу после успешной регистрации: сначала «Как работает USTAL», затем запомненный заказ или главный экран. */
export function postRegistrationRoute(pendingOrder: { pathname: "/order/[id]"; params: { id: string } } | null):
  { pathname: "/ai-consent"; params: { onboarding: "1"; next?: string } } {
  return pendingOrder
    ? { pathname: "/ai-consent", params: { onboarding: "1", next: `/order/${encodeURIComponent(pendingOrder.params.id)}` } }
    : { pathname: "/ai-consent", params: { onboarding: "1" } };
}
