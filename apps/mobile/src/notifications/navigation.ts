let pendingOrder: string | null = null;

export function orderIdFromNotification(data: Record<string, unknown>): string | null {
  return typeof data.orderId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.orderId) ? data.orderId : null;
}
export function rememberOrder(id: string): void { pendingOrder = orderIdFromNotification({ orderId: id }); }
export function consumeOrderRoute(): { pathname: "/order/[id]"; params: { id: string } } | null {
  const id = pendingOrder;
  pendingOrder = null;
  return id ? { pathname: "/order/[id]", params: { id } } : null;
}
