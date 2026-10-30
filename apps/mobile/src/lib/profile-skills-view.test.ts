import { describe, expect, it } from "vitest";
import { profileSkillsView } from "./profile-skills-view";

const none = { capabilities: [], resources: [] };
describe("profileSkillsView", () => {
  it("загрузка и ошибка не выдаются за пустой профиль", () => {
    expect(profileSkillsView({ isLoading: true, isError: false, hasData: false, labels: none })).toBe("loading");
    expect(profileSkillsView({ isLoading: false, isError: true, hasData: false, labels: none })).toBe("error");
    expect(profileSkillsView({ isLoading: false, isError: false, hasData: false, labels: none })).toBe("loading");
  });
  it("пусто — только после успешной загрузки без навыков и ресурсов", () => {
    expect(profileSkillsView({ isLoading: false, isError: false, hasData: true, labels: none })).toBe("empty");
  });
  it("один навык или один ресурс — уже заполненный профиль", () => {
    expect(profileSkillsView({ isLoading: false, isError: false, hasData: true, labels: { capabilities: ["Сантехника"], resources: [] } })).toBe("filled");
    expect(profileSkillsView({ isLoading: false, isError: false, hasData: true, labels: { capabilities: [], resources: ["Есть машина"] } })).toBe("filled");
  });
  it("ошибка повторного запроса при уже загруженных данных не скрывает профиль", () => {
    expect(profileSkillsView({ isLoading: false, isError: true, hasData: true, labels: { capabilities: ["Уборка"], resources: [] } })).toBe("filled");
  });
});
