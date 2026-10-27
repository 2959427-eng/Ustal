import { describe, expect, it } from "vitest";
import { AI_ACTION_MESSAGES, AI_CONSENT_GRANT_LABEL, AI_CONSENT_NOT_ENFORCED, AI_CONSENT_REFUSE_LABEL, AI_CONSENT_TEXT, CONSENT_FOR_PROFILE_ROUTE, PROFILE_FILL_ROUTE, afterAiConsentRoute, aiBlockedRoute, postRegistrationRoute } from "./ai-consent-flow";

describe("порядок экранов согласия на ИИ", () => {
  it("после регистрации — сразу в приложение (или запомненный заказ), без окна согласия", () => {
    expect(postRegistrationRoute(null)).toBe("/(tabs)");
    const order = { pathname: "/order/[id]" as const, params: { id: "42" } };
    expect(postRegistrationRoute(order)).toEqual(order);
    expect(JSON.stringify(postRegistrationRoute(order))).not.toContain("ai-consent");
  });
  it("окно согласия из профиля возвращает в профиль", () => {
    expect(CONSENT_FOR_PROFILE_ROUTE).toEqual({ pathname: "/ai-consent", params: { next: "/(tabs)/profile" } });
    expect(afterAiConsentRoute({ onboarding: false, next: CONSENT_FOR_PROFILE_ROUTE.params.next })).toBe(PROFILE_FILL_ROUTE);
  });
  it("заблокированное ИИ-действие: решения нет → окно согласия; отказ/нет условий → профиль (с профиля — сообщение на месте)", () => {
    const ask = { ok: false as const, gate: "ask" as const, message: AI_ACTION_MESSAGES.ask };
    const blocked = { ok: false as const, gate: "blocked" as const, message: AI_ACTION_MESSAGES.refused };
    const unknown = { ok: false as const, gate: "unknown" as const, message: AI_ACTION_MESSAGES.unknown };
    expect(aiBlockedRoute({ ok: true }, "other")).toBeNull();
    expect(aiBlockedRoute(ask, "profile")).toBe(CONSENT_FOR_PROFILE_ROUTE);
    expect(aiBlockedRoute(ask, "other")).toBe(CONSENT_FOR_PROFILE_ROUTE);
    expect(aiBlockedRoute(blocked, "profile")).toBeNull();
    expect(aiBlockedRoute(blocked, "other")).toBe(PROFILE_FILL_ROUTE);
    expect(aiBlockedRoute(unknown, "other")).toBeNull();
    for (const m of Object.values(AI_ACTION_MESSAGES)) expect(m).toMatch(/не передаются|не отправлен|не обрабатывает/);
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
