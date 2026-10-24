import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  BLOCKED_PORTAL_DOMAINS,
  RESEARCH_MAX_SEARCHES,
  RESEARCH_SYSTEM_PROMPT,
  ResearchClientError,
  buildResearchUserPrompt,
  type ResearchClient,
  type ResearchClientResult,
  type ResearchContentBlock,
  type ResearchRequest,
  type ResearchUsage,
} from "@/discovery/research";
import { anthropicApiKey, anthropicModel } from "../env";

/** Output cap per request (includes adaptive thinking). Cost guardrail. */
export const RESEARCH_MAX_TOKENS = 12_000;
/** Server-tool loop resumptions after stop_reason "pause_turn". */
export const RESEARCH_MAX_CONTINUATIONS = 2;
/** Per-request HTTP timeout; the job also has an overall AbortSignal deadline. */
export const RESEARCH_REQUEST_TIMEOUT_MS = 110_000;

/**
 * Real research client: Claude Messages API with Anthropic's server-side web search tool.
 * - web_search_20250305 (basic, no dynamic filtering): results go straight into the model's
 *   context, so its answer cites them with web_search_result_location citations, which is the
 *   only evidence the validator trusts. (With dynamic filtering, results are filtered by code
 *   before the model sees them; suspected cause of an empty staging run on 2026-10-24.)
 *   A response with candidates but no result blocks fails closed ("no_evidence").
 * - max_uses caps searches; listing portals are blocked at the search.
 * - No SDK retries (the job retries at most once); refusals fall back server-side.
 * Never logs the key, prompt or response text.
 */
export class AnthropicResearchClient implements ResearchClient {
  readonly kind = "anthropic" as const;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? anthropicApiKey(), maxRetries: 0, timeout: RESEARCH_REQUEST_TIMEOUT_MS });
    this.model = opts.model ?? anthropicModel();
  }

  async research(req: ResearchRequest): Promise<ResearchClientResult> {
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
      { role: "user", content: buildResearchUserPrompt(req) },
    ];
    const content: ResearchContentBlock[] = [];
    const usage: ResearchUsage = { inputTokens: 0, outputTokens: 0, webSearchRequests: 0 };
    let stopReason: string | null = null;
    let model = this.model;

    for (let turn = 0; turn <= RESEARCH_MAX_CONTINUATIONS; turn++) {
      let res: Anthropic.Beta.Messages.BetaMessage;
      try {
        res = await this.client.beta.messages.create(
          {
            model: this.model,
            max_tokens: RESEARCH_MAX_TOKENS,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            output_config: { effort: "medium" },
            system: RESEARCH_SYSTEM_PROMPT,
            tools: [
              {
                type: "web_search_20250305",
                name: "web_search",
                max_uses: RESEARCH_MAX_SEARCHES,
                blocked_domains: [...BLOCKED_PORTAL_DOMAINS],
                user_location: { type: "approximate", city: "Bengaluru", region: "Karnataka", country: "IN", timezone: "Asia/Kolkata" },
              },
            ],
            messages,
          },
          { signal: req.signal },
        );
      } catch (e) {
        throw toResearchError(e, usage);
      }
      usage.inputTokens += res.usage.input_tokens ?? 0;
      usage.outputTokens += res.usage.output_tokens ?? 0;
      usage.webSearchRequests += res.usage.server_tool_use?.web_search_requests ?? 0;
      content.push(...res.content);
      stopReason = res.stop_reason;
      model = res.model;
      if (res.stop_reason !== "pause_turn") break;
      // Resume the server-side tool loop: send the paused assistant turn back as-is.
      messages.push({ role: "assistant", content: res.content });
    }
    return { content, stopReason, usage, model };
  }
}

function toResearchError(e: unknown, usage: ResearchUsage): ResearchClientError {
  if (e instanceof ResearchClientError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ResearchClientError("timeout", true, usage);
  if (e instanceof Anthropic.APIUserAbortError) return new ResearchClientError("timeout", true, usage);
  if (e instanceof Anthropic.RateLimitError) return new ResearchClientError("rate_limited", true, usage);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return new ResearchClientError("auth", false, usage);
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError)
    return new ResearchClientError("bad_request", false, usage);
  if (e instanceof Anthropic.InternalServerError) return new ResearchClientError("api_error", true, usage);
  if (e instanceof Anthropic.APIConnectionError) return new ResearchClientError("api_error", true, usage);
  if (e instanceof Anthropic.APIError) return new ResearchClientError("api_error", true, usage);
  if (e instanceof Error && e.name === "AbortError") return new ResearchClientError("timeout", true, usage);
  return new ResearchClientError("unknown", false, usage);
}
