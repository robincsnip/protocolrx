import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { API_BASE, setAuthToken, queryClient } from "@/lib/queryClient";

export interface AuthUser { id: number; email: string; name: string; }
interface AuthContextValue { user: AuthUser | null; token: string | null; isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithAxon: (axonUrl: string, email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void; }

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const u = localStorage.getItem("prx_user") || sessionStorage.getItem("prx_user");
      return u ? JSON.parse(u) : null;
    } catch { return null; }
  });
  const [token, setToken] = useState<string | null>(() => {
    try {
      // Set token synchronously so the first query fired by TanStack Query
      // already has the Authorization header — avoids needing re-login after refresh
      const t = localStorage.getItem("prx_token") || sessionStorage.getItem("prx_token") || null;
      if (t) setAuthToken(t);
      return t;
    } catch { return null; }
  });
  const [isLoading, setIsLoading] = useState(false);

  // Keep authToken in sync whenever token state changes (login/logout)
  useEffect(() => { setAuthToken(token); }, [token]);

  const persist = (t: string, u: AuthUser) => {
    setAuthToken(t); setToken(t); setUser(u);
    try {
      localStorage.setItem("prx_token", t); localStorage.setItem("prx_user", JSON.stringify(u));
      sessionStorage.setItem("prx_token", t); sessionStorage.setItem("prx_user", JSON.stringify(u));
    } catch {}
    queryClient.invalidateQueries();
  };

  const loginWithAxon = useCallback(async (axonUrl: string, email: string, password: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/axon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ axonUrl, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login with AXON failed.");
      persist(data.token, data.user);
    } finally { setIsLoading(false); }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed.");
      persist(data.token, data.user);
    } finally { setIsLoading(false); }
  }, []);

  const register = useCallback(async (email: string, password: string, name: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, name }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed.");
      persist(data.token, data.user);
    } finally { setIsLoading(false); }
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null); setToken(null); setUser(null);
    try {
      localStorage.removeItem("prx_token"); localStorage.removeItem("prx_user");
      sessionStorage.removeItem("prx_token"); sessionStorage.removeItem("prx_user");
    } catch {}
    queryClient.clear();
  }, []);

  return <AuthContext.Provider value={{ user, token, isLoading, login, loginWithAxon, register, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
