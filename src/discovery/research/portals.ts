// Listing portals whose terms forbid reuse of their listings. Research never stores a record whose
// canonical URL is on one of these hosts (or a subdomain), and the web search tool is told to skip
// them. We do not link out to them either: their registry entries are still "proposed", and a
// link-out row would still copy the portal's title and facts. See docs/DATA_SOURCE_POLICY.md.
export const BLOCKED_PORTAL_DOMAINS = [
  "99acres.com",
  "magicbricks.com",
  "housing.com",
  "nobroker.in",
  "commonfloor.com",
  "squareyards.com",
  "makaan.com",
] as const;

/** True when `url`'s host is a blocked portal or a subdomain of one. Unparseable URLs count as blocked. */
export function isBlockedPortalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return true;
  }
  return BLOCKED_PORTAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}
