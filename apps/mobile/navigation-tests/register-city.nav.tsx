import { beforeEach, expect, it, jest } from "@jest/globals";
import { Text } from "react-native";
import { Stack } from "expo-router";
import { renderRouter, screen, fireEvent, waitFor } from "expo-router/testing-library";
import { userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RegisterScreen from "../app/(auth)/register";
import { RUSSIAN_CITIES } from "../../../packages/database/src/data/russian-cities";
import { installFakeServer, sent } from "./fake-server";

jest.mock("../src/api/session", () => ({ saveTokens: jest.fn(async () => {}), invalidateTokenWrites: jest.fn(), clearTokens: jest.fn(async () => {}), getRefreshToken: jest.fn(async () => null), getAccessToken: jest.fn(async () => null) }));
jest.mock("../src/api/legal", () => ({ getLegalDocuments: jest.fn(async () => []), registrationDocumentsReady: jest.fn(() => true) }));
jest.mock("../src/notifications/push", () => ({ ensurePushRegistered: jest.fn(), resetPushRegistrationState: jest.fn(), unregisterPush: jest.fn(async () => {}) }));
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { extra: { apiBaseUrl: "https://api.ustal.test" } } } }));

const cities = RUSSIAN_CITIES.map((city, i) => ({ ...city, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, isActive: true }));
const layout = () => <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } }}><Stack /></SafeAreaProvider>;
let cityAttempts: number;
let failFirstCityRequest: boolean;
beforeEach(() => {
  cityAttempts = 0; failFirstCityRequest = false;
  installFakeServer(req => {
    if (req.path === "/cities") {
      cityAttempts++;
      return failFirstCityRequest && cityAttempts === 1 ? { status: 503 } : { body: cities };
    }
    return req.path === "/auth/register" ? { body: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", userId: "synthetic-user" } } : {};
  });
});
const renderRegistration = () => renderRouter({ _layout: layout, register: RegisterScreen, "(tabs)/index": () => <Text>Registered</Text> }, { initialUrl: "/register" });

it("one city press opens the full list; search/select preserves the form and sends the selected city id", async () => {
  renderRegistration();
  fireEvent.changeText(screen.getByLabelText("Имя"), "Synthetic city tester");
  fireEvent.changeText(screen.getByLabelText("Телефон, 10 цифр после +7"), "9001234567");
  fireEvent.changeText(screen.getByLabelText("Пароль"), "Synthetic-password");
  await userEvent.press(screen.getByLabelText("Выбрать город"));
  expect(await screen.findByText("Выберите город")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("Поиск города"), "Уссурийск");
  await userEvent.press(await screen.findByLabelText("Уссурийск, Приморский край"));
  expect(screen.getByLabelText("Город: Уссурийск")).toBeTruthy();
  expect(screen.getByDisplayValue("Synthetic city tester")).toBeTruthy();
  expect(screen.getByDisplayValue("Synthetic-password")).toBeTruthy();
  screen.getAllByRole("checkbox").forEach(check => fireEvent.press(check));
  fireEvent.press(screen.getByText("Зарегистрироваться"));
  await waitFor(() => expect(sent.filter(req => req.path === "/auth/register")).toHaveLength(1));
  expect(sent.find(req => req.path === "/auth/register")?.body).toMatchObject({ cityId: cities.find(city => city.name === "Уссурийск")!.id });
  await screen.findByText("Registered");
});

it("a failed cities request still opens the picker and can be retried without restarting registration", async () => {
  failFirstCityRequest = true;
  renderRegistration();
  await userEvent.press(screen.getByLabelText("Выбрать город"));
  expect(await screen.findByText("Не удалось загрузить города.")).toBeTruthy();
  await userEvent.press(screen.getByRole("button", { name: "Повторить" }));
  fireEvent.changeText(screen.getByLabelText("Поиск города"), "Уссурийск");
  await userEvent.press(await screen.findByLabelText("Уссурийск, Приморский край"));
  expect(screen.getByLabelText("Город: Уссурийск")).toBeTruthy();
  expect(cityAttempts).toBe(2);
});
