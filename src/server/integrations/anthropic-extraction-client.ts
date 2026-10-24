import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionClientError,
  buildExtractionInstructions,
  type ExtractionClient,
  type ExtractionClientResult,
  type ExtractionRequest,
} from "@/research/extraction";
import { anthropicApiKey, anthropicModel } from "../env";

/** Output cap (includes adaptive thinking). A registration document yields a few dozen short lines. */
export const EXTRACTION_MAX_TOKENS = 16_000;
/** HTTP timeout per request; the service also passes a 120 s AbortSignal deadline. */
export const EXTRACTION_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Real extraction client: Claude Messages API with the uploaded PDF as a base64 document block,
 * citations enabled, so every value the model writes comes back with page_location citations
 * (cited_text + page numbers). Those citations are the only evidence the validator trusts.
 * - Citations cannot be combined with structured outputs, so the answer is plain
 *   "attribute | value" lines (src/research/extraction/prompt.ts).
 * - No web tools, no other input: the document is the only source, and it is data, not instructions.
 * - No SDK retries (staff retry a failed extraction); refusals fall back server-side.
 * Never logs the key, the document, the prompt or the response text.
 */
export class AnthropicExtractionClient implements ExtractionClient {
  readonly kind = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? anthropicApiKey(), maxRetries: 0, timeout: EXTRACTION_REQUEST_TIMEOUT_MS });
    this.model = opts.model ?? anthropicModel();
  }

  async extract(req: ExtractionRequest): Promise<ExtractionClientResult> {
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: EXTRACTION_MAX_TOKENS,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium" },
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: { type: "base64", media_type: "application/pdf", data: Buffer.from(req.pdf).toString("base64") },
                  citations: { enabled: true },
                },
                { type: "text", text: buildExtractionInstructions() },
              ],
            },
          ],
        },
        { signal: req.signal },
      );
    } catch (e) {
      throw toExtractionError(e);
    }
    return {
      content: res.content,
      stopReason: res.stop_reason,
      usage: { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 },
      model: res.model,
    };
  }
}

function toExtractionError(e: unknown): ExtractionClientError {
  if (e instanceof ExtractionClientError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ExtractionClientError("timeout");
  if (e instanceof Anthropic.APIUserAbortError) return new ExtractionClientError("timeout");
  if (e instanceof Anthropic.RateLimitError) return new ExtractionClientError("rate_limited");
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ExtractionClientError("auth");
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError)
    return new ExtractionClientError("bad_request");
  if (e instanceof Anthropic.InternalServerError) return new ExtractionClientError("api_error");
  if (e instanceof Anthropic.APIConnectionError) return new ExtractionClientError("api_error");
  if (e instanceof Anthropic.APIError) return new ExtractionClientError("api_error");
  if (e instanceof Error && e.name === "AbortError") return new ExtractionClientError("timeout");
  return new ExtractionClientError("unknown");
}
