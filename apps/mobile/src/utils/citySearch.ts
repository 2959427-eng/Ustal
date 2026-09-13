import type { City } from "../api/cities";

export function filterCities(cities: City[], query: string): City[] {
  const normalize = (value: string) => value.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
  const words = normalize(query).split(/\s+/).filter(Boolean);
  return cities.filter((city) => words.every((word) => normalize(`${city.name} ${city.regionName}`).includes(word)))
    .sort((a, b) => Number(normalize(b.name).startsWith(normalize(query))) - Number(normalize(a.name).startsWith(normalize(query))) || a.name.localeCompare(b.name, "ru") || a.regionName.localeCompare(b.regionName, "ru"));
}

