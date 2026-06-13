import { createFileRoute, redirect } from "@tanstack/react-router";
import { getAuthToken } from "@/lib/auth-check";

export const Route = createFileRoute("/admin")({
  beforeLoad: () => {
    if (typeof window === "undefined") return;
    const token = getAuthToken();
    if (!token) {
      throw redirect({ to: "/login" });
    }
  },
});
