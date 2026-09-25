/**
 * Контакты (телефон/WhatsApp) доступны, только пока отношения живые. Запись contact_unlocks
 * сама по себе доступа не даёт — она лишь история («заказчик раскрыл контакт»).
 *
 * Живые отношения — заказ в published / negotiating / in_progress и при этом:
 *  - у исполнителя есть назначение в статусе selected / in_progress, либо
 *  - назначения нет, а его отклик активен (кандидат, с которым обсуждают заказ).
 * После «Выполнено», «Не выполнено», закрытия, истечения, отмены, снятия выбора, отзыва отклика
 * или выбора другого исполнителя контакты закрываются сразу, без дополнительного окна.
 * Блокировка и неактивный аккаунт проверяются отдельно там, где есть данные о них.
 */
const LIVE_ORDER_STATUSES = ["published", "negotiating", "in_progress"];
const LIVE_ASSIGNMENT_STATUSES = ["selected", "in_progress"];

export function isContactAccessOpen(input: {
  orderStatus: string | null | undefined;
  assignmentStatus: string | null | undefined;
  responseStatus: string | null | undefined;
}): boolean {
  if (!input.orderStatus || !LIVE_ORDER_STATUSES.includes(input.orderStatus)) return false;
  if (input.assignmentStatus) return LIVE_ASSIGNMENT_STATUSES.includes(input.assignmentStatus);
  return input.responseStatus === "active";
}

/** Заказ ещё принимает раскрытие контактов (нужно для POST /contact-unlocks). */
export function canUnlockContactsForOrder(orderStatus: string): boolean {
  return orderStatus === "published" || orderStatus === "negotiating";
}
