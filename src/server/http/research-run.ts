import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { researchRunSecret } from "../env";
import { log } from "../log";
import { runResearchBatch, type ResearchBatchResult } from "../services/research-jobs";

export const RESEARCH_SECRET_HEADER = "x-research-secret";

/**
 * Constant-time secret comparison. Both sides are SHA-256 hashed first so the comparison takes
 * the same time whatever the lengths (timingSafeEqual needs equal-length inputs).
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * POST /api/internal/research/run (Cloud Scheduler). 404 while RESEARCH_RUN_SECRET is unset or
 * shorter than 32 characters; 401 for a missing or wrong x-research-secret header; 503 when the
 * research source may not run here; else 200 with job ids, statuses and counts only.
 */
export async function handleResearchRun(
  request: Request,
  deps: { run?: () => Promise<ResearchBatchResult>; env?: NodeJS.ProcessEnv } = {},
): Promise<Response> {
  const secret = researchRunSecret(deps.env ?? process.env);
  if (!secret) return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
  const provided = request.headers.get(RESEARCH_SECRET_HEADER) ?? "";
  if (!secretsMatch(provided, secret)) {
    log.warn("research.run_unauthorized");
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const result = await (deps.run ?? (() => runResearchBatch()))();
    if (result.refused) return json({ error: result.refused }, 503);
    return json({ claimed: result.claimed, outcomes: result.outcomes }, 200);
  } catch (e) {
    log.error("research.run_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return json({ error: "internal" }, 500);
  }
}
