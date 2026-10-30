/**
 * «Мой профиль» после регистрации (2026-10-29): пустой профиль — одна главная кнопка на существующий экран ввода;
 * загрузка и ошибка не выдаются за пустой профиль; заполненный профиль — привычное редактирование.
 */
import { beforeEach, expect, it, jest } from "@jest/globals";
import { Text, Platform } from "react-native";
import { Stack } from "expo-router";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import AccountScreen from "../app/(tabs)/account";

const mockProfile = jest.fn<() => Promise<unknown>>();
jest.mock("../src/api/profile", () => ({
  ...(jest.requireActual("../src/api/profile") as object),
  getProfile: () => mockProfile(),
  getProfileDraft: jest.fn(async () => ({ draft: null, processing: false })),
  applyProfileDraft: jest.fn(), updateProfile: jest.fn(),
}));
jest.mock("../src/api/me", () => ({ getMe: jest.fn(async () => ({ id: "u1", name: "Иван", cityId: null, avatarMediaId: null })) }));
jest.mock("../src/api/reviews", () => ({ getMyReputation: jest.fn(async () => null) }));
jest.mock("../src/api/cities", () => ({ getCities: jest.fn(async () => []) }));
jest.mock("../src/api/media", () => ({ getMediaUrl: () => "" }));
jest.mock("../src/api/auth", () => ({ logout: jest.fn() }));
jest.mock("../src/components/ProfileBasicsModal", () => ({ ProfileBasicsModal: () => null }));
jest.mock("../src/components/ReputationBlock", () => ({ ReputationBlock: () => null }));
jest.mock("../src/components/LegalLinks", () => ({ LegalLinks: () => null }));
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { extra: { apiBaseUrl: "https://api.ustal.test" } } } }));

const empty = { profile: null, capabilities: [], resources: [], unmapped: [], restrictions: [], rebuilding: false };
const CTA = "Рассказать о своих возможностях";
function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const layout = () => (
    <QueryClientProvider client={client}>
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><Stack /></SafeAreaProvider>
    </QueryClientProvider>
  );
  renderRouter({ _layout: layout, "(tabs)/account": AccountScreen, "(tabs)/profile": () => <Text>Экран ввода навыков</Text> }, { initialUrl: "/account" });
}
beforeEach(() => { mockProfile.mockReset(); });

it("пустой профиль: заголовок, описание, главная кнопка и подпись; кнопка открывает существующий экран ввода", async () => {
  mockProfile.mockResolvedValue(empty);
  render();
  expect(await screen.findByText("Начните зарабатывать на своих умениях")).toBeTruthy();
  expect(screen.getByText("Расскажите, что умеете делать и какие ресурсы у вас есть. ИИ подберёт подходящие заказы")).toBeTruthy();
  expect(screen.getByText("Голосом или текстом — в свободной форме")).toBeTruthy();
  expect(screen.queryByText("Изменить навыки и ресурсы")).toBeNull();
  fireEvent.press(screen.getByText(CTA));
  expect(await screen.findByText("Экран ввода навыков")).toBeTruthy();
});

it("пока профиль загружается — нет призыва «начните», есть индикатор загрузки", async () => {
  mockProfile.mockImplementation(() => new Promise(() => {}));
  render();
  expect(await screen.findByText("Загружаем профиль…")).toBeTruthy();
  expect(screen.queryByText(CTA)).toBeNull();
});

it("ошибка загрузки — не пустой профиль: сообщение и повтор", async () => {
  mockProfile.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(empty);
  render();
  expect(await screen.findByText(/Не удалось загрузить навыки и ресурсы/)).toBeTruthy();
  expect(screen.queryByText(CTA)).toBeNull();
  fireEvent.press(screen.getByText("Повторить"));
  expect(await screen.findByText(CTA)).toBeTruthy();
});

it("заполненный профиль: привычные навыки и «Изменить навыки и ресурсы», без первого экрана", async () => {
  mockProfile.mockResolvedValue({ ...empty, resources: [], capabilities: [{ label: "Сантехник" }] });
  render();
  await waitFor(() => expect(screen.queryByText("Загружаем профиль…")).toBeNull());
  const filled = await screen.findByText("Изменить навыки и ресурсы");
  expect(screen.getByText("Сантехник")).toBeTruthy();
  expect(screen.queryByText(CTA)).toBeNull();
  fireEvent.press(filled);
  expect(await screen.findByText("Экран ввода навыков")).toBeTruthy();
});

it("ссылка управления согласием сохранена для iOS9 и отсутствует как в Android7", async () => {
  mockProfile.mockResolvedValue(empty);
  render();
  await screen.findByText(CTA);
  if (Platform.OS === "android") expect(screen.queryByText("Управление согласием ИИ")).toBeNull();
  else expect(screen.getByText("Управление согласием ИИ")).toBeTruthy();
});
