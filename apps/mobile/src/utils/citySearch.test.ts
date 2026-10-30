import { expect, it, vi } from "vitest";
import { filterCities, filterCityIndex, prepareCitySearch } from "./citySearch";
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

it("retains the exact existing ordering and matching rules for the full city list", () => {
  const normalize = (value: string) => value.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
  const previous = (query: string) => {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return cities.filter(city => words.every(word => normalize(`${city.name} ${city.regionName}`).includes(word)))
      .sort((a, b) => Number(normalize(b.name).startsWith(normalize(query))) - Number(normalize(a.name).startsWith(normalize(query))) || a.name.localeCompare(b.name, "ru") || a.regionName.localeCompare(b.regionName, "ru"));
  };
  const originalIds = cities.map(city => city.id);
  const index = prepareCitySearch(cities);
  for (const query of ["", "Москва", "Уссурийск", "Белогорск", "Белогорск Амур", "  ЩЕЛК  ", "Санкт", "Нижний нов", "несуществующийгород"]) {
    expect(filterCityIndex(index, query)).toEqual(previous(query));
  }
  expect(cities.map(city => city.id)).toEqual(originalIds);
});

it("typing reuses the prepared index without sorting the full list again", () => {
  const index = prepareCitySearch(cities);
  const sort = vi.spyOn(Array.prototype, "sort");
  let calls: number;
  try {
    for (const query of ["У", "Ус", "Усс", "Уссу", "Уссур", "Уссури", "Уссурийск", ""]) filterCityIndex(index, query);
    calls = sort.mock.calls.length;
  } finally { sort.mockRestore(); }
  expect(calls).toBe(0);
});
