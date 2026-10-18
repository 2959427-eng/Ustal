/** Ограничение длины имени на экране профиля (как у прежнего поля имени, maxLength=100). */
export const PROFILE_NAME_MAX = 100;

export interface ProfileBasics {
  name: string;
  cityId: string | null;
  avatarMediaId: string | null;
}

/** Поля PATCH /profile, которые меняет окно «Основные данные» (подмножество UpdateProfileInput, контракт не меняется). */
export interface ProfileBasicsPatch {
  name?: string;
  cityId?: string;
  avatarMediaId?: string;
}

export type ProfileBasicsCheck = { ok: true; patch: ProfileBasicsPatch | null } | { ok: false; error: string };

/**
 * Окно «Основные данные» (2026-10-17): аватар, имя и город сохраняются одним PATCH /profile.
 * В запрос попадают только изменённые поля; null — ничего не изменилось (запрос не нужен).
 * avatarMediaId — id уже загруженной НОВОЙ фотографии (загрузка только по «Сохранить»).
 */
export function buildProfileBasicsPatch(current: ProfileBasics, draft: { name: string; cityId: string | null; avatarMediaId?: string | null }): ProfileBasicsCheck {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Введите имя." };
  if (name.length > PROFILE_NAME_MAX) return { ok: false, error: `Имя длиннее ${PROFILE_NAME_MAX} символов.` };
  if (!draft.cityId) return { ok: false, error: "Выберите город." };
  const patch: ProfileBasicsPatch = {};
  if (name !== current.name.trim()) patch.name = name;
  if (draft.cityId !== current.cityId) patch.cityId = draft.cityId;
  if (draft.avatarMediaId && draft.avatarMediaId !== current.avatarMediaId) patch.avatarMediaId = draft.avatarMediaId;
  return { ok: true, patch: Object.keys(patch).length ? patch : null };
}
