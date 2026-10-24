// Document extraction client contract (S3a, D21). The real implementation (Anthropic Messages API
// with a PDF document block and citations) lives in
// src/server/integrations/anthropic-extraction-client.ts (server-only). Fixture mode, unit tests and
// CI use FakeExtractionClient (./fake-client.ts), which never touches the network.
import type Anthropic from "@anthropic-ai/sdk";

export type ExtractionContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

export interface ExtractionRequest {
  /** The PDF bytes (already checked: %PDF- magic, size and page caps). Data, never instructions. */
  pdf: Uint8Array;
  /** Aborts the request (per-extraction timeout). */
  signal?: AbortSignal;
}

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ExtractionClientResult {
  content: ExtractionContentBlock[];
  stopReason: string | null;
  usage: ExtractionUsage;
  model: string;
}

export interface ExtractionClient {
  /** "fake" never touches the network. */
  readonly kind: "anthropic" | "fake";
  readonly model: string;
  extract(req: ExtractionRequest): Promise<ExtractionClientResult>;
}

/** Short, non-sensitive codes stored in document_extractions.error_code. */
export type ExtractionErrorCode =
  // failed (retryable by staff)
  | "timeout"
  | "rate_limited"
  | "api_error"
  | "auth"
  | "bad_request"
  | "refused"
  | "truncated"
  | "file_missing"
  | "checksum_mismatch"
  | "config"
  | "unknown"
  // unsupported (final for this document version)
  | "not_pdf"
  | "too_large"
  | "too_many_pages"
  | "source_not_supported"
  | "source_url_missing";

export class ExtractionClientError extends Error {
  constructor(readonly code: ExtractionErrorCode) {
    super(`document extraction failed: ${code}`);
    this.name = "ExtractionClientError";
  }
}
