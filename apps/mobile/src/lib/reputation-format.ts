import type { Reputation } from "../api/reviews";

const star = (rating: number | null) => `★ ${rating === null ? "—" : rating.toFixed(1).replace(".", ",")}`;

/** «★ 4,5 (12) · выполнено 12 · не выполнено 1» — рейтинг+число оценок, затем фактические исходы. */
export function executorLine(r: Reputation["executor"]): string {
  return `${star(r.rating)} (${r.ratingCount}) · выполнено ${r.completed} · не выполнено ${r.notCompleted}`;
}

/** «★ 4,8 (3) · всего 5 · завершено 3 · отменено 0» — рейтинг+число оценок, затем история заказов. */
export function customerLine(r: Reputation["customer"]): string {
  return `${star(r.rating)} (${r.ratingCount}) · всего ${r.total} · завершено ${r.completed} · отменено ${r.cancelled}`;
}
