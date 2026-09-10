import { apiClient } from "./client";

export interface Me {
  id: string;
  phone: string;
  phoneVerified: boolean;
  name: string;
  cityId: string;
  whatsappPhone: string | null;
}

/** GET /me — данные аккаунта для экрана настроек (раздел 27 ТЗ). */
export function getMe(): Promise<Me> {
  return apiClient.request<Me>("/me");
}
