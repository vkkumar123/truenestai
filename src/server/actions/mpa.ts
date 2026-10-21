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
 * render phase (and syncs cookies) before rendering. We do this on every action outcome,
 * including failures, for the page that posted the form. Remove once fixed upstream.
 */
export function ensureRenderPhaseAfterAction(path: string, type?: "layout" | "page"): void {
  try {
    if (type) revalidatePath(path, type);
    else revalidatePath(path);
  } catch {
    // revalidatePath outside a request (e.g. unit tests) — nothing to do.
  }
}
