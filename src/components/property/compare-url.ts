/** Builds a URL with the compare selection kept in the `compare` query param. Server- and client-safe. */
export function withCompare(pathname: string, query: Record<string, string | undefined>, ids: string[]): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) sp.set(k, v);
  if (ids.length) sp.set("compare", ids.join(","));
  const s = sp.toString();
  return s ? `${pathname}?${s}` : pathname;
}
