import { expect, it, jest } from "@jest/globals";
import { Text } from "react-native";
import { Stack } from "expo-router";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import TabsLayout from "../app/(tabs)/_layout";

jest.mock("../src/notifications/badges", () => ({ useNotificationBadges: () => ({ opportunities: 2, orders: 1 }) }));

it("выпущенная нижняя навигация открывает Главную, Заказы и Профиль на обеих платформах", async () => {
  const view = renderRouter({
    _layout: () => <Stack />,
    "(tabs)/_layout": TabsLayout,
    "(tabs)/index": () => <Text>Лента заказов</Text>,
    "(tabs)/orders": () => <Text>Раздел заказов</Text>,
    "(tabs)/account": () => <Text>Профиль пользователя</Text>,
    "(tabs)/create": () => <Text>Создание заказа</Text>,
    "(tabs)/profile": () => <Text>Ввод навыков</Text>,
  }, { initialUrl: "/" });
  expect(await screen.findByText("Лента заказов")).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Заказы"));
  expect(await screen.findByText("Раздел заказов")).toBeTruthy();
  await waitFor(() => expect(view.getPathname()).toBe("/orders"));
  fireEvent.press(screen.getByLabelText("Профиль"));
  expect(await screen.findByText("Профиль пользователя")).toBeTruthy();
  await waitFor(() => expect(view.getPathname()).toBe("/account"));
  fireEvent.press(screen.getByLabelText("Главная"));
  expect(await screen.findByText("Лента заказов")).toBeTruthy();
  await waitFor(() => expect(view.getPathname()).toBe("/"));
});
