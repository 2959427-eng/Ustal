import React from "react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ alert: vi.fn(), block: vi.fn(), invalidate: vi.fn(), setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("react", async (load) => ({ ...await load<object>(), useRef: (current: unknown) => ({current}), useState: (value: unknown) => { const setter = vi.fn(); state.setters.push(setter); return [value, setter]; } }));
vi.mock("react-native", () => ({ Alert: {alert: state.alert}, Pressable: "Pressable", View: "View", Text: "Text", StyleSheet: {create: (v: unknown) => v} }));
vi.mock("@tanstack/react-query", () => ({useQueryClient: () => ({invalidateQueries: state.invalidate})}));
vi.mock("../api/blocks", () => ({blockUser: state.block}));
vi.mock("./ReportModal", () => ({ReportModal: () => null}));
import { ReportAndBlockRow } from "./ReportAndBlockRow";
Object.assign(globalThis, {React});
beforeEach(() => { vi.clearAllMocks(); state.setters.length = 0; });
function render() {
  const tree = ReportAndBlockRow({userId: "customer"});
  const children = tree.props.children;
  return { report: children[0].props.onPress, block: children[1].props.onPress };
}
it("opens report and confirms before blocking; cancel permits a later attempt", () => {
  const ui = render(); ui.report(); expect(state.setters[0]).toHaveBeenCalledWith(true);
  ui.block(); ui.block(); expect(state.alert).toHaveBeenCalledTimes(1); expect(state.block).not.toHaveBeenCalled();
  state.alert.mock.calls[0]![2][0].onPress(); ui.block(); expect(state.alert).toHaveBeenCalledTimes(2);
});
it("blocks only once under double confirmation and invalidates affected order data", async () => {
  let resolve!: () => void; state.block.mockImplementation(() => new Promise<void>(r => {resolve = r;}));
  const ui = render(); ui.block(); const confirm = state.alert.mock.calls[0]![2][1].onPress;
  const pending = confirm(); await confirm(); ui.block(); expect(state.block).toHaveBeenCalledTimes(1);
  expect(state.block).toHaveBeenCalledWith("customer"); resolve(); await pending;
  expect(state.setters[2]).toHaveBeenCalledWith(true);
  expect(state.invalidate).toHaveBeenCalledWith({queryKey: ["order-view"]});
});
it("shows failure and permits retry", async () => {
  state.block.mockRejectedValue(new Error("offline")); const ui = render(); ui.block();
  await state.alert.mock.calls[0]![2][1].onPress(); expect(state.setters[3]).toHaveBeenCalledWith(expect.stringContaining("offline"));
  ui.block(); expect(state.alert).toHaveBeenCalledTimes(2);
});
