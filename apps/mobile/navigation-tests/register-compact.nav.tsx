import { beforeEach, expect, it, jest } from "@jest/globals";
import { TextInput } from "react-native";
import { Stack } from "expo-router";
import { renderRouter, screen, fireEvent, waitFor } from "expo-router/testing-library";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RegisterScreen from "../app/(auth)/register";
import { register } from "../src/api/auth";

jest.mock("../src/api/auth", () => ({ register: jest.fn(async () => {}), login: jest.fn() }));
jest.mock("../src/api/cities", () => ({ getCities: jest.fn(async () => [{ id: "11111111-1111-4111-8111-111111111111", name: "Владивосток" }]) }));
jest.mock("../src/api/legal", () => ({ getLegalDocuments: jest.fn(async () => []), registrationDocumentsReady: jest.fn(() => true) }));
jest.mock("../src/notifications/push", () => ({ ensurePushRegistered: jest.fn() }));
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { extra: { apiBaseUrl: "https://api.ustal.test" } } } }));
const layout = () => <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } }}><Stack /></SafeAreaProvider>;
const registerMock = register as unknown as jest.Mock;
beforeEach(() => { registerMock.mockClear(); });

async function fillForm() {
  renderRouter({ _layout: layout, index: RegisterScreen });
  fireEvent.changeText(screen.getByLabelText("Имя"), "  Иван ");
  fireEvent.changeText(screen.getByLabelText("Телефон, 10 цифр после +7"), "+7 (900) 123-45-67");
  fireEvent.changeText(screen.getByLabelText("Пароль"), "Synthetic-password");
  fireEvent.press(screen.getByLabelText("Выбрать город"));
  fireEvent.press(await screen.findByText("Владивосток"));
}

it("without both active consents the button stays disabled and nothing is sent", async () => {
  await fillForm();
  const button = screen.getByText("Зарегистрироваться");
  fireEvent.press(button);
  fireEvent.press(screen.getAllByRole("checkbox")[0]!); // только соглашение + 18+
  fireEvent.press(button);
  expect(registerMock).not.toHaveBeenCalled();
});

it("sends the unchanged server contract: +7 phone, trimmed name, explicit 18+/rules/PDn", async () => {
  await fillForm();
  screen.getAllByRole("checkbox").forEach((c) => fireEvent.press(c));
  fireEvent.press(screen.getByText("Зарегистрироваться"));
  await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
  expect(registerMock.mock.calls[0]![0]).toEqual({ name: "Иван", phone: "+79001234567", password: "Synthetic-password",
    cityId: "11111111-1111-4111-8111-111111111111", acceptedAge18: true, acceptedRules: true, acceptedPdn: true });
});

it("short password and incomplete phone are rejected locally with a clear message", async () => {
  await fillForm();
  screen.getAllByRole("checkbox").forEach((c) => fireEvent.press(c));
  fireEvent.changeText(screen.getByLabelText("Пароль"), "short");
  fireEvent.press(screen.getByText("Зарегистрироваться"));
  expect(await screen.findByText("Пароль должен быть не короче 8 символов")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("Телефон, 10 цифр после +7"), "900");
  fireEvent.press(screen.getByText("Зарегистрироваться"));
  expect(await screen.findByText("Введите 10 цифр номера после +7")).toBeTruthy();
  expect(registerMock).not.toHaveBeenCalled();
});

it("password can be shown and hidden; there is a single password field", async () => {
  await fillForm();
  const secure = () => screen.UNSAFE_getAllByType(TextInput).filter((n) => n.props.accessibilityLabel === "Пароль")[0]!.props.secureTextEntry;
  expect(secure()).toBe(true);
  fireEvent.press(screen.getByLabelText("Показать пароль"));
  expect(secure()).toBe(false);
  fireEvent.press(screen.getByLabelText("Скрыть пароль"));
  expect(secure()).toBe(true);
});

it("shows the compact unverified-phone note and the link to login", async () => {
  await fillForm();
  expect(screen.getByText(/не подтверждается по SMS/)).toBeTruthy();
  expect(screen.getByText(/Уже есть аккаунт\?/)).toBeTruthy();
});
