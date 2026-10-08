/**
 * Smoke-test both providers with a trivial "say hello" call.
 * Run with: npm run test:providers
 *
 * Skips any provider whose cheap model is still a placeholder.
 */
import { loadConfig } from "./config.js";
import { AgentRouterClient } from "./agentrouter.js";
import { OpenRouterClient } from "./openrouter.js";
import type { LLMClient } from "./types.js";

async function testProvider(name: string, client: LLMClient): Promise<void> {
  console.log(`\n── Testing ${name} ──`);
  try {
    const resp = await client.chat({
      messages: [
        {
          role: "user",
          content: `Reply with exactly: "hello from ${name}"`,
        },
      ],
      tier: "cheap",
      maxTokens: 64,
    });
    console.log(`✅ ${name} OK`);
    console.log(`   model:   ${resp.model}`);
    console.log(`   content: ${resp.content}`);
    console.log(`   tokens:  ${resp.tokensUsed}`);
    console.log(`   finish:  ${resp.finishReason}`);
  } catch (err) {
    console.error(`❌ ${name} FAILED: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log("providers.json loaded ✓\n");

  const ar = cfg.providers.agentrouter;
  const or = cfg.providers.openrouter;

  if (!ar.models.cheap.includes("PLACEHOLDER")) {
    await testProvider("agentrouter", new AgentRouterClient(ar));
  } else {
    console.log("── agentrouter: skipped (cheap model not configured) ──");
  }

  if (!or.models.cheap.includes("PLACEHOLDER")) {
    await testProvider("openrouter", new OpenRouterClient(or));
  } else {
    console.log("── openrouter:  skipped (cheap model not configured) ──");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
