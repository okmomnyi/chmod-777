/** Smoke-test configured OpenRouter and NVIDIA NIM endpoints. */
import { loadConfig } from "./config.js";
import { OpenRouterClient } from "./openrouter.js";
import { NvidiaClient } from "./nvidia.js";
import type { LLMClient } from "./types.js";

async function testProvider(client: LLMClient): Promise<void> {
  console.log(`\n── Testing ${client.name} ──`);
  try {
    const response = await client.chat({
      messages: [{ role: "user", content: `Reply with exactly: hello from ${client.name}` }],
      tier: "cheap",
      maxTokens: 64,
    });
    console.log(`✅ ${client.name} OK — model ${response.model}; tokens ${response.tokensUsed}`);
  } catch (err) {
    console.error(`❌ ${client.name} FAILED: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.providers.openrouter.apiKey) await testProvider(new OpenRouterClient(cfg.providers.openrouter));
  else console.log("── OpenRouter: skipped (OPENROUTER_API_KEY is not set) ──");

  if (cfg.providers.nvidia.apiKey) await testProvider(new NvidiaClient(cfg.providers.nvidia));
  else console.log("── NVIDIA: skipped (NVIDIA_API_KEY is not set) ──");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
