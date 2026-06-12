import { createFileRoute, redirect } from "@tanstack/react-router";
import { getAuthToken } from "@/lib/auth-check";

export const Route = createFileRoute("/signup")({
  beforeLoad: () => {
    const token = getAuthToken();
    if (token) {
      throw redirect({ to: "/dashboard" });
    }
  },
  validateSearch: (search: Record<string, unknown>): { code?: string } => {
    return {
      code: search.code ? String(search.code) : undefined,
    };
  },
});
