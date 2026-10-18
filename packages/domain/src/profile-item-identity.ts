/** Comparison key only: never overwrite a user's label/evidence with this value.
 * No stemming, substring matching or semantic similarity: different item names
 * remain different. Keep meaningful suffixes such as C++, C# and model numbers.
 */
export function normalizeProfileItemIdentity(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/ё/g, "е")
    .replace(/\s+/gu, " ").trim().replace(/(?:\s*[.,!?;:…])+$/u, "").trim();
}
