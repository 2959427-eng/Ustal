import { expect, it } from "vitest";
import { isDraftEmpty, isResponseDraft, profileAiStatus, PROFILE_AI_GIVE_UP_MS, PROFILE_AI_WAIT_MS } from "./profile-draft";

const diff = (p: Partial<Record<"addedCapabilities" | "addedResources" | "removedCapabilities" | "removedResources" | "addedUnmapped", string[]>> = {}) =>
  ({ addedCapabilities: [], addedResources: [], removedCapabilities: [], removedResources: [], addedUnmapped: [], ...p });

it("a draft without any change is empty", () => {
  expect(isDraftEmpty(diff())).toBe(true);
  expect(isDraftEmpty(diff({ addedResources: ["легковой автомобиль"] }))).toBe(false);
  expect(isDraftEmpty(diff({ addedUnmapped: ["копать"] }))).toBe(false);
  expect(isDraftEmpty(diff({ removedCapabilities: ["вождение"] }))).toBe(false);
});

it("profile screen status after «Сохранить»", () => {
  const now = 1_000_000;
  expect(profileAiStatus({ hasDraft: false, draftEmpty: false, pendingAt: null, now })).toBe("idle");
  expect(profileAiStatus({ hasDraft: false, draftEmpty: false, pendingAt: now - 1000, now })).toBe("processing");
  // Нет ответа AI — это не «ничего не нашёл».
  expect(profileAiStatus({ hasDraft: false, draftEmpty: false, pendingAt: now - PROFILE_AI_WAIT_MS, now })).toBe("slow");
  expect(profileAiStatus({ hasDraft: false, draftEmpty: false, pendingAt: now - PROFILE_AI_GIVE_UP_MS, now })).toBe("no_response");
  expect(profileAiStatus({ hasDraft: true, draftEmpty: false, pendingAt: null, now })).toBe("review");
  expect(profileAiStatus({ hasDraft: true, draftEmpty: true, pendingAt: now, now })).toBe("nothing_found");
});

it("a draft left from an earlier attempt is not the answer to the new text", () => {
  const pending = { at: 1, prevDraftId: "old-empty" };
  expect(isResponseDraft("old-empty", pending)).toBe(false);
  expect(isResponseDraft("new", pending)).toBe(true);
  expect(isResponseDraft(null, pending)).toBe(false);
  expect(isResponseDraft("any", null)).toBe(true);
});
