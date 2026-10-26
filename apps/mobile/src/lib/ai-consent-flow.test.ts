import { describe, expect, it } from "vitest";
import { AI_CONSENT_GRANT_LABEL, AI_CONSENT_NOT_ENFORCED, AI_CONSENT_REFUSE_LABEL, AI_CONSENT_TEXT, afterAiConsentRoute, postRegistrationRoute } from "./ai-consent-flow";

describe("порядок экранов согласия на ИИ", () => {
  it("после регистрации сначала «Как работает USTAL», запомненный заказ — потом", () => {
    expect(postRegistrationRoute(null)).toEqual({ pathname: "/ai-consent", params: { onboarding: "1" } });
    expect(postRegistrationRoute({ pathname: "/order/[id]", params: { id: "42" } })).toEqual({ pathname: "/ai-consent", params: { onboarding: "1", next: "/order/42" } });
  });
  it("после решения — только внутренний путь, внешний/протокольный адрес и петля на себя игнорируются", () => {
    expect(afterAiConsentRoute({ onboarding: true })).toBe("/(tabs)");
    expect(afterAiConsentRoute({ onboarding: true, next: "/order/42" })).toBe("/order/42");
    for (const bad of ["https://evil.example", "//evil.example", "javascript://x", "order/42", "/ai-consent?onboarding=1"])
      expect(afterAiConsentRoute({ onboarding: true, next: bad })).toBe("/(tabs)");
  });
  it("текст окна дословно совпадает с утверждённым владельцем 2026-10-26", () => {
    expect([...AI_CONSENT_TEXT].join("\n")).toBe([
      "USTAL использует искусственный интеллект OpenAI, чтобы понимать ваши навыки и ресурсы, анализировать заказы и находить подходящие предложения.",
      "Для этого необходимые данные профиля, тексты заказов и голосовые записи могут передаваться OpenAI для обработки.",
      "Подробнее — в Политике конфиденциальности.",
      "Нажимая «Разрешаю и продолжить», вы даёте разрешение на такую обработку и передачу данных. Разрешение можно отозвать, но без него основные функции USTAL будут недоступны.",
    ].join("\n"));
    expect(AI_CONSENT_GRANT_LABEL).toBe("Разрешаю и продолжить");
    expect(AI_CONSENT_REFUSE_LABEL).toBe("Не разрешаю");
  });
  it("в режиме off экран не обещает блокировку передачи", () => {
    expect(AI_CONSENT_NOT_ENFORCED).toMatch(/не запрашивает/);
    expect(AI_CONSENT_NOT_ENFORCED).not.toMatch(/ничего не передаёт/);
  });
});
