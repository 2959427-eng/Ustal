/**
 * Separator between the user's messages in a cumulative profile source (must equal
 * PROFILE_SOURCE_SEPARATOR in @ustal/database; checked by a worker test).
 */
export const PROFILE_MESSAGE_SEPARATOR = "\nПоследнее изменение пользователя:\n";

function chunk(source: string): string[] {
  const spans: string[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(start + 1000, source.length);
    if (end < source.length) {
      const boundary = Math.max(source.lastIndexOf(" ", end - 1), source.lastIndexOf("\n", end - 1));
      if (boundary > start) end = boundary + 1;
      // Do not split a UTF-16 surrogate pair when a long token has no whitespace.
      if (/[\uD800-\uDBFF]/.test(source[end - 1]!)) end--;
    }
    spans.push(source.slice(start, end));
    start = end;
  }
  return spans;
}

/**
 * Server-owned contiguous citation spans: the model selects evidence instead of retyping it.
 * A cumulative profile is cut per user message first (2026-10-06): a span never crosses messages,
 * so every fact's evidence tells which message it came from (needed to apply later updates of
 * restrictions in order). A single message (every order, a one-message profile) is unchanged.
 */
export function sourceEvidenceSpans(source: string): string[] {
  if (!source.length) throw new Error("Source evidence requires nonempty input");
  return source.split(PROFILE_MESSAGE_SEPARATOR).filter((segment) => segment.length > 0).flatMap(chunk);
}
