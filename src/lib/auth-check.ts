export function getAuthToken(): string {
  if (typeof window !== "undefined") {
    const match = document.cookie.match(/(?:^|; )auth_token=(.*?)(?:;|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
  return "";
}
