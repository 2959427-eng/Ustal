import { sql } from "drizzle-orm";
import { getDb, schema } from "./client.js";
import { RUSSIAN_CITIES } from "./data/russian-cities.js";

/** Add cities without changing existing IDs, profiles, orders or active flags. */
export async function seedCities() {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(74190321)`);
    const existing = await tx.select({ name: schema.cities.name, regionName: schema.cities.regionName }).from(schema.cities);
    const key = (city: { name: string; regionName: string }) => `${city.name}\u0000${city.regionName}`;
    const keys = new Set(existing.map(key));
    const missing = RUSSIAN_CITIES.filter((city) => {
      if (keys.has(key(city))) return false;
      keys.add(key(city));
      return true;
    });
    for (let offset = 0; offset < missing.length; offset += 200) {
      await tx.insert(schema.cities).values(missing.slice(offset, offset + 200));
    }
    return missing.length;
  });
}
