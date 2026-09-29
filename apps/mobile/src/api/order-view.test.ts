import { expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { getOrderView } from "./order-view";
import { getMyResponse, myKeys } from "./my";
import { consumeOrderRoute, orderIdFromNotification, rememberOrder } from "../notifications/navigation";
vi.mock("./client", () => ({ apiClient: { request: vi.fn() } }));

const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
it("opens with orderId only and loads authoritative data including price-offer capability", async () => {
  const detail = { id, title: "Server title", description: "Server text", photoMediaIds: ["photo"], acceptsPriceOffers: true, priceMinor: 12300 };
  vi.mocked(apiClient.request).mockResolvedValueOnce(detail);
  rememberOrder(orderIdFromNotification({ orderId: id })!);
  const route = consumeOrderRoute();
  expect(route).toEqual({ pathname: "/order/[id]", params: { id } });
  expect(await getOrderView(route!.params.id)).toEqual(detail);
  expect(apiClient.request).toHaveBeenLastCalledWith(`/orders/${id}/view`);
  expect(consumeOrderRoute()).toBeNull();
});
it("loads the response for this order without searching a truncated list", async () => {
  const response = { id: "old-response", orderId: id, assignmentStatus: "in_progress" };
  vi.mocked(apiClient.request).mockResolvedValueOnce({ items: [response], limit: 1, offset: 0 });
  expect(await getMyResponse(id)).toEqual(response);
  expect(apiClient.request).toHaveBeenLastCalledWith(expect.stringContaining(`orderId=${id}`));
});
it("isolates full-list and per-order query keys and pagination parameters", () => {
  expect(myKeys.responses()).not.toEqual(myKeys.response(id));
  expect(myKeys.responses({ offset: 0 })).not.toEqual(myKeys.responses({ offset: 50 }));
  expect(myKeys.orders({ limit: 20 })).not.toEqual(myKeys.orders({ limit: 50 }));
});
it("ignores arbitrary paths in notification data", () => {
  expect(orderIdFromNotification({ orderId: "https://evil.example" })).toBeNull();
  expect(orderIdFromNotification({})).toBeNull();
});
