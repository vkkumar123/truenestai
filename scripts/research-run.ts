// Runs one research worker batch from the command line (same core as POST /api/internal/research/run).
// Run: tsx --env-file-if-exists=.env.local --conditions=react-server scripts/research-run.ts
// Fixture mode (default) uses the in-memory queue of THIS process and the fake client, so it only
// processes jobs it can see; real runs need DATA_BACKEND=supabase. Prints ids, statuses and counts only.
import { runResearchBatch } from "../src/server/services/research-jobs";

async function main() {
  const result = await runResearchBatch();
  console.log(JSON.stringify(result));
  if (result.refused) process.exit(2);
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e instanceof Error ? e.name : "unknown" }));
  process.exit(1);
});
