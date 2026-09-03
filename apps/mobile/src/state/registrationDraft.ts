/**
 * Черновик регистрации между экранами "Регистрация" (имя/телефон/пароль) и
 * "Выбор города" (Фаза 1 развела это на два роута expo-router, но
 * POST /auth/register — один вызов с cityId, поэтому поля первого экрана
 * нужно на секунду пронести до второго). Осознанно НЕ через query-параметры
 * роута (пароль не должен попадать в историю навигации/deep link) и НЕ
 * через SecureStore (это черновик несохранённой формы, а не токен) —
 * простое module-level хранилище в памяти, живущее только на время самого
 * флоу регистрации и обнуляемое сразу после использования.
 */
interface RegistrationDraft {
  name: string;
  phone: string;
  password: string;
}

let draft: RegistrationDraft | null = null;

export function setRegistrationDraft(value: RegistrationDraft): void {
  draft = value;
}

export function getRegistrationDraft(): RegistrationDraft | null {
  return draft;
}

export function clearRegistrationDraft(): void {
  draft = null;
}
