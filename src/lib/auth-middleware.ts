import { createMiddleware } from "@tanstack/react-start";
import { getSessionUser } from "@/lib/auth";

export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const getRequest = (await import("@tanstack/react-start/server")).getRequest;
  const request = await getRequest();

  if (!request?.headers) {
    throw new Error("Unauthorized: No request available");
  }

  const cookie = request.headers.get("cookie") || "";
  const tokenFromCookie = extractCookieValue(cookie, "auth_token");

  const authHeader = request.headers.get("authorization") || "";
  const tokenFromHeader = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const token = tokenFromCookie || tokenFromHeader;

  if (!token) {
    throw new Error("Unauthorized: No authentication token provided");
  }

  const user = getSessionUser(token);
  if (!user) {
    throw new Error("Unauthorized: Invalid or expired token");
  }

  return next({
    context: {
      user,
      userId: user.id,
    },
  });
});

function extractCookieValue(cookieString: string, name: string): string {
  if (!cookieString) return "";
  const match = cookieString.match(new RegExp(`(?:^|; )${name}=(.*?)(?:;|$)`));
  return match ? decodeURIComponent(match[1]) : "";
}
