/** Server-owned contiguous citation spans: the model selects evidence instead of retyping it. */
export function sourceEvidenceSpans(source: string): string[] {
  if (!source.length) throw new Error("Source evidence requires nonempty input");
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
