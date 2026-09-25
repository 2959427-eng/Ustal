/**
 * Заголовок заказа для показа — из текста автора, а не придуманный AI (AI ничего не
 * определяет и не дописывает). Берём первую строку/предложение, схлопываем пробелы,
 * обрезаем по границе слова до maxLen символов.
 */
export function authorTitle(text: string | null | undefined, maxLen = 80): string | null {
  const source = (text ?? "").replace(/\r/g, "").trim();
  if (!source) return null;
  const firstLine = source.split("\n")[0]!.replace(/\s+/g, " ").trim();
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]+$/, "").trim() || firstLine;
  if (sentence.length <= maxLen) return sentence;
  const cut = sentence.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—-]+$/, "")}…`;
}
