import { OpenAICompatClient } from "./openai-compat.js";
import type { ProviderConfig } from "./config.js";

/**
 * OpenRouter adapter.
 * OpenRouter uses the standard OpenAI schema; no special overrides needed.
 */
export class OpenRouterClient extends OpenAICompatClient {
  constructor(config: ProviderConfig) {
    super("openrouter", config);
  }
}
