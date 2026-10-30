import type { City } from "../api/cities";

// Russian uses Unicode's default lowercase mapping; no locale lookup is needed per string.
const normalize = (value: string) => value.toLowerCase().replace(/ё/g, "е").trim();
const collator = new Intl.Collator("ru");
export type CitySearchIndex = readonly { city: City; name: string; text: string }[];

/** Prepare once per city list, not inside every sort comparison or on every keystroke. */
export function prepareCitySearch(cities: readonly City[]): CitySearchIndex {
  return cities.map((city) => ({ city, name: normalize(city.name), text: normalize(`${city.name} ${city.regionName}`) }))
    .sort((a, b) => collator.compare(a.city.name, b.city.name) || collator.compare(a.city.regionName, b.city.regionName));
}

export function filterCityIndex(index: CitySearchIndex, query: string): City[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return index.map(({ city }) => city);
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  const prefix: City[] = [], other: City[] = [];
  for (const entry of index) {
    if (words.every((word) => entry.text.includes(word))) {
      (entry.name.startsWith(normalizedQuery) ? prefix : other).push(entry.city);
    }
  }
  return prefix.concat(other);
}

/** Preserve the existing helper contract for callers that do not retain an index. */
export function filterCities(cities: City[], query: string): City[] {
  return filterCityIndex(prepareCitySearch(cities), query);
}

