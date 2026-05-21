import { createContext, useContext, useEffect, useState } from "react";
import { signinFn, signupFn, signoutFn, signupWithInviteFn } from "@/lib/auth.functions";

export interface AuthUser {
  id: string;
  email: string;
  fullName: string | null;
  role: "admin" | "user";
}

function decodeTokenSafe(token: string): AuthUser | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && Date.now() > payload.exp * 1000) return null;
    return {
      id: payload.sub,
      email: payload.email || "",
      fullName: payload.full_name || null,
      role: (payload.role || "user") as "admin" | "user",
    };
  } catch {
    return null;
  }
}

interface AuthContextType {
  user: AuthUser | null;
  isAdmin: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ error?: string }>;
  signup: (email: string, password: string, fullName: string) => Promise<{ error?: string }>;
  signupWithInvite: (
    code: string,
    email: string,
    password: string,
    fullName: string,
  ) => Promise<{ error?: string }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isAdmin: false,
  loading: true,
  login: async () => ({}),
  signup: async () => ({}),
  signupWithInvite: async () => ({}),
  logout: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getCookie("auth_token");
    if (token) {
      const decoded = decodeTokenSafe(token);
      setUser(decoded);
    }
    setLoading(false);
  }, []);

  const doLogin = async (email: string, password: string) => {
    try {
      const result = await signinFn({ data: { email, password } });
      setCookie("auth_token", result.token, 7);
      setUser(result.user);
      return {};
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: message || "Login failed" };
    }
  };

  const doSignup = async (email: string, password: string, fullName: string) => {
    try {
      const result = await signupFn({ data: { email, password, fullName } });
      setCookie("auth_token", result.token, 7);
      setUser(result.user);
      return {};
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: message || "Signup failed" };
    }
  };

  const doSignupWithInvite = async (
    code: string,
    email: string,
    password: string,
    fullName: string,
  ) => {
    try {
      const result = await signupWithInviteFn({ data: { code, email, password, fullName } });
      setCookie("auth_token", result.token, 7);
      setUser(result.user);
      return {};
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: message || "Signup failed" };
    }
  };

  const doLogout = async () => {
    try {
      await signoutFn();
    } catch {
      // ignore
    }
    removeCookie("auth_token");
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAdmin: user?.role === "admin",
        loading,
        login: doLogin,
        signup: doSignup,
        signupWithInvite: doSignupWithInvite,
        logout: doLogout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=(.*?)(?:;|$)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, days: number) {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

function removeCookie(name: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
}
