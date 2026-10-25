export const legalLinks = [
  ["privacy", "Конфиденциальность"], ["terms", "Пользовательское соглашение"],
  ["community-guidelines", "Правила сообщества"], ["support", "Поддержка"],
  ["delete-account", "Удаление аккаунта через сайт"],
] as const;
export function legalUrl(origin: string, page: typeof legalLinks[number][0]): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || !legalLinks.some(([key]) => key === page)) throw new Error("Некорректный адрес документов USTAL");
  return new URL(`/${page}`, url.origin).href;
}
