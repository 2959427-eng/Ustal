import { expect, it } from "vitest";
import { normalizeProfileItemIdentity as identity } from "./profile-item-identity.js";

it.each([
  ["самолёт", "самолет"], ["кофемашина.", "кофемашина"], ["Генератор", "генератор"],
  [" \tГЕНЕРАТОР \n", "генератор"], ["редкий\u00a0 прибор", "редкий прибор"],
  ["самоле\u0308т", "самолет"], ["прибор！", "прибор"], ["ＦＯＯ", "foo"],
  ["прибор . ! …", "прибор"],
])("identity %s → %s, with stable repeated normalization", (text, key) => {
  expect(identity(text)).toBe(key); expect(identity(identity(text))).toBe(key);
});
it.each([["машина", "кофемашина"], ["C++", "C"], ["C#", "C"], ["дрель-шуруповерт", "дрель"], ["прибор 2.0", "прибор 20"], ["генератор 5 кВт", "генератор 10 кВт"]])("keeps different names %s and %s distinct", (a, b) => {
  expect(identity(a)).not.toBe(identity(b));
});
