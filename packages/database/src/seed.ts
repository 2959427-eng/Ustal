import { eq } from "drizzle-orm";
import { getDb, getSql, schema } from "./client.js";

const CITIES = [
  { name: "Владивосток", regionName: "Приморский край", federalDistrict: "Дальневосточный", timezone: "Asia/Vladivostok" },
  { name: "Уссурийск", regionName: "Приморский край", federalDistrict: "Дальневосточный", timezone: "Asia/Vladivostok" },
  { name: "Хабаровск", regionName: "Хабаровский край", federalDistrict: "Дальневосточный", timezone: "Asia/Vladivostok" },
];

/**
 * Онтология — универсальные элементы задачи, НЕ список профессий/категорий
 * (раздел 11 ТЗ, docs/architecture.md). Пользователь никогда не видит эту
 * структуру напрямую — AI сопоставляет с ней свободный текст.
 *
 * Расширено после Фазы 8 (см. docs/architecture.md §5 п.27) с ~25 базовых
 * универсальных категорий до широкого стартового набора, покрывающего
 * основные бытовые сферы (жильё и ремонт, сад, стройка, уход за людьми и
 * животными, цифровые услуги, техника, красота, мероприятия, рукоделие,
 * бизнес-услуги, еда, мелкие поручения). Это ЗАМЕТНО ШИРЕ прежнего набора,
 * но сознательно НЕ претендует на исчерпывающее покрытие «всех сфер жизни»
 * буквально — такого конечного списка не существует, и система не для
 * этого спроектирована: раздел 11 ТЗ прямо запрещает LLM создавать новые
 * активные узлы на лету, а несовпавшие формулировки уходят в
 * `ontology_candidates` на ручное решение администратора (Фаза 8) — именно
 * так онтология и должна расти дальше, из реальных формулировок реальных
 * пользователей, а не быть один раз «дописанной до полноты» заранее.
 *
 * ВАЖНО про существующие 25 узлов (Фаза 1): ни один не переименован, не
 * удалён и не изменён по смыслу/regulated/riskLevel — только добавлены
 * новые узлы (часть — как их дети через parentKey) и синонимы. Это гарантирует
 * обратную совместимость с уже существующими demo-профилями/заказами и любым
 * кодом, ссылающимся на эти canonicalKey напрямую.
 *
 * Регулируемость: намеренно НЕ регулируются бытовые задачи, которые лишь
 * поверхностно касаются электричества/высоты (поменять лампочку, повесить
 * полку, установить кондиционер) — regulated=true оставлен только за тем,
 * что явно перечислено в разделе 24 ТЗ как требующее лицензии/допуска
 * (профессиональная электрика, газ, медицина, работа на высоте, пассажирские
 * перевозки) плюс отдельно — работа с несовершеннолетними (тот же раздел 24).
 */
interface SeedNode {
  canonicalKey: string;
  nameRu: string;
  nodeType: "action" | "object" | "capability" | "resource" | "condition" | "risk";
  parentKey?: string;
  regulated?: boolean;
  riskLevel?: number;
  requiresVerification?: boolean;
  synonyms?: string[];
}

