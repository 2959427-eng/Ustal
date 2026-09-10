/** Общий хелпер для query-параметров пагинации (GET /feed, /my/orders, /my/responses). */
export function toQuery(params: Record<string, number | string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}
