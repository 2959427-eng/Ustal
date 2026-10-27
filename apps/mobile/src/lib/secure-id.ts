/**
 * Криптографически стойкий случайный идентификатор (128 бит, hex). Источник: Web Crypto (если есть в среде),
 * иначе expo-crypto (нативный CSPRNG). Без стойкого источника — null: вызывающий код не доверяет идентификатору.
 * Счётчик, Date.now и Math.random не используются (2026-10-27).
 */
type RandomSource = (bytes: Uint8Array) => void;

function randomSource(): RandomSource | null {
  const web = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (typeof web?.getRandomValues === "function") return (bytes) => { web.getRandomValues!(bytes); };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expoCrypto = require("expo-crypto") as { getRandomValues?: (b: Uint8Array) => Uint8Array };
    if (typeof expoCrypto.getRandomValues === "function") return (bytes) => { expoCrypto.getRandomValues!(bytes); };
  } catch { /* старая сборка без нативного модуля expo-crypto */ }
  return null;
}

export function secureRandomId(source: RandomSource | null = randomSource()): string | null {
  if (!source) return null;
  const bytes = new Uint8Array(16);
  try { source(bytes); } catch { return null; }
  if (bytes.every((b) => b === 0)) return null; // источник не заполнил буфер
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
