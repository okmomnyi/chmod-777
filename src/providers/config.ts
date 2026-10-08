import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

/** A value is "configured" if it doesn't contain the placeholder marker */
const configured = z.string().min(1).refine(
  (v) => !v.includes("PLACEHOLDER"),
  { message: "Value is still a placeholder — fill in config/providers.json" }
);

const ProviderConfigSchema = z.object({
  baseUrl: configured.pipe(z.string().url()),
  // apiKey is allowed to be a placeholder — unconfigured providers are skipped at runtime
  apiKey: z.string().min(1),
  models: z.object({
    cheap: z.string().min(1),   // allowed to be placeholder (skipped at runtime)
    claude: z.string().min(1),
  }),
  maxConcurrency: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});

const SpendCapsSchema = z.object({
  perChallengeTokens: z.number().int().positive(),
  perRunTokens: z.number().int().positive(),
});

const TelegramConfigSchema = z.object({
  botToken: z.string().min(1),
  allowedUserIds: z.array(z.number().int()),
});

const ProvidersFileSchema = z.object({
  providers: z.object({
    agentrouter: ProviderConfigSchema,
    openrouter: ProviderConfigSchema,
  }),
  spendCaps: SpendCapsSchema,
  telegram: TelegramConfigSchema,
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

let _config: ProvidersFile | null = null;

export function loadConfig(): ProvidersFile {
  if (_config) return _config;

  const configPath = join(process.cwd(), "config", "providers.json");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);

  const result = ProvidersFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid providers.json: ${JSON.stringify(result.error.issues, null, 2)}`
    );
  }

  _config = result.data;
  return _config;
}
