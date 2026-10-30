import { expect, it } from "vitest";
import { isQuantityOnlyProfileText as quantityOnly, profileItemDisplayText as display, withoutQuantityOnlyProfileItems as clean } from "./profile-quantity-only.js";

// «33 года» в «Что я умею» (2026-10-30): возраст/стаж/длительность без деятельности — не пункт профиля.
it.each([
  "33 года", "33", "Мне 33 года", "мне 33", "Возраст 33 года", "33 г.", "тридцать три года", "Мне тридцать три",
  "стаж 10 лет", "Стаж: 10 лет", "опыт более 5 лет", "Опыт работы 10 лет", "10 лет", "10 лет в профессии",
  "полгода", "пол года", "полтора года опыта", "1,5 года", "пару лет", "несколько лет", "с 2010 года", "уже 3 месяца",
  "Мне 33 года от роду", "33 года отроду", "в возрасте 33 лет", "мне исполнится 34", "10-летний стаж", "10-летний опыт",
  "стаж 10-летний", "33-летний", "пятилетний стаж", "полуторагодовалый опыт", "6-месячный опыт", "опыт 2-х лет",
])("%s is age/duration only", (text) => expect(quantityOnly(text)).toBe(true));

it.each([
  "33 года за рулём", "опыт вождения 10 лет", "работаю сварщиком 10 лет", "работаю сварщиком 33 года", "Сварщик",
  "10 лет в строительстве", "2 года в строительстве", "ремонт квартир 15 лет", "работа с детьми от 3 лет",
  "присмотр за детьми 6-12 лет", "Газель 3 тонны", "бригада 5 человек", "лестница 5 метров", "1С 8.3", "C++ 5 лет",
  "вайбкодер", "СТО", "мою пол", "пол", "Пенсионер", "Перевозка мебели", "опыт", "стаж", "", "   ",
  "10-летний опыт сварки", "сварщик с 10-летним стажем", "многолетний опыт", "летний лагерь", "вожатый в летнем лагере",
  "работа с детьми от 3-х лет", "уход за пожилыми от 60 лет", "33 года от роду, сварщик",
])("%s is kept", (text) => expect(quantityOnly(text)).toBe(false));

it("display falls back to the phrase when only the label is a duration; nothing to show for pure age", () => {
  expect(display("33 года", "работаю сварщиком 33 года")).toBe("работаю сварщиком 33 года");
  expect(display("Сварщик", "работаю сварщиком 33 года")).toBe("Сварщик");
  expect(display(null, "33 года")).toBeNull();
  expect(display("33 года", "Мне 33 года")).toBeNull();
  expect(display(null, "33 года за рулём")).toBe("33 года за рулём");
});

const fact = (kind: string, phrase: string, label: string | null = null, constraintType = "none") => ({ kind, phrase, label, constraintType });

it("drops only positive age/duration items, repairs a duration-only label, keeps restrictions and real skills", () => {
  const facts = [
    fact("capability", "33 года", "33 года"),
    fact("capability", "мне 33"),
    fact("resource", "полгода"),
    fact("capability", "работаю сварщиком 33 года", "33 года"),
    fact("capability", "33 года за рулём", "Вождение"),
    fact("capability", "опыт вождения 10 лет", "Вождение"),
    fact("capability", "сварщик", "Сварщик"),
    fact("availability", "10 лет", null, "availability"),
    fact("exclude", "33 года", null, "exclusion"),
    fact("capability", "доставка", null, "lift"),
    fact("capability", "10 лет", "Сварщик"),
    fact("capability", "10-летний стаж", "10-летний стаж"),
    fact("capability", "Мне 33 года от роду", null),
  ];
  expect(clean(facts)).toEqual([
    fact("capability", "работаю сварщиком 33 года", null),
    fact("capability", "33 года за рулём", "Вождение"),
    fact("capability", "опыт вождения 10 лет", "Вождение"),
    fact("capability", "сварщик", "Сварщик"),
    fact("availability", "10 лет", null, "availability"),
    fact("exclude", "33 года", null, "exclusion"),
    fact("capability", "доставка", null, "lift"),
    fact("capability", "10 лет", "Сварщик"),
  ]);
});

it("returns facts unchanged when there is nothing to filter (recall)", () => {
  const facts = [fact("capability", "вайбкодер"), fact("resource", "газель 1,5 т", "Газель"), fact("capability", "работа с детьми от 3 лет")];
  expect(clean(facts)).toEqual(facts);
});

it("keeps a skill when either phrase or label names a real activity (Codex 2026-10-30)", () => {
  expect(clean([fact("capability", "10 лет", "Сварщик")])).toEqual([fact("capability", "10 лет", "Сварщик")]);
  expect(clean([fact("resource", "3 года", "Газель")])).toEqual([fact("resource", "3 года", "Газель")]);
  expect(clean([fact("capability", "работаю сварщиком 10 лет", "10 лет")])).toEqual([fact("capability", "работаю сварщиком 10 лет", null)]);
  expect(clean([fact("capability", "10-летний стаж", "Стаж 10 лет"), fact("capability", "Мне 33 года от роду", "33 года")])).toEqual([]);
  expect(display("Сварщик", "10 лет")).toBe("Сварщик");
  expect(display("10-летний стаж", "Мне 33 года от роду")).toBeNull();
});
