import { apiClient } from "./client";

/** GET /cities (Фаза 1) — используется экраном выбора города при регистрации. */
export interface City {
  id: string;
  name: string;
  regionName: string;
  federalDistrict: string;
  timezone: string;
  isActive: boolean;
}

export function getCities(): Promise<City[]> {
  return apiClient.request<City[]>("/cities");
}
