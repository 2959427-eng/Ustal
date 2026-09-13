import { expect, it } from "vitest";
import { filterCities } from "./citySearch";
import { RUSSIAN_CITIES } from "../../../../packages/database/src/data/russian-cities";

const cities = RUSSIAN_CITIES.map((city, i) => ({ ...city, id: String(i), isActive: true }));
it("keeps namesakes in distinct regions", () => {
  const results = filterCities(cities, "Белогорск");
  expect(results).toHaveLength(2);
  expect(new Set(results.map((city) => city.regionName)).size).toBe(2);
  expect(filterCities(cities, "Белогорск Амур")).toHaveLength(1);
});
it("finds cities ignoring case and yo spelling", () => {
  expect(filterCities(cities, "  ЩЕЛК  ").some((city) => city.name === "Щёлково")).toBe(true);
  expect(filterCities(cities, "несуществующийгород")).toEqual([]);
});
it("has no duplicate identities and retains the original three cities", () => {
  expect(new Set(cities.map((city) => `${city.name}|${city.regionName}`)).size).toBe(cities.length);
  for (const name of ["Владивосток", "Уссурийск", "Хабаровск"]) expect(cities.filter((city) => city.name === name)).toHaveLength(1);
  expect(cities.length).toBeGreaterThan(1100);
});
