// Research client contract. The real implementation (Anthropic Messages API + server-side web
// search) lives in src/server/integrations/anthropic-research-client.ts (server-only); fixture
// mode, unit tests and CI inject FakeResearchClient (./fake-client.ts), which never uses the network.
import type Anthropic from "@anthropic-ai/sdk";

export type ResearchContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

export interface ResearchRequest {
  /** Cleaned buyer query (<= 100 chars). Data, never instructions. */
  queryText: string;
  /** Display names of configured localities to scope the search (from src/config/markets). */
  localityNames: string[];
  /** The locality the buyer filtered on, if any. */
  localityName?: string | null;
  /** Aborts the request (per-job timeout). */
  signal?: AbortSignal;
}

export interface ResearchUsage {
  inputTokens: number;
  outputTokens: number;
  webSearchRequests: number;
}

export interface ResearchClientResult {
  /** Every content block from the response (all turns when a pause_turn was resumed). */
  content: ResearchContentBlock[];
  stopReason: string | null;
  usage: ResearchUsage;
  model: string;
}

export interface ResearchClient {
  /** "fake" never touches the network. */
  readonly kind: "anthropic" | "fake";
  research(req: ResearchRequest): Promise<ResearchClientResult>;
}

/** Short, non-sensitive failure codes stored in research_jobs.error_code. */
export type ResearchErrorCode =
  | "timeout"
  | "rate_limited"
  | "api_error"
  | "auth"
  | "bad_request"
  | "refusal"
  | "max_tokens"
  | "parse_error"
  | "source_not_runnable"
  | "config"
  | "store_failed"
  | "unknown";

export class ResearchClientError extends Error {
  constructor(
    readonly code: ResearchErrorCode,
    readonly retryable: boolean,
    /** Partial usage, when the failure happened after a response (e.g. refusal). */
    readonly usage?: ResearchUsage,
  ) {
    super(`research failed: ${code}`);
    this.name = "ResearchClientError";
  }
}
