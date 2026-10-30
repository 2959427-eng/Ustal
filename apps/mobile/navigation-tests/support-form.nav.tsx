import { beforeEach, expect, it, jest } from "@jest/globals";
import { Stack } from "expo-router";
import { renderRouter, screen, fireEvent, waitFor } from "expo-router/testing-library";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiRequestError } from "@ustal/api-client";
import SupportScreen from "../app/support";
import { sendSupportMessage } from "../src/api/support";

jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { version: "1.0.0", extra: { apiBaseUrl: "https://api.ustal.test" } } } }));
jest.mock("../src/api/support", () => ({ ...jest.requireActual<typeof import("../src/api/support")>("../src/api/support"), sendSupportMessage: jest.fn() }));
const send = sendSupportMessage as unknown as jest.Mock<(text: string) => Promise<{ sent: true }>>;
const layout = () => <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><Stack /></SafeAreaProvider>;
beforeEach(() => {
  send.mockReset();
  globalThis.fetch = jest.fn(async () => ({ ok: true, text: async () => "<main><h1>Current server document</h1><p>Body</p></main>" } as Response)) as typeof fetch;
});

it("support: sends the problem text and confirms; button disabled for too short text", async () => {
  send.mockResolvedValue({ sent: true });
  renderRouter({ _layout: layout, index: SupportScreen });
  fireEvent.changeText(screen.getByLabelText("Опишите проблему"), "Нет");
  fireEvent.press(screen.getByText("Отправить"));
  expect(send).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText("Опишите проблему"), "Не открывается заказ");
  fireEvent.press(screen.getByText("Отправить"));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Не открывается заказ"));
  expect(await screen.findByText(/Обращение отправлено/)).toBeTruthy();
});

it("support: on failure shows a clear message and keeps the typed text", async () => {
  send.mockRejectedValue(new ApiRequestError("unavailable", 503));
  renderRouter({ _layout: layout, index: SupportScreen });
  fireEvent.changeText(screen.getByLabelText("Опишите проблему"), "Не приходят уведомления");
  fireEvent.press(screen.getByText("Отправить"));
  expect(await screen.findByText("Отправка обращений временно недоступна. Попробуйте позже.")).toBeTruthy();
  expect(screen.getByDisplayValue("Не приходят уведомления")).toBeTruthy();
});

it("support screen gives logged-in users the privacy policy and terms in-app", async () => {
  renderRouter({ _layout: layout, index: SupportScreen });
  fireEvent.press(screen.getByText("Конфиденциальность"));
  expect(await screen.findByText("Current server document")).toBeTruthy();
  expect(screen.getByText("Пользовательское соглашение")).toBeTruthy();
});
