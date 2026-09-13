import { getSql } from "./client.js";
import { seedCities } from "./seed-cities.js";

try {
  console.log(`Added ${await seedCities()} cities.`);
} finally {
  await getSql().end();
}
