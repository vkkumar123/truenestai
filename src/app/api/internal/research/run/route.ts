// Internal research worker trigger (Cloud Scheduler). Auth, limits and behaviour:
// src/server/http/research-run.ts and docs/RESEARCH_WORKER.md. POST only (other methods: 405).
import { handleResearchRun } from "@/server/http/research-run";

export async function POST(request: Request) {
  return handleResearchRun(request);
}
