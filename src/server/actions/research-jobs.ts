"use server";
import "server-only";
import { headers } from "next/headers";
import { requestClientKey } from "../client-ip";
import { log } from "../log";
import { requestResearchOnMiss } from "../services/research-jobs";
import { isSearchMiss, searchProperties } from "../services/search";
import type { WebResearchActionState } from "./types";
import { ensureRenderPhaseAfterAction } from "./mpa";

/**
 * Starts on-demand research for a search miss (POST only, so GET renders, prefetches and crawlers
 * never enqueue). Use with `useActionState(startWebResearchAction, { status: "idle" })`.
 * Form fields: q, locality. The server re-runs the search and acts only on a confirmed miss, so a
 * crafted POST cannot spend research on queries that already have results.
 */
export async function startWebResearchAction(_prev: WebResearchActionState, formData: FormData): Promise<WebResearchActionState> {
  const field = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v.trim().slice(0, 100) : "";
  };
  const q = field("q");
  const locality = field("locality");
  try {
    const result = await searchProperties({ text: q || undefined, localityId: locality || undefined });
    if (!isSearchMiss(result, q)) return { status: "none" };
    const state = await requestResearchOnMiss({
      queryText: q,
      localityId: locality || null,
      clientKey: await requestClientKey(),
      userAgent: (await headers()).get("user-agent"),
    });
    if (!state) return { status: "none" };
    if (state.state === "searched_none") return { status: "searched_none", queryText: state.queryText, searchedAt: state.searchedAt };
    return { status: state.state, queryText: state.queryText };
  } catch (e) {
    log.warn("research.action_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return { status: "none" };
  } finally {
    ensureRenderPhaseAfterAction("/projects"); // no-JS form posts re-render the page; see mpa.ts
  }
}
