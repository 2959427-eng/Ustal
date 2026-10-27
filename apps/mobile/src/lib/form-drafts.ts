import { useCallback, useEffect, useState } from "react";
import type { PickedPhoto } from "../components/PhotoPicker";
import { secureRandomId } from "./secure-id";

/**
 * Несохранённый ввод ИИ-форм (профиль, новый заказ) переживает переход к окну согласия OpenAI и обратно:
 * router.replace после решения пересоздаёт экраны вкладок, и локальный useState терялся (2026-10-27).
 * Только память процесса: не в URL, не в SecureStore/AsyncStorage, не в логах; ничего не отправляет.
 *
 * Привязка к сессии (2026-10-27): каждая запись несёт ключ сессии, выданный экрану при монтировании.
 * Любая смена сессии (isolateSession: вход, регистрация, выход, удаление аккаунта, истёкшая сессия) создаёт новый
 * ключ — после этого чтение и запись со старым ключом невозможны. Ключ — новый объект (сравнение по ссылке) с
 * криптостойким id для параметров навигации; id не повторяется между запусками приложения и входами. Поздние обработчики старого экрана
 * (async-загрузка фото, отложенные setState, размонтированные экраны) ничего не записывают и не восстанавливают.
 */
export interface OrderFormDraft { text: string; priceText: string; acceptsPriceOffers: boolean; photos: PickedPhoto[] }
export interface FormDrafts { profile: string; order: OrderFormDraft }
type Key = keyof FormDrafts;

export type DraftSession = Readonly<{ id: string | null }>;
const newSession = (): DraftSession => Object.freeze({ id: secureRandomId() });
let session: DraftSession = newSession();
const drafts = new Map<Key, { session: DraftSession; value: unknown }>();
const sessionListeners = new Set<() => void>();

/** Ключ текущей сессии черновиков — право записи экрана, полученное при монтировании. */
export const formDraftSession = (): DraftSession => session;

export function readFormDraft<K extends Key>(key: K, owner: DraftSession = session): FormDrafts[K] | undefined {
  const entry = drafts.get(key);
  return entry && owner === session && entry.session === session ? entry.value as FormDrafts[K] : undefined;
}
/** false — право записи устарело (сессия сменилась), ничего не записано. */
export function writeFormDraft<K extends Key>(key: K, value: FormDrafts[K], owner: DraftSession): boolean {
  if (owner !== session) return false;
  drafts.set(key, { session, value });
  return true;
}
export function clearFormDraft(key: Key, owner: DraftSession): boolean {
  if (owner !== session) return false;
  drafts.delete(key);
  return true;
}
/** Смена сессии: все черновики и все выданные права записи аннулируются. */
export function clearFormDrafts(): void {
  session = newSession();
  drafts.clear();
  for (const listener of [...sessionListeners]) listener();
}

/**
 * Сброс прочего локального состояния экрана при смене сессии (то, что не хранится в черновике: поле композера,
 * id созданного заказа, шаг формы). Вызывается синхронно в clearFormDrafts — до входа следующего пользователя.
 */
export function useOnSessionChange(reset: () => void): void {
  useEffect(() => {
    sessionListeners.add(reset);
    return () => { sessionListeners.delete(reset); };
  }, [reset]);
}

/**
 * Принадлежит ли значение, переданное через параметры навигации (например prefillText), текущей сессии.
 * Параметр без id сессии, из прежней сессии или из прежнего запуска приложения не восстанавливается;
 * без криптостойкого id (старая сборка без expo-crypto) параметры не принимаются вовсе.
 */
export const isCurrentDraftSession = (id: string | undefined): boolean => !!id && session.id !== null && id === session.id;

/**
 * useState с черновиком. update/clear/discard привязаны к сессии экрана: после смены сессии старые замыкания
 * не меняют ни черновик, ни поле на экране, а сам экран (если ещё смонтирован) сбрасывается на пустую форму.
 */
export function useFormDraft<K extends Key>(key: K, initial: () => FormDrafts[K]) {
  const [owner, setOwner] = useState(formDraftSession);
  const [value, setValue] = useState<FormDrafts[K]>(() => readFormDraft(key, owner) ?? initial());
  useEffect(() => {
    const reset = () => { setOwner(formDraftSession()); setValue(initial()); };
    sessionListeners.add(reset);
    if (owner !== formDraftSession()) reset(); // сессия сменилась между рендером и эффектом
    return () => { sessionListeners.delete(reset); };
    // initial — значения пустой формы; повторная подписка нужна только при смене сессии
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  const update = useCallback((next: FormDrafts[K]): boolean => {
    if (!writeFormDraft(key, next, owner)) return false;
    setValue(next);
    return true;
  }, [key, owner]);
  const clear = useCallback((empty: FormDrafts[K]): boolean => {
    if (!clearFormDraft(key, owner)) return false;
    setValue(empty);
    return true;
  }, [key, owner]);
  /** Черновик отправлен — удалить из памяти, поле на экране не трогать. */
  const discard = useCallback(() => { clearFormDraft(key, owner); }, [key, owner]);
  /**
   * Принадлежит ли форма (и данные в замыкании, из которого вызвана) текущей сессии. Обработчик отправки,
   * созданный в сессии A, после смены сессии получает false и не отправляет данные A от имени B.
   */
  const owns = useCallback(() => owner === formDraftSession(), [owner]);
  return [value, update, clear, discard, owns] as const;
}
