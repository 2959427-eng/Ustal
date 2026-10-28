import { beforeEach, expect, it, jest } from "@jest/globals";
import { Text } from "react-native";
import { Stack } from "expo-router";
import { renderRouter, screen, fireEvent, waitFor } from "expo-router/testing-library";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RegisterScreen from "../app/(auth)/register";
import { installFakeServer, sent } from "./fake-server";

// Real RegisterScreen -> auth.register -> ApiClient -> fetch. Only native storage and public metadata are mocked.
jest.mock("../src/api/session", () => ({ saveTokens: jest.fn(async () => {}), invalidateTokenWrites: jest.fn(), clearTokens: jest.fn(async () => {}), getRefreshToken: jest.fn(async () => null), getAccessToken: jest.fn(async () => null) }));
jest.mock("../src/api/cities", () => ({ getCities: jest.fn(async () => [{ id: "11111111-1111-4111-8111-111111111111", name: "Владивосток" }]) }));
jest.mock("../src/api/legal", () => ({ getLegalDocuments: jest.fn(async () => []), registrationDocumentsReady: jest.fn(() => true) }));
jest.mock("../src/notifications/push", () => ({ ensurePushRegistered: jest.fn(), resetPushRegistrationState: jest.fn(), unregisterPush: jest.fn(async () => {}) }));
const layout = () => <SafeAreaProvider initialMetrics={{ frame:{x:0,y:0,width:320,height:568},insets:{top:20,left:0,right:0,bottom:0} }}><Stack /></SafeAreaProvider>;
beforeEach(() => installFakeServer(req => req.path === "/auth/register" ? {body:{accessToken:"synthetic-access",refreshToken:"synthetic-refresh",userId:"synthetic-user"}} : {}));
const pastes = ["+7 (900) 123-45-67", "+79001234567", "89001234567", "9001234567", "900 123-45-67", "8 (900) 123-45-67", "  +7  (900)  123 - 45 - 67  "];
it.each(pastes)("real input and outgoing registration normalize pasted %s", async pasted => {
 renderRouter({_layout:layout,register:RegisterScreen,"(tabs)/index":()=> <Text>Registered</Text>}, {initialUrl:"/register"});
 fireEvent.changeText(screen.getByLabelText("Имя"),"Synthetic reviewer");
 const input = screen.getByLabelText("Телефон, 10 цифр после +7");
 // RN's native TextInput applies maxLength before the JS callback. fireEvent alone would bypass the bug.
 const delivered = typeof input.props.maxLength === "number" ? pasted.slice(0,input.props.maxLength) : pasted;
 fireEvent.changeText(input,delivered);
 expect(screen.getByLabelText("Телефон, 10 цифр после +7").props.value).toBe("900 123-45-67");
 fireEvent.changeText(screen.getByLabelText("Пароль"),"Synthetic-password");
 fireEvent.press(screen.getByLabelText("Выбрать город"));
 fireEvent.press(await screen.findByText("Владивосток"));
 screen.getAllByRole("checkbox").forEach(c=>fireEvent.press(c));
 fireEvent.press(screen.getByText("Зарегистрироваться"));
 await waitFor(()=>expect(sent.filter(r=>r.path==="/auth/register")).toHaveLength(1));
 expect(sent.find(r=>r.path==="/auth/register")).toMatchObject({method:"POST",body:{phone:"+79001234567",acceptedAge18:true,acceptedRules:true,acceptedPdn:true}});
 await screen.findByText("Registered");
});
it("real input keeps only ten normalized digits even without a raw length limit", () => {
 renderRouter({_layout:layout,register:RegisterScreen}, {initialUrl:"/register"});
 fireEvent.changeText(screen.getByLabelText("Телефон, 10 цифр после +7"),"900123456789999999999");
 const value=screen.getByLabelText("Телефон, 10 цифр после +7").props.value;
 expect(value).toBe("900 123-45-67");
 expect(value.replace(/\D/g,"")).toHaveLength(10);
});
