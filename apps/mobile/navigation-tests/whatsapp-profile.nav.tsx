import { beforeEach, expect, it, jest } from "@jest/globals";
import { Alert, TextInput } from "react-native";
import { Stack } from "expo-router";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Account from "../app/(tabs)/account";
import EditProfile from "../app/edit-profile";

const mockRequest = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("../src/api/client", () => ({ apiClient: { request: (...args: unknown[]) => mockRequest(...args) } }));
jest.mock("../src/api/profile", () => ({
  ...(jest.requireActual("../src/api/profile") as object),
  getProfile: jest.fn(async () => ({ profile: null, capabilities: [], resources: [], unmapped: [], restrictions: [] })),
  getProfileDraft: jest.fn(async () => ({ draft: null, processing: false })),
}));
jest.mock("../src/api/me", () => ({ getMe: jest.fn(async () => ({ id: "u1", name: "Иван", cityId: "city1", about: "Опыт", whatsappPhone: "+79990000000", avatarMediaId: null })) }));
jest.mock("../src/api/cities", () => ({ getCities: jest.fn(async () => []) }));
jest.mock("../src/api/reviews", () => ({ getMyReputation: jest.fn(async () => null) }));
jest.mock("../src/api/media", () => ({ getMediaUrl: () => "" }));
jest.mock("../src/api/auth", () => ({ logout: jest.fn() }));
jest.mock("../src/components/ProfileBasicsModal", () => ({ ProfileBasicsModal: () => null }));
jest.mock("../src/components/AvatarPicker", () => ({ AvatarPicker: () => null }));
jest.mock("../src/components/ReputationBlock", () => ({ ReputationBlock: () => null }));
jest.mock("../src/components/LegalLinks", () => ({ LegalLinks: () => null }));

beforeEach(() => { mockRequest.mockReset(); mockRequest.mockResolvedValue({}); jest.restoreAllMocks(); });
function render(edit = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const layout = () => <QueryClientProvider client={client}><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><Stack /></SafeAreaProvider></QueryClientProvider>;
  renderRouter({ _layout: layout, account: Account, "edit-profile": EditProfile }, { initialUrl: edit ? "/edit-profile" : "/account" });
}
const body = () => JSON.parse((mockRequest.mock.calls.at(-1)?.[1] as { body: string }).body);
const variants = ["+79001234567", "89001234567", "9001234567", "+7 (900) 123-45-67"];

it.each([false, true])("WhatsApp iPhone paste with non-breaking spaces/hyphens reaches PATCH correctly (full form: %s)", async edit => {
  render(edit);
  if (!edit) fireEvent.press(await screen.findByLabelText("Изменить WhatsApp"));
  const input = await screen.findByLabelText("WhatsApp");
  fireEvent.changeText(input, "+7\u00a0950\u00a0123\u201145\u201167");
  if (edit) fireEvent.press(screen.getByText("Сохранить"));
  else fireEvent(input, "submitEditing");
  await waitFor(() => expect(mockRequest).toHaveBeenCalled());
  expect(body()).toMatchObject({ whatsappPhone: "+79501234567" });
});

it.each([...variants, ""])("inline real TextInput -> PATCH /profile: %s", async raw => {
  render();
  fireEvent.press(await screen.findByLabelText("Изменить WhatsApp"));
  const input = screen.getByLabelText("WhatsApp");
  expect(input.props.maxLength).toBeUndefined();
  fireEvent.changeText(input, raw);
  fireEvent(input, "submitEditing");
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith("/profile", expect.objectContaining({ method: "PATCH" })));
  expect(body()).toEqual({ whatsappPhone: raw ? "+79001234567" : null });
});
it.each([...variants, ""])("full form real TextInput -> PATCH /profile: %s", async raw => {
  render(true);
  const input = await screen.findByLabelText("WhatsApp");
  expect(input.props.maxLength).toBeUndefined();
  fireEvent.changeText(input, raw);
  fireEvent.press(screen.getByText("Сохранить"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalled());
  expect(body()).toMatchObject({ name: "Иван", about: "Опыт", whatsappPhone: raw ? "+79001234567" : null });
});
it("invalid WhatsApp does not block other profile changes or discard the phone draft", async () => {
  render(true);
  fireEvent.changeText(await screen.findByLabelText("WhatsApp"), "123");
  fireEvent.changeText(screen.getByPlaceholderText("Имя"), "Пётр");
  fireEvent.press(screen.getByText("Сохранить"));
  await screen.findByText(/Остальные данные сохранены/);
  expect(body()).toMatchObject({ name: "Пётр" });
  expect(body()).not.toHaveProperty("whatsappPhone");
  expect(screen.getByLabelText("WhatsApp").props.value).toBe("123");
});
it("invalid inline phone is not sent and does not block editing about", async () => {
  const alert = jest.spyOn(Alert, "alert");
  render(); fireEvent.press(await screen.findByLabelText("Изменить WhatsApp"));
  fireEvent.changeText(screen.getByLabelText("WhatsApp"), "123");
  fireEvent(screen.getByLabelText("WhatsApp"), "submitEditing");
  expect(mockRequest).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith("Проверьте WhatsApp", expect.stringContaining("+7 900"));
  fireEvent.press(screen.getByLabelText("Изменить «О себе»"));
  fireEvent.changeText(screen.UNSAFE_getByType(TextInput), "Новый текст");
  fireEvent(screen.UNSAFE_getByType(TextInput), "blur");
  await waitFor(() => expect(mockRequest).toHaveBeenCalled());
  expect(body()).toEqual({ about: "Новый текст" });
});
it("server validation JSON is replaced with Russian copy", async () => {
  const alert = jest.spyOn(Alert, "alert");
  mockRequest.mockRejectedValue(new Error('[{"code":"invalid_string","path":["whatsappPhone"]}]'));
  render(); fireEvent.press(await screen.findByLabelText("Изменить WhatsApp"));
  fireEvent.changeText(screen.getByLabelText("WhatsApp"), variants[0]);
  fireEvent(screen.getByLabelText("WhatsApp"), "submitEditing");
  await waitFor(() => expect(alert).toHaveBeenCalledWith("Не удалось сохранить", expect.stringContaining("Укажите WhatsApp")));
});
