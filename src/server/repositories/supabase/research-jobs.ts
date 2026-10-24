import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExternalListing } from "@/domain/types";
import type {
  EnqueueResearchInput,
  EnqueueResearchResult,
  FinishResearchInput,
  ResearchJob,
  ResearchJobKind,
  ResearchJobRepository,
  ResearchJobStatus,
  ResearchJobWithListings,
} from "../types";
import { mapExternalListingRow, type ExternalListingRow } from "./mappers";

interface ResearchJobRow {
  id: string;
  kind?: ResearchJobKind;
  query_text: string;
  query_key: string;
  locality_id: string | null;
  status: ResearchJobStatus;
  attempts: number;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_count: number;
  error_code: string | null;
}

function mapJob(r: ResearchJobRow): ResearchJob {
  return {
    id: r.id,
    kind: r.kind ?? "search_miss",
    queryText: r.query_text,
    queryKey: r.query_key,
    localityId: r.locality_id,
    status: r.status,
    attempts: r.attempts,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    resultCount: r.result_count,
    errorCode: r.error_code,
  };
}

type LinkRows = { external_listings: ExternalListingRow | ExternalListingRow[] | null }[] | null | undefined;

/** research_job_listings → external_listings is many-to-one (an object), but tolerate an array. */
function linkedListings(links: LinkRows): ExternalListing[] {
  return (links ?? []).flatMap((l) => {
    const x = l.external_listings;
    return (Array.isArray(x) ? x : x ? [x] : []).map(mapExternalListingRow);
  });
}

const JOB_COLUMNS = "id, kind, query_text, query_key, locality_id, status, attempts, requested_at, started_at, finished_at, result_count, error_code";

/** Service-role only (research_jobs has no client grants). Never pass rows to client components unfiltered. */
export class SupabaseResearchJobRepository implements ResearchJobRepository {
  constructor(private readonly db: () => SupabaseClient) {}

  async enqueue(input: EnqueueResearchInput): Promise<EnqueueResearchResult> {
    const { data, error } = await this.db().rpc("research_enqueue", {
      p_query_text: input.queryText,
      p_query_key: input.queryKey,
      p_locality_id: input.localityId,
      p_ip_hash: input.requesterIpHash,
      p_cache_hours: input.cacheHours,
      p_max_per_day: input.maxPerDay,
      p_max_per_requester: input.maxPerRequesterPerDay,
      p_kind: input.kind ?? "search_miss",
    });
    if (error) throw new Error(`research_enqueue failed: ${error.code ?? "unknown"}`);
    const r = data as { outcome: EnqueueResearchResult["outcome"]; job?: ResearchJobRow };
    if (r.outcome === "daily_cap" || r.outcome === "requester_cap") return { outcome: r.outcome };
    return { outcome: r.outcome, job: mapJob(r.job!) };
  }

  async listForQuery(queryKey: string, limit: number): Promise<ResearchJob[]> {
    const { data, error } = await this.db()
      .from("research_jobs")
      .select(JOB_COLUMNS)
      .eq("query_key", queryKey)
      .order("requested_at", { ascending: false })
      .limit(Math.max(1, Math.min(20, limit)));
    if (error) throw new Error(`listForQuery failed: ${error.code ?? "unknown"}`);
    return ((data ?? []) as unknown as ResearchJobRow[]).map(mapJob);
  }

  async claim(limit: number, staleMinutes: number): Promise<ResearchJob[]> {
    const { data, error } = await this.db().rpc("research_claim_jobs", { p_limit: limit, p_stale_minutes: staleMinutes, p_kinds: ["search_miss", "area_developments"] });
    if (error) throw new Error(`research_claim_jobs failed: ${error.code ?? "unknown"}`);
    return ((data ?? []) as ResearchJobRow[]).map(mapJob);
  }

  async finish(id: string, input: FinishResearchInput): Promise<ResearchJob | null> {
    const { data, error } = await this.db().rpc("research_finish_job", {
      p_id: id,
      p_status: input.status,
      p_result_count: input.resultCount,
      p_error_code: input.errorCode,
      p_listing_ids: input.listingIds,
    });
    if (error) throw new Error(`research_finish_job failed: ${error.code ?? "unknown"}`);
    return data ? mapJob(data as ResearchJobRow) : null;
  }

  async listingsForQuery(queryKey: string, cacheHours: number): Promise<ExternalListing[]> {
    const since = new Date(Date.now() - cacheHours * 3_600_000).toISOString();
    const { data, error } = await this.db()
      .from("research_jobs")
      .select("id, research_job_listings(external_listings(*))")
      .eq("query_key", queryKey)
      .eq("status", "done")
      .gt("finished_at", since)
      .order("finished_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`listingsForQuery failed: ${error.code ?? "unknown"}`);
    const job = ((data ?? []) as unknown as { research_job_listings?: LinkRows }[])[0];
    return linkedListings(job?.research_job_listings);
  }

  async listRecent(limit: number): Promise<ResearchJobWithListings[]> {
    const { data, error } = await this.db()
      .from("research_jobs")
      .select(`${JOB_COLUMNS}, research_job_listings(external_listings(*))`)
      .order("requested_at", { ascending: false })
      .limit(Math.max(1, Math.min(200, limit)));
    if (error) throw new Error(`listRecent failed: ${error.code ?? "unknown"}`);
    return ((data ?? []) as unknown as (ResearchJobRow & { research_job_listings?: LinkRows })[]).map((r) => ({
      ...mapJob(r),
      listings: linkedListings(r.research_job_listings),
    }));
  }
}
