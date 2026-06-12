import { createFileRoute, redirect } from "@tanstack/react-router";
import { getAuthToken } from "@/lib/auth-check";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    const token = getAuthToken();
    if (token) {
      throw redirect({ to: "/dashboard" });
    } else {
      throw redirect({ to: "/login" });
    }
  },
  component: () => null,
});

