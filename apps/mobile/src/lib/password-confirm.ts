/** Ошибка поля «Повторите пароль»; null — всё в порядке. */
export function passwordConfirmError(password: string, confirm: string): string | null {
  if (confirm.length === 0) return "Повторите пароль";
  if (password !== confirm) return "Пароли не совпадают";
  return null;
}
