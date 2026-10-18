import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

export async function clearUserQueries(): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.clear();
}
