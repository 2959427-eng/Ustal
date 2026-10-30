import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { aiActionGate, shouldPromptAiConsent, type AiConsentState } from "./ai-consent-state";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const policy = { id: "p", purpose: "ai", version: "1", content: {}, policyHash: "h", status: "approved" };
const required = (status: "granted" | "refused" | "undecided" | "outdated"): AiConsentState =>
  ({ kind: "required", policy, text: "t", revision: 1, status } as AiConsentState);

describe("окно «Как работает USTAL» — только один раз (решение владельца 2026-10-29)", () => {
  it("на экранах нет постоянных плашек о передаче данных ИИ", () => {
    expect(existsSync(new URL("../components/AiConsentNotice.tsx", import.meta.url))).toBe(false);
    for (const screen of ["app/(tabs)/profile.tsx", "app/(tabs)/create.tsx", "app/(tabs)/_layout.tsx", "app/(tabs)/index.tsx"])
      expect(src(screen)).not.toMatch(/AiConsentNotice|shouldPromptAiConsent/);
  });
  it("окно открывается, только пока решения нет; после «Разрешаю» или «Не разрешаю» больше не показывается", () => {
    expect(aiActionGate(required("undecided"))).toBe("ask");
    expect(aiActionGate(required("granted"))).toBe("allow");
    expect(aiActionGate(required("refused"))).toBe("blocked"); // без окна: короткое сообщение при попытке
    expect(shouldPromptAiConsent(required("granted"))).toBe(false);
    expect(shouldPromptAiConsent(required("refused"))).toBe(false);
  });
});
