import { createMiddleware } from "@tanstack/react-start";

export const attachAuth = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const token =
    typeof document !== "undefined" ? document.cookie.match(/auth_token=([^;]+)/)?.[1] : "";
  return next({
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
});
