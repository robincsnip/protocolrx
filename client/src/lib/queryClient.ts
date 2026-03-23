import { QueryClient, QueryFunction } from "@tanstack/react-query";

export const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

let authToken: string | null = null;
export function setAuthToken(token: string | null) { authToken = token; }

export async function apiRequest(method: string, url: string, data?: unknown): Promise<any> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})) as any; throw new Error(err.error || res.statusText); }
  return res.json();
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: (async ({ queryKey }) => {
        const res = await fetch(`${API_BASE}${queryKey[0]}`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        if (res.status === 401) return null;
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
      }) as QueryFunction,
      refetchInterval: false, refetchOnWindowFocus: false, staleTime: 30000, retry: false,
    },
    mutations: { retry: false },
  },
});
