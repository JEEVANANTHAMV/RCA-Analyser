import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): { code?: string } => {
    return {
      code: search.code ? String(search.code) : undefined,
    };
  },
});
