import { OpenAICompatClient } from "./openai-compat.js";
import type { ProviderConfig } from "./config.js";

/**
 * AgentRouter adapter — wraps the OpenAI-compatible base.
 * Add any AgentRouter-specific header/auth quirks here if needed.
 */
export class AgentRouterClient extends OpenAICompatClient {
  constructor(config: ProviderConfig) {
    super("agentrouter", config);
  }
}
