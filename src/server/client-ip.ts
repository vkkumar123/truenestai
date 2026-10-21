import "server-only";

/**
 * Client IP from an X-Forwarded-For header WITHOUT trusting client-supplied entries.
 * Each proxy APPENDS the address it received the request from, so only the right-most
 * `trustedHops` entries were written by infrastructure we trust; anything to the left may be
 * spoofed by the client. We take the entry `trustedHops` positions from the right:
 *   trustedHops = 1 → last entry (address seen by the immediate trusted proxy)
 *   trustedHops = 2 → second-from-last (e.g. Cloud Run behind a Google external LB)
 * If there are fewer entries than trustedHops, the left-most entry is used (best available).
 * Returns null only when the header is absent or empty.
 */
export function clientIpFromForwardedFor(header: string | null | undefined, trustedHops: number): string | null {
  if (!header) return null;
  const hops = Number.isInteger(trustedHops) && trustedHops >= 1 ? trustedHops : 1;
  const entries = header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const chosen = entries[Math.max(0, entries.length - hops)];
  return chosen.slice(0, 100).toLowerCase();
}

/** Shared bucket used when no X-Forwarded-For header is present. */
export const UNKNOWN_CLIENT_KEY = "unknown";
