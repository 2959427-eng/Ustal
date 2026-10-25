import { createHash } from "node:crypto";

/**
 * Серверная авторизация админки (аудит безопасности 2026-10-23, H3). Чистые функции без БД/Next — тестируются
 * напрямую (admin-access.test.ts). Источник истины — текущая строка admin_users, а не данные внутри cookie:
 *  - администратор удалён → строки нет → сессия недействительна сразу;
 *  - роль изменена/отключена (role не из ADMIN_ROLES, например "disabled") → сессия недействительна или прав меньше сразу;
 *  - пароль сменён → отпечаток хеша пароля в токене не совпадает → все прежние сессии недействительны.
 */
export const ADMIN_ROLES = ["superadmin", "moderator"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export type AdminPermission = "moderation.resolve" | "reports.resolve" | "users.set_status" | "ontology.manage";

/** moderator — разбор очереди модерации и жалоб; блокировка пользователей и онтология — только superadmin. */
const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  superadmin: ["moderation.resolve", "reports.resolve", "users.set_status", "ontology.manage"],
  moderator: ["moderation.resolve", "reports.resolve"],
};

export const isAdminRole = (role: unknown): role is AdminRole =>
  typeof role === "string" && (ADMIN_ROLES as readonly string[]).includes(role);

export function hasPermission(role: unknown, permission: AdminPermission): boolean {
  return isAdminRole(role) && ROLE_PERMISSIONS[role].includes(permission);
}

/** Отпечаток текущего хеша пароля (не сам хеш): смена пароля отзывает все выданные ранее сессии. */
export function passwordFingerprint(passwordHash: string): string {
  return createHash("sha256").update(`ustal-admin-session:${passwordHash}`).digest("hex").slice(0, 32);
}

export interface AdminTokenClaims { sub?: unknown; pwv?: unknown }
export interface AdminRow { id: string; email: string; role: string; passwordHash: string }
export interface AdminPrincipal { sub: string; email: string; role: AdminRole }

/** Решение по уже проверенным (подпись/срок) claims и строке admin_users, загруженной по claims.sub. */
export function authorizeAdmin(claims: AdminTokenClaims | null, row: AdminRow | null | undefined): AdminPrincipal | null {
  if (!claims || !row || typeof claims.sub !== "string" || claims.sub !== row.id) return null;
  if (!isAdminRole(row.role)) return null;
  // Токены, выданные до этого исправления, не содержат pwv — недействительны (одноразовый повторный вход).
  if (typeof claims.pwv !== "string" || claims.pwv !== passwordFingerprint(row.passwordHash)) return null;
  return { sub: row.id, email: row.email, role: row.role };
}

/** Значения, которые server action принимает от клиента: аргументы action может подменить любой, кто вызывает его напрямую. */
export const USER_STATUS_VALUES = ["active", "blocked"] as const;
export const MODERATION_DECISIONS = ["allow", "allow_with_warning", "reject"] as const;
export const REPORT_STATUS_VALUES = ["resolved", "dismissed"] as const;
export function assertOneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error("Недопустимое значение");
  return value as T;
}
