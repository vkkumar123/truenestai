import "server-only";

export const DEFAULT_ADMIN_HOME = "/admin/leads";
const BASE = "http://internal.invalid";

/** Only same-origin /admin paths (with their query) are allowed after sign-in: no open redirects. */
export function safeAdminPath(raw: FormDataEntryValue | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 500) return DEFAULT_ADMIN_HOME;
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_ADMIN_HOME;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return DEFAULT_ADMIN_HOME;
  }
  if (url.origin !== BASE) return DEFAULT_ADMIN_HOME;
  const path = url.pathname;
  if (!(path === "/admin" || path.startsWith("/admin/")) || path.includes("//") || path.startsWith("/admin/login")) {
    return DEFAULT_ADMIN_HOME;
  }
  return `${path}${url.search}`;
}
