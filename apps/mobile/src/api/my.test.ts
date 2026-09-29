import { expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { getMyResponses, getMyOrders } from "./my";
vi.mock("./client", () => ({ apiClient: { request: vi.fn() } }));

it.each([getMyResponses, getMyOrders])("loads older active records beyond the server 50-row cap", async (load) => {
  const rows = Array.from({ length: 121 }, (_, i) => ({ id: `r${i}`, orderId: `o${i}`, archived: i < 120 }));
  vi.mocked(apiClient.request).mockImplementation(async (url) => {
    const offset = Number(new URL(url, "https://api.example.com").searchParams.get("offset") ?? 0);
    return { items: rows.slice(offset, offset + 50), limit: 50, offset } as never;
  });
  const result = await load({ limit: 100 });
  expect(result.items).toHaveLength(121);
  expect(result.items[120]?.id).toBe("r120");
});
