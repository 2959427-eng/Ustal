import { expect, it } from "vitest";
import type { SemanticFact } from "@ustal/validation";
import { resolveOrderResourceSupply } from "./order-resource-supply.js";

const asset: SemanticFact = {kind:"resource",phrase:"asset",evidence:"source",canonicalKeys:[],confidence:.9,mandatory:true,constraintType:"none",constraintScope:"fact",resourceRole:"required",resourceCapacity:{value:null,unit:null,kind:null},startHour:null,endHour:null,daysOfWeek:null};
it("does not require executor ownership for resources supplied at the task", () => {
  expect(resolveOrderResourceSupply("order", asset, "provided")).toEqual({...asset,mandatory:false});
  expect(asset.mandatory).toBe(true);
});
it.each(["executor", "unspecified"])("preserves mandatory requirements for %s supply", supply => {
  expect(resolveOrderResourceSupply("order",asset,supply).mandatory).toBe(true);
});
it("does not use an order allocation field to alter capabilities or profile resources", () => {
  expect(resolveOrderResourceSupply("profile",asset,null)).toEqual(asset);
  expect(() => resolveOrderResourceSupply("profile",asset,"provided")).toThrow();
  expect(() => resolveOrderResourceSupply("order",{...asset,kind:"capability"},"provided")).toThrow();
});
it.each([null, undefined, "invented"])("rejects malformed allocation %s instead of weakening a requirement", supply => {
  expect(() => resolveOrderResourceSupply("order",asset,supply)).toThrow();
});
