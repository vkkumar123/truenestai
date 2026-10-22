import "server-only";
import { randomUUID } from "node:crypto";
import type { ExternalListing } from "@/domain/types";
import type {
  EnqueueResearchInput,
  EnqueueResearchResult,
  ExternalListingRepository,
  FinishResearchInput,
  ResearchJob,
  ResearchJobRepository,
  ResearchJobWithListings,
} from "../types";

const HOUR = 3_600_000;
type Row = ResearchJob & { requesterIpHash: string | null; listingIds: string[] };

/**
 * In-memory research queue (fixture mode: dev, tests, CI). Mirrors the SQL functions in
 * supabase/migrations/0005_research_jobs.sql. Per server process; lost on restart.
 */
export class FixtureResearchJobRepository implements ResearchJobRepository {
  private readonly rows = new Map<string, Row>();

  constructor(
    private readonly listings: ExternalListingRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private view(r: Row): ResearchJob {
    const { requesterIpHash: _h, listingIds: _l, ...job } = r;
    void _h;
    void _l;
    return { ...job };
  }

  async enqueue(input: EnqueueResearchInput): Promise<EnqueueResearchResult> {
    const now = this.clock().getTime();
    const all = [...this.rows.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    const same = all.filter((r) => r.queryKey === input.queryKey);
    const active = same.find((r) => r.status === "queued" || r.status === "running");
    if (active) return { outcome: "active", job: this.view(active) };
    const cached = same.find(
      (r) => (r.status === "done" || r.status === "no_results") && r.finishedAt && now - Date.parse(r.finishedAt) < input.cacheHours * HOUR,
    );
    if (cached) return { outcome: "cached", job: this.view(cached) };
    const lastDay = all.filter((r) => now - Date.parse(r.requestedAt) < 24 * HOUR);
    if (lastDay.length >= input.maxPerDay) return { outcome: "daily_cap" };
    if (input.requesterIpHash && lastDay.filter((r) => r.requesterIpHash === input.requesterIpHash).length >= input.maxPerRequesterPerDay)
      return { outcome: "requester_cap" };
    const row: Row = {
      id: randomUUID(),
      queryText: input.queryText.slice(0, 100),
      queryKey: input.queryKey,
      localityId: input.localityId,
      status: "queued",
      attempts: 0,
      requestedAt: new Date(now).toISOString(),
      startedAt: null,
      finishedAt: null,
      resultCount: 0,
      errorCode: null,
      requesterIpHash: input.requesterIpHash,
      listingIds: [],
    };
    this.rows.set(row.id, row);
    return { outcome: "queued", job: this.view(row) };
  }

  async claim(limit: number, staleMinutes: number): Promise<ResearchJob[]> {
    const now = this.clock();
    const stale = now.getTime() - staleMinutes * 60_000;
    const ready = [...this.rows.values()]
      .filter((r) => r.status === "queued" || (r.status === "running" && r.startedAt && Date.parse(r.startedAt) < stale))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
      .slice(0, Math.max(0, limit));
    for (const r of ready) {
      r.status = "running";
      r.startedAt = now.toISOString();
      r.attempts += 1;
    }
    return ready.map((r) => this.view(r));
  }

  async finish(id: string, input: FinishResearchInput): Promise<ResearchJob | null> {
    const r = this.rows.get(id);
    if (!r || r.status !== "running") return null;
    r.status = input.status;
    r.resultCount = input.resultCount;
    r.errorCode = input.errorCode?.slice(0, 40) ?? null;
    r.finishedAt = input.status === "queued" ? null : this.clock().toISOString();
    r.listingIds = [...new Set([...r.listingIds, ...input.listingIds])];
    return this.view(r);
  }

  private async withListings(r: Row): Promise<ResearchJobWithListings> {
    const listings = (await Promise.all(r.listingIds.map((id) => this.listings.getById(id)))).filter((l) => l !== null);
    return { ...this.view(r), listings };
  }

  async listingsForQuery(queryKey: string, cacheHours: number): Promise<ExternalListing[]> {
    const now = this.clock().getTime();
    const job = [...this.rows.values()]
      .filter((r) => r.queryKey === queryKey && r.status === "done" && r.finishedAt && now - Date.parse(r.finishedAt) < cacheHours * HOUR)
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
    return job ? (await this.withListings(job)).listings : [];
  }

  async listRecent(limit: number): Promise<ResearchJobWithListings[]> {
    const rows = [...this.rows.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, limit);
    return Promise.all(rows.map((r) => this.withListings(r)));
  }
}
