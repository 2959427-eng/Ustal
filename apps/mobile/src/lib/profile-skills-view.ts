/**
 * Состояние карточки «Навыки и ресурсы» в «Моём профиле». Чистая логика — покрыта тестами.
 * Пустой профиль показывается только после успешной загрузки: загрузка и ошибка — не «ничего не рассказали».
 */
export type ProfileSkillsView = "loading" | "error" | "empty" | "filled";

export function profileSkillsView(input: {
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
  labels: { capabilities: string[]; resources: string[] };
}): ProfileSkillsView {
  if (!input.hasData) return input.isError ? "error" : "loading";
  if (input.isLoading) return "loading";
  return input.labels.capabilities.length === 0 && input.labels.resources.length === 0 ? "empty" : "filled";
}

/** Тексты первого экрана (2026-10-29). */
export const PROFILE_EMPTY_CTA = {
  title: "Начните зарабатывать на своих умениях",
  description: "Расскажите, что умеете делать и какие ресурсы у вас есть. ИИ подберёт подходящие заказы",
  button: "Рассказать о своих возможностях",
  caption: "Голосом или текстом — в свободной форме",
} as const;
