import { getDb, getSql, schema } from "./client.js";

const CITIES = [
  { name: "Владивосток", regionName: "Приморский край", federalDistrict: "Дальневосточный", timezone: "Asia/Vladivostok" },
  { name: "Уссурийск", regionName: "Приморский край", federalDistrict: "Дальневосточный", timezone: "Asia/Vladivostok" },
  { name: "Хабаровск", regionName: "Хабаровский край", federalDistrict: "Дальневосточный", timezone: "Asia/Vladivostok" },
];

// Стартовая онтология — универсальные элементы, НЕ список профессий.
// См. docs/architecture.md и мастер-ТЗ раздел 11.
const ONTOLOGY_NODES: Array<{
  canonicalKey: string;
  nameRu: string;
  nodeType: "action" | "object" | "capability" | "resource" | "condition" | "risk";
  regulated?: boolean;
  riskLevel?: number;
}> = [
  { canonicalKey: "physical_labor", nameRu: "физическая работа", nodeType: "capability" },
  { canonicalKey: "manual_carrying", nameRu: "перенос вещей", nodeType: "action" },
  { canonicalKey: "loading", nameRu: "погрузка", nodeType: "action" },
  { canonicalKey: "unloading", nameRu: "разгрузка", nodeType: "action" },
  { canonicalKey: "delivery", nameRu: "доставка", nodeType: "action" },
  { canonicalKey: "driving", nameRu: "вождение", nodeType: "capability" },
  { canonicalKey: "assembly", nameRu: "сборка", nodeType: "action" },
  { canonicalKey: "installation", nameRu: "установка", nodeType: "action" },
  { canonicalKey: "diagnostics", nameRu: "диагностика", nodeType: "action" },
  { canonicalKey: "repair", nameRu: "ремонт", nodeType: "action" },
  { canonicalKey: "cleaning", nameRu: "уборка", nodeType: "action" },
  { canonicalKey: "outdoor_work", nameRu: "работа на улице", nodeType: "condition" },
  { canonicalKey: "machinery_work", nameRu: "работа с техникой", nodeType: "capability" },
  { canonicalKey: "photography", nameRu: "фотографирование", nodeType: "capability" },
  { canonicalKey: "info_processing", nameRu: "обработка информации", nodeType: "capability" },
  { canonicalKey: "content_creation", nameRu: "создание контента", nodeType: "capability" },
  { canonicalKey: "advertising", nameRu: "реклама", nodeType: "capability" },
  { canonicalKey: "teaching", nameRu: "обучение", nodeType: "capability" },
  { canonicalKey: "language_skill", nameRu: "знание языка", nodeType: "capability" },
  { canonicalKey: "tool_use", nameRu: "использование инструмента", nodeType: "resource" },
  { canonicalKey: "vehicle_use", nameRu: "использование транспорта", nodeType: "resource" },
  { canonicalKey: "electrical_work", nameRu: "работа с электричеством", nodeType: "risk", regulated: true, riskLevel: 3 },
  { canonicalKey: "gas_work", nameRu: "работа с газом", nodeType: "risk", regulated: true, riskLevel: 4 },
  { canonicalKey: "medicine", nameRu: "медицина", nodeType: "risk", regulated: true, riskLevel: 4 },
  { canonicalKey: "height_work", nameRu: "работа на высоте", nodeType: "risk", regulated: true, riskLevel: 4 },
  { canonicalKey: "passenger_transport", nameRu: "пассажирские перевозки", nodeType: "risk", regulated: true, riskLevel: 3 },
];

async function main() {
  const db = getDb();

  const insertedCities = await db.insert(schema.cities).values(CITIES).returning();
  // eslint-disable-next-line no-console
  console.log(`Seeded ${insertedCities.length} cities.`);

  const insertedNodes = await db
    .insert(schema.ontologyNodes)
    .values(
      ONTOLOGY_NODES.map((n) => ({
        canonicalKey: n.canonicalKey,
        nameRu: n.nameRu,
        nodeType: n.nodeType,
        regulated: n.regulated ?? false,
        riskLevel: n.riskLevel ?? 0,
        requiresVerification: n.regulated ?? false,
      })),
    )
    .returning();
  // eslint-disable-next-line no-console
  console.log(`Seeded ${insertedNodes.length} ontology nodes.`);

  // Демо-пользователи и заказы (12-15 профилей, раздел 32 ТЗ) добавляются
  // в Фазе 2/3 вместе с реальным extraction pipeline — здесь только
  // справочники, необходимые для запуска Foundation.

  await getSql().end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Seed failed:", err);
  process.exit(1);
});
