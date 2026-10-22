import "server-only";
import { revalidatePath } from "next/cache";

/**
 * Workaround for a Next 16.4.2 dev-mode bug with no-JS (MPA) form posts to Server Actions.
 *
 * Root cause (node_modules/next/dist/server/app-render/action-handler.js,
 * executeActionAndPrepareForRender): when an MPA action does NOT revalidate anything,
 * `skipPageRendering` becomes true, so the `finally` block never switches
 * `requestStore.phase` from "action" to "render". Next still renders the HTML page for the MPA
 * response, now with phase "action", so `cookies()` hands back `userspaceMutableCookies`; in dev,
 * `makeUntrackedCookiesWithDevWarnings` only accepts `cookies`/`mutableCookies` and throws
 * InvariantError("Received an underlying cookies object that does not match ...").
 *
 * Calling revalidatePath() in the action marks the path as revalidated, so Next switches to the
 * render phase (and syncs cookies) before rendering. Callers invoke it AFTER their auth check
 * (only for requests that passed it), on success and failure. No-op in production.
 * Remove once fixed upstream (D14).
 */
export function ensureRenderPhaseAfterAction(path: string, type?: "layout" | "page"): void {
  // Dev-only bug: production builds take a different branch in cookies() and do not throw.
  if (process.env.NODE_ENV === "production") return;
  try {
    if (type) revalidatePath(path, type);
    else revalidatePath(path);
  } catch {
    // revalidatePath outside a request (e.g. unit tests) — nothing to do.
  }
}
