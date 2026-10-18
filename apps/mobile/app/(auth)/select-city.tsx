import { useEffect } from "react";
import { router } from "expo-router";

/**
 * 2026-09-14 fix (typecheck error после добавления acceptedRules/acceptedPdn
 * в RegisterPayload — см. AI_HANDOFF.md): этот экран уже был помечен как
 * неиспользуемый в register.tsx (2026-09-13 fix — выбор города и отправка
 * формы теперь происходят одним экраном в register.tsx, черновик из
 * src/state/registrationDraft.ts больше нигде не заполняется). Раньше здесь
 * оставался реальный вызов register({ ...draft, cityId }) без согласий —
 * он либо не типизировался (после этого фикса), либо, если бы всё же
 * выполнился, ушёл бы на бэкенд без настоящего согласия пользователя на
 * обработку персональных данных, что и есть тот самый баг, который мы
 * закрываем во всём остальном diff'е. Чтобы не тащить это исключение и не
 * подделывать acceptedRules/acceptedPdn, экран сведён к редиректу на
 * актуальную форму регистрации.
 *
 * Файл по-прежнему не удалён физически — нет доступа к git rm (см.
 * AI_HANDOFF.md, раздел про select-city.tsx). Автор исходной пометки уже
 * просил Codex/пользователя удалить его через git.
 */
export default function SelectCityScreen() {
  useEffect(() => {
    router.replace("/(auth)/register");
  }, []);

  return null;
}
