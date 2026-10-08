import { OpenAICompatClient } from "./openai-compat.js";
import type { ProviderConfig } from "./config.js";

/** NVIDIA NIM's OpenAI-compatible hosted inference endpoint. */
export class NvidiaClient extends OpenAICompatClient {
  constructor(config: ProviderConfig) {
    super("nvidia", config);
  }
}
