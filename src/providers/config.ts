import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import "dotenv/config";

const ProviderConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string(),
  models: z.object({
    cheap: z.string().min(1),
    smart: z.string().min(1),
  }),
  maxConcurrency: z.number().int().positive().default(3),
  timeoutMs: z.number().int().positive().default(120_000),
});

const SpendCapsSchema = z.object({
  perChallengeTokens: z.number().int().positive(),
  perRunTokens: z.number().int().positive(),
});

const TelegramConfigSchema = z.object({
  botToken: z.string().default(""),
  allowedUserIds: z.array(z.number().int()).default([]),
});

const ProvidersFileSchema = z.object({
  providers: z.object({
    openrouter: ProviderConfigSchema,
    nvidia: ProviderConfigSchema,
  }),
  spendCaps: SpendCapsSchema.default({ perChallengeTokens: 100_000, perRunTokens: 2_000_000 }),
  telegram: TelegramConfigSchema.default({ botToken: "", allowedUserIds: [] }),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

let _config: ProvidersFile | null = null;

export function loadConfig(): ProvidersFile {
  if (_config) return _config;

  const configPath = join(process.cwd(), "config", "providers.json");
  const parsed = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf-8"))
    : {};

  const envUsers = process.env.TELEGRAM_ALLOWED_USER_IDS
    ?.split(",")
    .map((id) => Number(id.trim()))
    .filter(Number.isInteger);
  const base = {
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "",
        models: { cheap: "openrouter/free", smart: "openai/gpt-oss-20b:free" },
        maxConcurrency: 3,
        timeoutMs: 120_000,
      },
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "",
        models: {
          cheap: "nvidia/nemotron-3.5-lightning-30b-a3b",
          smart: "nvidia/nemotron-3-super-120b-a12b",
        },
        maxConcurrency: 3,
        timeoutMs: 120_000,
      },
    },
    spendCaps: { perChallengeTokens: 100_000, perRunTokens: 2_000_000 },
    telegram: { botToken: "", allowedUserIds: [] as number[] },
  };

  const supplied = parsed && typeof parsed === "object" ? parsed : {};
  const providers = supplied.providers ?? {};
  const telegram = supplied.telegram ?? {};
  const merged = {
    providers: {
      openrouter: { ...base.providers.openrouter, ...(providers.openrouter ?? {}) },
      nvidia: { ...base.providers.nvidia, ...(providers.nvidia ?? {}) },
    },
    spendCaps: { ...base.spendCaps, ...(supplied.spendCaps ?? {}) },
    telegram: {
      ...base.telegram,
      ...telegram,
      ...(process.env.TELEGRAM_BOT_TOKEN ? { botToken: process.env.TELEGRAM_BOT_TOKEN } : {}),
      ...(envUsers ? { allowedUserIds: envUsers } : {}),
    },
  };

  merged.providers.openrouter.apiKey = process.env.OPENROUTER_API_KEY ?? merged.providers.openrouter.apiKey;
  merged.providers.nvidia.apiKey = process.env.NVIDIA_API_KEY ?? merged.providers.nvidia.apiKey;
  merged.providers.openrouter.models.cheap = process.env.OPENROUTER_CHEAP_MODEL ?? merged.providers.openrouter.models.cheap;
  merged.providers.openrouter.models.smart = process.env.OPENROUTER_SMART_MODEL ?? merged.providers.openrouter.models.smart;
  merged.providers.nvidia.models.cheap = process.env.NVIDIA_CHEAP_MODEL ?? merged.providers.nvidia.models.cheap;
  merged.providers.nvidia.models.smart = process.env.NVIDIA_SMART_MODEL ?? merged.providers.nvidia.models.smart;

  const result = ProvidersFileSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(
      `Invalid providers.json: ${JSON.stringify(result.error.issues, null, 2)}`
    );
  }

  _config = result.data;
  return _config;
}
