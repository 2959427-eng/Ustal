import { beforeEach, expect, it, jest } from "@jest/globals";
import { TextInput } from "react-native";
import { Stack } from "expo-router";
import { renderRouter, screen, fireEvent, waitFor } from "expo-router/testing-library";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RegisterScreen from "../app/(auth)/register";
import LoginScreen from "../app/(auth)/login";

jest.mock("../src/api/auth", () => ({ register: jest.fn(), login: jest.fn() }));
jest.mock("../src/api/cities", () => ({ getCities: jest.fn(async () => []) }));
jest.mock("../src/api/legal", () => ({ getLegalDocuments: jest.fn(async () => []), registrationDocumentsReady: jest.fn(() => false) }));
jest.mock("../src/notifications/push", () => ({ ensurePushRegistered: jest.fn() }));
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { extra: { apiBaseUrl: "https://api.ustal.test" } } } }));
const layout = () => <SafeAreaProvider initialMetrics={{ frame: {x:0,y:0,width:390,height:844}, insets:{top:0,left:0,right:0,bottom:0} }}><Stack /></SafeAreaProvider>;
beforeEach(() => {
 globalThis.fetch = jest.fn(async () => ({ok:true,text:async()=>'<main><h1>Current server document</h1><p>Current terms</p><footer><p>Version new</p></footer></main>'} as Response)) as typeof fetch;
});
it("registration inputs and consent checkboxes survive the legal modal", async () => {
 renderRouter({_layout:layout,index:RegisterScreen});
 fireEvent.changeText(screen.getByPlaceholderText("Как к вам обращаться"),"Synthetic user");
 fireEvent.changeText(screen.getByPlaceholderText("+7XXXXXXXXXX"),"+70000000001");
 const passwords=screen.UNSAFE_getAllByType(TextInput).filter(n=>n.props.secureTextEntry);
 passwords.forEach(p=>fireEvent.changeText(p,"Synthetic-password"));
 const checks=screen.getAllByRole("checkbox");checks.forEach(c=>fireEvent.press(c));
 await waitFor(()=>expect(screen.getByText("Открыть пользовательское соглашение")).toBeTruthy());
 fireEvent.press(screen.getByText("Открыть пользовательское соглашение"));
 await screen.findByText("Current server document");
 fireEvent.press(screen.getByLabelText("Закрыть документ"));
 expect(screen.getByDisplayValue("Synthetic user")).toBeTruthy();
 expect(screen.getByDisplayValue("+70000000001")).toBeTruthy();
 expect(screen.getAllByDisplayValue("Synthetic-password")).toHaveLength(2);
 screen.getAllByRole("checkbox").forEach(c=>expect(c.props.accessibilityState.checked).toBe(true));
});
it("login phone and password survive opening and closing the document", async () => {
 renderRouter({_layout:layout,index:LoginScreen});
 fireEvent.changeText(screen.getByPlaceholderText("+7XXXXXXXXXX"),"+70000000002");
 fireEvent.changeText(screen.getByPlaceholderText("Пароль"),"Synthetic-password");
 fireEvent.press(screen.getByText("Конфиденциальность"));
 await screen.findByText("Current server document");
 fireEvent.press(screen.getByText("Закрыть"));
 expect(screen.getByDisplayValue("+70000000002")).toBeTruthy();
 expect(screen.getByDisplayValue("Synthetic-password")).toBeTruthy();
});
