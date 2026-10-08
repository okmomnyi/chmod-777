/**
 * Provider Router
 *
 * - Selects a provider per call based on per-provider concurrency slots.
 * - On 429 or 5xx from the primary provider, retries on the other.
 * - Enforces per-run and per-challenge token spend caps.
 * - Exposes the same LLMClient interface so call sites are provider-agnostic.
 */
import pLimit from "p-limit";
import type { ChatOptions, ChatResponse, LLMClient } from "./types.js";
import { loadConfig } from "./config.js";
import { AgentRouterClient } from "./agentrouter.js";
import { OpenRouterClient } from "./openrouter.js";
import { SpendTracker, SpendCapExceededError } from "./spend-tracker.js";

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "429" || (code && parseInt(code, 10) >= 500)) return true;
    // Network-level errors
    if (
      err.message.includes("ECONNRESET") ||
      err.message.includes("ETIMEDOUT") ||
      err.message.includes("fetch failed")
    )
      return true;
  }
  return false;
}

interface ProviderSlot {
  client: LLMClient;
  limiter: ReturnType<typeof pLimit>;
}

export class ProviderRouter implements LLMClient {
  readonly name = "router";
  private slots: ProviderSlot[];
  private spendTracker: SpendTracker;

  constructor() {
    const cfg = loadConfig();

    const slots: ProviderSlot[] = [];

    // Only add a provider if it is fully configured (no placeholders)
    const isConfigured = (p: typeof cfg.providers.agentrouter) =>
      !p.apiKey.includes("PLACEHOLDER") &&
      !p.baseUrl.includes("PLACEHOLDER");

    if (isConfigured(cfg.providers.agentrouter)) {
      slots.push({
        client: new AgentRouterClient(cfg.providers.agentrouter),
        limiter: pLimit(cfg.providers.agentrouter.maxConcurrency),
      });
    } else {
      console.warn("[router] agentrouter not configured — skipping");
    }

    if (isConfigured(cfg.providers.openrouter)) {
      slots.push({
        client: new OpenRouterClient(cfg.providers.openrouter),
        limiter: pLimit(cfg.providers.openrouter.maxConcurrency),
      });
    } else {
      console.warn("[router] openrouter not configured — skipping");
    }

    if (slots.length === 0) {
      throw new Error(
        "No providers configured. Fill in model IDs in config/providers.json"
      );
    }

    this.slots = slots as [ProviderSlot, ...ProviderSlot[]];
    this.spendTracker = new SpendTracker(
      cfg.spendCaps.perRunTokens,
      cfg.spendCaps.perChallengeTokens
    );
  }
  /** Expose spend tracker for external token accounting (e.g. agent loop) */
  get spend(): SpendTracker {
    return this.spendTracker;
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    // Enforce spend caps before making any API call
    if (options.runId) {
      this.spendTracker.checkCaps(options.runId, options.challengeId);
    }

    let lastError: unknown;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      try {
        const response = await slot.limiter(() => slot.client.chat(options));

        // Record spend after a successful call
        if (options.runId) {
          this.spendTracker.record(
            options.runId,
            response.tokensUsed,
            options.challengeId
          );
        }

        return response;
      } catch (err) {
        lastError = err;

        // Spend cap exceeded — don't retry, propagate immediately
        if (err instanceof SpendCapExceededError) throw err;

        // Only retry on the other provider for 429/5xx
        if (!isRetryableError(err)) throw err;

        console.warn(
          `[router] ${slot.client.name} failed (${(err as Error).message}), trying next provider...`
        );
      }
    }

    // Both providers failed
    throw lastError;
  }

  /**
   * Attempt a call with automatic tier escalation.
   * First tries `cheap`, then escalates to `claude` on failure.
   */
  async chatWithEscalation(
    options: ChatOptions,
    maxEscalations = 1
  ): Promise<ChatResponse> {
    let escalations = 0;
    let currentOptions = { ...options, tier: options.tier ?? "cheap" } as ChatOptions;

    while (true) {
      try {
        return await this.chat(currentOptions);
      } catch (err) {
        if (err instanceof SpendCapExceededError) throw err;
        if (!isRetryableError(err)) throw err;
        if (escalations >= maxEscalations) throw err;

        console.warn(
          `[router] Escalating to claude tier after failure: ${(err as Error).message}`
        );
        escalations++;
        currentOptions = { ...currentOptions, tier: "claude" };
      }
    }
  }
}

// Singleton — one router for the whole process
let _router: ProviderRouter | null = null;
export function getRouter(): ProviderRouter {
  if (!_router) _router = new ProviderRouter();
  return _router;
}
