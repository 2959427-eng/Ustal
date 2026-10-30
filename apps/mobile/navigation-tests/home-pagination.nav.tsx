import React from "react";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, fireEvent, screen, waitFor, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Home from "../app/(tabs)/index";
import { getFeed } from "../src/api/feed";

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../src/notifications/badges", () => ({ useNotificationBadges: () => ({ opportunities: 0, orders: 0 }) }));
jest.mock("../src/components/ContactButtons", () => ({ ContactButtons: () => null }));
jest.mock("../src/components/CreateOrderComposer", () => ({ CreateOrderComposer: () => null }));
jest.mock("../src/api/feed", () => ({ getFeed: jest.fn() }));
jest.mock("../src/api/me", () => ({ getMe: async () => ({ name: "Тест", cityId: "city" }) }));
jest.mock("../src/api/cities", () => ({ getCities: async () => [{ id: "city", name: "Москва" }] }));
jest.mock("../src/api/my", () => ({ getMyResponses: async () => ({ items: [] }) }));
jest.mock("../src/api/responses", () => ({ createResponse: jest.fn() }));
jest.mock("../src/api/media", () => ({ getMediaUrl: () => "" }));

const feed = jest.mocked(getFeed);
const item = { orderId: "one", title: "Первый заказ", cityId: "city", priceMinor: 10000 };
const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><Home /></QueryClientProvider>);
  return client;
};
beforeEach(() => { feed.mockReset(); });

describe("главная: скрытые карточки и ошибки пагинации", () => {
  it("после скрытия всей страницы следующая страница остаётся доступна", async () => {
    feed.mockResolvedValueOnce({ items: [item], limit: 1, offset: 0 } as never);
    feed.mockResolvedValue({ items: [{ ...item, orderId: "two", title: "Следующий заказ" }], limit: 20, offset: 1 } as never);
    mount();
    await screen.findByText("Первый заказ");
    fireEvent.press(screen.getByText("Скрыть"));
    fireEvent.press(await screen.findByText("Показать ещё заказы"));
    await screen.findByText("Следующий заказ");
    expect(feed).toHaveBeenLastCalledWith({ limit: 20, offset: 1 });
  });
  it("ошибка обновления видна даже при сохранённых карточках; повтор восстанавливает ленту", async () => {
    feed.mockResolvedValueOnce({ items: [item], limit: 20, offset: 0 } as never);
    feed.mockRejectedValueOnce(new Error("offline"));
    feed.mockResolvedValue({ items: [item], limit: 20, offset: 0 } as never);
    mount();
    await screen.findByText("Первый заказ");
    await act(async () => { fireEvent.press(screen.getByText("Обновить")); });
    await screen.findByText("Не удалось обновить ленту.");
    expect(screen.getByText("Первый заказ")).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText("Повторить загрузку")); });
    await waitFor(() => expect(screen.queryByText("Не удалось обновить ленту.")).toBeNull());
  });
});