const ONTOLOGY_NODES: SeedNode[] = [
  // --- Фаза 1: исходные 25 узлов, без изменений ---
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
  { canonicalKey: "electrical_work", nameRu: "профессиональная электрика", nodeType: "risk", regulated: true, riskLevel: 3,
    synonyms: ["электромонтаж", "электропроводка", "электрик", "монтаж электрощитка"] },
  { canonicalKey: "gas_work", nameRu: "работа с газовым оборудованием", nodeType: "risk", regulated: true, riskLevel: 4,
    synonyms: ["газовщик", "подключение газовой плиты", "ремонт газового котла"] },
  { canonicalKey: "medicine", nameRu: "медицина", nodeType: "risk", regulated: true, riskLevel: 4 },
  { canonicalKey: "height_work", nameRu: "работа на высоте", nodeType: "risk", regulated: true, riskLevel: 4,
    synonyms: ["промышленный альпинизм", "мытьё окон на высоте", "работы с вышки"] },
  { canonicalKey: "passenger_transport", nameRu: "пассажирские перевозки", nodeType: "risk", regulated: true, riskLevel: 3,
    synonyms: ["частный извоз", "отвезти пассажира"] },

  // --- Дети существующих узлов ---
  { canonicalKey: "moving_full", nameRu: "переезд под ключ", nodeType: "action", parentKey: "physical_labor",
    synonyms: ["услуги грузчиков", "переезд", "помощь с переездом"] },
  { canonicalKey: "furniture_disassembly", nameRu: "разборка мебели", nodeType: "action", parentKey: "physical_labor",
    synonyms: ["разобрать мебель перед переездом"] },
  { canonicalKey: "heavy_lifting", nameRu: "подъём тяжестей", nodeType: "capability", parentKey: "physical_labor" },

  { canonicalKey: "courier_on_foot", nameRu: "пеший курьер", nodeType: "action", parentKey: "delivery",
    synonyms: ["курьер пешком", "доставка документов"] },
  { canonicalKey: "freight_transport", nameRu: "грузоперевозки", nodeType: "capability", parentKey: "driving",
    synonyms: ["перевозка груза на машине", "грузовое такси"] },
  { canonicalKey: "car_towing", nameRu: "эвакуация автомобиля", nodeType: "action", parentKey: "driving",
    synonyms: ["эвакуатор", "отбуксировать машину"] },

  { canonicalKey: "washing_machine_install", nameRu: "подключение стиральной машины", nodeType: "action", parentKey: "installation",
    synonyms: ["подключить стиральную машину", "установка стиралки", "подключение стиралки"] },
  { canonicalKey: "dishwasher_install", nameRu: "подключение посудомоечной машины", nodeType: "action", parentKey: "installation",
    synonyms: ["установить посудомойку"] },
  { canonicalKey: "ac_install", nameRu: "установка кондиционера", nodeType: "action", parentKey: "installation", riskLevel: 1,
    synonyms: ["монтаж кондиционера", "установить сплит-систему"] },
  { canonicalKey: "tv_mounting", nameRu: "установка телевизора на стену", nodeType: "action", parentKey: "installation",
    synonyms: ["повесить телевизор", "монтаж телевизора на кронштейн"] },
  { canonicalKey: "curtain_rod_install", nameRu: "установка карниза", nodeType: "action", parentKey: "installation",
    synonyms: ["повесить карниз", "повесить шторы"] },

  { canonicalKey: "appliance_repair", nameRu: "ремонт бытовой техники", nodeType: "action", parentKey: "repair" },
  { canonicalKey: "washing_machine_repair", nameRu: "ремонт стиральной машины", nodeType: "action", parentKey: "appliance_repair" },
  { canonicalKey: "refrigerator_repair", nameRu: "ремонт холодильника", nodeType: "action", parentKey: "appliance_repair" },
  { canonicalKey: "tv_repair", nameRu: "ремонт телевизора", nodeType: "action", parentKey: "appliance_repair" },
  { canonicalKey: "plumbing_repair", nameRu: "сантехнические работы", nodeType: "action", parentKey: "repair",
    synonyms: ["сантехник", "починить кран", "устранить течь", "прочистить засор"] },
  { canonicalKey: "basic_household_fixes", nameRu: "мелкий бытовой ремонт", nodeType: "action", parentKey: "repair",
    synonyms: ["поменять лампочку", "заменить лампочку", "повесить полку", "прикрутить полку", "починить ручку двери"] },
  { canonicalKey: "digging", nameRu: "земляные работы", nodeType: "action", parentKey: "repair",
    synonyms: ["копать", "могу копать", "выкопать яму", "вскопать землю"] },

  { canonicalKey: "apartment_cleaning", nameRu: "уборка квартиры", nodeType: "action", parentKey: "cleaning" },
  { canonicalKey: "post_renovation_cleaning", nameRu: "уборка после ремонта", nodeType: "action", parentKey: "cleaning" },
  { canonicalKey: "window_cleaning", nameRu: "мытьё окон", nodeType: "action", parentKey: "cleaning" },
  { canonicalKey: "dry_cleaning_pickup", nameRu: "химчистка (забрать/отвезти)", nodeType: "action", parentKey: "cleaning",
    synonyms: ["отвезти в химчистку", "забрать вещи из химчистки"] },
  { canonicalKey: "carpet_cleaning", nameRu: "чистка ковров", nodeType: "action", parentKey: "cleaning" },

  { canonicalKey: "tutoring_school", nameRu: "репетиторство (школьные предметы)", nodeType: "capability", parentKey: "teaching",
    synonyms: ["репетитор", "помощь с уроками", "подготовка к экзаменам"] },
  { canonicalKey: "language_tutoring", nameRu: "преподавание иностранного языка", nodeType: "capability", parentKey: "teaching",
    synonyms: ["уроки английского", "репетитор по английскому"] },
  { canonicalKey: "music_lessons", nameRu: "обучение музыке", nodeType: "capability", parentKey: "teaching",
    synonyms: ["уроки музыки", "обучение игре на гитаре", "обучение игре на пианино"] },
  { canonicalKey: "driving_lessons", nameRu: "обучение вождению", nodeType: "capability", parentKey: "teaching" },

  { canonicalKey: "product_photography", nameRu: "предметная фотосъёмка", nodeType: "capability", parentKey: "photography",
    synonyms: ["сфотографировать товары", "фото для интернет-магазина"] },
  { canonicalKey: "event_photography", nameRu: "фотосъёмка мероприятий", nodeType: "capability", parentKey: "photography" },

  // --- Новые верхнеуровневые сферы ---
  { canonicalKey: "garden_dacha", nameRu: "сад и приусадебный участок", nodeType: "capability" },
  { canonicalKey: "lawn_mowing", nameRu: "покос травы", nodeType: "action", parentKey: "garden_dacha",
    synonyms: ["покосить траву", "постричь газон", "скосить траву"] },
  { canonicalKey: "gardening", nameRu: "садовые работы", nodeType: "action", parentKey: "garden_dacha",
    synonyms: ["посадка растений", "прополка", "уход за садом"] },
  { canonicalKey: "tree_trimming", nameRu: "обрезка и спил деревьев", nodeType: "action", parentKey: "garden_dacha",
    synonyms: ["спилить дерево", "обрезка деревьев"] },
  { canonicalKey: "snow_removal", nameRu: "уборка снега", nodeType: "action", parentKey: "garden_dacha",
    synonyms: ["почистить снег", "убрать снег на участке"] },
  { canonicalKey: "greenhouse_work", nameRu: "работы в теплице", nodeType: "action", parentKey: "garden_dacha" },
  { canonicalKey: "irrigation_setup", nameRu: "установка системы полива", nodeType: "action", parentKey: "garden_dacha" },

  { canonicalKey: "construction", nameRu: "строительство и отделка", nodeType: "capability" },
  { canonicalKey: "painting", nameRu: "малярные работы", nodeType: "action", parentKey: "construction",
    synonyms: ["покраска", "покрасить стены"] },
  { canonicalKey: "tiling", nameRu: "укладка плитки", nodeType: "action", parentKey: "construction",
    synonyms: ["плиточник", "положить плитку"] },
  { canonicalKey: "flooring", nameRu: "укладка напольных покрытий", nodeType: "action", parentKey: "construction",
    synonyms: ["укладка ламината", "укладка линолеума"] },
  { canonicalKey: "plastering", nameRu: "штукатурные работы", nodeType: "action", parentKey: "construction",
    synonyms: ["штукатурка стен"] },
  { canonicalKey: "drywall", nameRu: "монтаж гипсокартона", nodeType: "action", parentKey: "construction",
    synonyms: ["гипсокартон", "гклист"] },
  { canonicalKey: "roofing", nameRu: "кровельные работы", nodeType: "action", parentKey: "construction", riskLevel: 1,
    synonyms: ["ремонт крыши"] },
  { canonicalKey: "welding", nameRu: "сварочные работы", nodeType: "action", parentKey: "construction", riskLevel: 1,
    synonyms: ["сварка", "сварщик"] },
  { canonicalKey: "demolition", nameRu: "демонтажные работы", nodeType: "action", parentKey: "construction",
    synonyms: ["демонтаж", "снести стену"] },
  { canonicalKey: "concrete_work", nameRu: "бетонные работы", nodeType: "action", parentKey: "construction",
    synonyms: ["заливка фундамента", "стяжка пола"] },
  { canonicalKey: "fence_building", nameRu: "строительство заборов", nodeType: "action", parentKey: "construction",
    synonyms: ["поставить забор"] },

  { canonicalKey: "care", nameRu: "уход и забота о людях", nodeType: "capability" },
  { canonicalKey: "childcare", nameRu: "присмотр за детьми", nodeType: "capability", parentKey: "care",
    regulated: true, riskLevel: 3, requiresVerification: true,
    synonyms: ["няня", "посидеть с ребёнком"] },
  { canonicalKey: "eldercare", nameRu: "уход за пожилыми людьми", nodeType: "capability", parentKey: "care", riskLevel: 1,
    synonyms: ["сиделка", "помощь пожилому человеку"] },
  { canonicalKey: "house_sitting", nameRu: "присмотр за квартирой/домом", nodeType: "capability", parentKey: "care" },

  { canonicalKey: "animals", nameRu: "работа с животными", nodeType: "capability" },
  { canonicalKey: "pet_sitting", nameRu: "передержка животных", nodeType: "capability", parentKey: "animals",
    synonyms: ["передержка", "присмотр за животными"] },
  { canonicalKey: "dog_walking", nameRu: "выгул собак", nodeType: "action", parentKey: "animals",
    synonyms: ["выгулять собаку"] },
  { canonicalKey: "dog_training", nameRu: "дрессировка собак", nodeType: "capability", parentKey: "animals" },
  { canonicalKey: "pet_grooming", nameRu: "стрижка животных", nodeType: "capability", parentKey: "animals",
    synonyms: ["грумер", "груминг"] },

  { canonicalKey: "tech_repair", nameRu: "ремонт техники и IT-помощь", nodeType: "capability" },
  { canonicalKey: "computer_repair", nameRu: "ремонт компьютеров", nodeType: "action", parentKey: "tech_repair",
    synonyms: ["переустановить windows", "почистить компьютер от вирусов"] },
  { canonicalKey: "phone_repair", nameRu: "ремонт телефонов", nodeType: "action", parentKey: "tech_repair",
    synonyms: ["заменить экран телефона"] },
  { canonicalKey: "smart_home_setup", nameRu: "настройка умного дома", nodeType: "action", parentKey: "tech_repair",
    synonyms: ["умный дом", "настроить умные розетки"] },
  { canonicalKey: "network_setup", nameRu: "настройка сети и wi-fi", nodeType: "action", parentKey: "tech_repair",
    synonyms: ["настроить wifi", "прокладка интернет-кабеля"] },
  { canonicalKey: "printer_setup", nameRu: "настройка принтера", nodeType: "action", parentKey: "tech_repair" },

  { canonicalKey: "digital_creative", nameRu: "цифровые и творческие услуги", nodeType: "capability" },
  { canonicalKey: "graphic_design", nameRu: "графический дизайн", nodeType: "capability", parentKey: "digital_creative",
    synonyms: ["дизайн", "создание логотипа"] },
  { canonicalKey: "video_editing", nameRu: "видеомонтаж", nodeType: "capability", parentKey: "digital_creative",
    synonyms: ["монтаж видео"] },
  { canonicalKey: "copywriting", nameRu: "написание текстов", nodeType: "capability", parentKey: "digital_creative",
    synonyms: ["копирайтинг", "написать текст для сайта"] },
  { canonicalKey: "translation", nameRu: "письменный перевод", nodeType: "capability", parentKey: "digital_creative",
    synonyms: ["перевод текста", "перевести документ"] },
  { canonicalKey: "social_media_management", nameRu: "ведение социальных сетей", nodeType: "capability", parentKey: "digital_creative",
    synonyms: ["смм", "вести инстаграм"] },
  { canonicalKey: "programming", nameRu: "программирование", nodeType: "capability", parentKey: "digital_creative",
    synonyms: ["разработка сайта", "написать программу"] },
  { canonicalKey: "voiceover", nameRu: "озвучка", nodeType: "capability", parentKey: "digital_creative" },

  { canonicalKey: "beauty_health", nameRu: "красота и немедицинский уход за собой", nodeType: "capability" },
  { canonicalKey: "hairdressing", nameRu: "парикмахерские услуги", nodeType: "capability", parentKey: "beauty_health",
    synonyms: ["стрижка", "покрасить волосы"] },
  { canonicalKey: "manicure", nameRu: "маникюр", nodeType: "capability", parentKey: "beauty_health",
    synonyms: ["маникюр на дому", "педикюр"] },
  { canonicalKey: "massage", nameRu: "массаж", nodeType: "capability", parentKey: "beauty_health", riskLevel: 1 },
  { canonicalKey: "makeup", nameRu: "визаж", nodeType: "capability", parentKey: "beauty_health",
    synonyms: ["макияж"] },
  { canonicalKey: "fitness_training", nameRu: "персональные тренировки", nodeType: "capability", parentKey: "beauty_health",
    synonyms: ["персональный тренер", "фитнес-тренер"] },
  { canonicalKey: "cosmetology", nameRu: "косметология", nodeType: "capability", parentKey: "beauty_health", riskLevel: 2 },

  { canonicalKey: "events", nameRu: "организация мероприятий", nodeType: "capability" },
  { canonicalKey: "hosting_mc", nameRu: "ведение мероприятий", nodeType: "capability", parentKey: "events",
    synonyms: ["тамада", "ведущий на праздник"] },
  { canonicalKey: "catering_help", nameRu: "помощь с кейтерингом", nodeType: "action", parentKey: "events",
    synonyms: ["обслуживание банкета", "официант на мероприятие"] },
  { canonicalKey: "equipment_rental_setup", nameRu: "аренда и установка оборудования для мероприятий", nodeType: "action", parentKey: "events" },
  { canonicalKey: "decoration", nameRu: "оформление мероприятий", nodeType: "action", parentKey: "events",
    synonyms: ["оформление зала", "декор на праздник"] },

  { canonicalKey: "sewing_crafts", nameRu: "рукоделие и пошив", nodeType: "capability" },
  { canonicalKey: "clothing_alteration", nameRu: "ремонт и подгонка одежды", nodeType: "action", parentKey: "sewing_crafts",
    synonyms: ["подшить", "ушить", "услуги ателье"] },
  { canonicalKey: "custom_sewing", nameRu: "пошив на заказ", nodeType: "capability", parentKey: "sewing_crafts" },
  { canonicalKey: "handicraft", nameRu: "изделия ручной работы", nodeType: "capability", parentKey: "sewing_crafts",
    synonyms: ["хендмейд", "рукоделие"] },

  { canonicalKey: "business_services", nameRu: "деловые и офисные услуги", nodeType: "capability" },
  { canonicalKey: "accounting_help", nameRu: "бухгалтерские услуги", nodeType: "capability", parentKey: "business_services" },
  { canonicalKey: "legal_consulting", nameRu: "юридические консультации", nodeType: "capability", parentKey: "business_services", riskLevel: 1 },
  { canonicalKey: "document_prep", nameRu: "оформление документов", nodeType: "action", parentKey: "business_services" },

  { canonicalKey: "food_catering", nameRu: "готовка и выпечка на заказ", nodeType: "capability" },
  { canonicalKey: "home_cooking", nameRu: "приготовление еды на заказ", nodeType: "capability", parentKey: "food_catering",
    synonyms: ["домашняя кухня на заказ"] },
  { canonicalKey: "baking", nameRu: "выпечка на заказ", nodeType: "capability", parentKey: "food_catering",
    synonyms: ["торты на заказ", "испечь торт"] },

  { canonicalKey: "errands", nameRu: "мелкие поручения", nodeType: "capability" },
  { canonicalKey: "grocery_shopping", nameRu: "покупка продуктов", nodeType: "action", parentKey: "errands",
    synonyms: ["закупка продуктов", "сходить в магазин"] },
  { canonicalKey: "queue_standing", nameRu: "ожидание в очереди", nodeType: "action", parentKey: "errands",
    synonyms: ["постоять в очереди"] },
  { canonicalKey: "document_delivery", nameRu: "доставка документов", nodeType: "action", parentKey: "errands",
    synonyms: ["отвезти документы"] },
  { canonicalKey: "general_errand", nameRu: "разовое поручение", nodeType: "action", parentKey: "errands",
    synonyms: ["мелкое поручение", "выполнить поручение"] },
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
        requiresVerification: n.requiresVerification ?? n.regulated ?? false,
      })),
    )
    .returning();
  // eslint-disable-next-line no-console
  console.log(`Seeded ${insertedNodes.length} ontology nodes.`);

  const idByKey = new Map(insertedNodes.map((n) => [n.canonicalKey, n.id]));

  // Второй проход: проставляем parent_id теперь, когда все id известны —
  // ontology_nodes.parent_id ссылается на саму же таблицу, единой вставкой
  // с parentId это сделать нельзя (родитель ещё не имеет id на момент values()).
  let parentLinksSet = 0;
  for (const n of ONTOLOGY_NODES) {
    if (!n.parentKey) continue;
    const childId = idByKey.get(n.canonicalKey);
    const parentId = idByKey.get(n.parentKey);
    if (!childId || !parentId) {
      throw new Error(`Seed ontology: parentKey "${n.parentKey}" узла "${n.canonicalKey}" не найден среди вставленных узлов.`);
    }
    await db.update(schema.ontologyNodes).set({ parentId }).where(eq(schema.ontologyNodes.id, childId));
    parentLinksSet += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`Linked ${parentLinksSet} parent relationships.`);

  const synonymRows = ONTOLOGY_NODES.flatMap((n) => {
    const nodeId = idByKey.get(n.canonicalKey);
    if (!nodeId || !n.synonyms?.length) return [];
    return n.synonyms.map((phraseRu) => ({ ontologyNodeId: nodeId, phraseRu }));
  });
  if (synonymRows.length > 0) {
    const insertedSynonyms = await db.insert(schema.ontologySynonyms).values(synonymRows).returning();
    // eslint-disable-next-line no-console
    console.log(`Seeded ${insertedSynonyms.length} ontology synonyms.`);
  }

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
