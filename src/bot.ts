/**
 * Telegram bot — user-facing interface.
 *
 * Commands:
 *   /start_run <ctf_base_url> <token> [flag_regex]
 *   /status
 *   /flags
 *   /stop
 *
 * Security: only allowed user IDs (from providers.json) can use the bot.
 */
import { Bot, Context } from "grammy";
import { loadConfig } from "./providers/config.js";
import { getRunner } from "./runner.js";
import {
  getStatusCounts,
  getVerifiedFlags,
  getUnverifiedFlags,
  getActiveRun,
  getLatestRun,
} from "./db.js";
import type { VerifiedFlag } from "./verify.js";

const cfg = loadConfig();
if (!cfg.telegram.botToken || cfg.telegram.allowedUserIds.length === 0) {
  throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS in .env before starting the bot.");
}
const bot = new Bot(cfg.telegram.botToken);
const runner = getRunner();
const allowedIds = new Set(cfg.telegram.allowedUserIds);

// ─── Auth middleware ──────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !allowedIds.has(userId)) {
    await ctx.reply("⛔ Unauthorized. This bot is restricted to approved users.").catch(() => {});
    return;
  }
  await next();
});

// ─── Push notifications from runner ──────────────────────────────────────────

runner.on(
  "flag:verified",
  async (flag: VerifiedFlag & { challengeName: string; challengeCategory: string }) => {
    const evidenceLine = flag.evidence
      ? flag.evidence.split("\n").slice(0, 3).join(" | ")
      : "no evidence";

    const msg =
      `✅ Flag found — [${flag.challengeCategory}] ${flag.challengeName}\n` +
      `Flag: ${flag.flag}\nEvidence: ${evidenceLine.slice(0, 200)}\n` +
      `Submit this flag manually on the CTFd site.`;

    for (const userId of allowedIds) {
      await bot.api.sendMessage(userId, msg).catch(() => {});
    }
  }
);

runner.on("run:done", async ({ found, failed }: { runId: string; found: number; failed: number }) => {
  const msg = `🏁 Run complete — found: ${found}, failed: ${failed}`;
  for (const userId of allowedIds) {
    await bot.api.sendMessage(userId, msg).catch(() => {});
  }
});

runner.on("run:error", async (err: Error) => {
  const msg = `❌ Run error: ${err.message}`;
  for (const userId of allowedIds) {
    await bot.api.sendMessage(userId, msg).catch(() => {});
  }
});

runner.on("challenge:error", async ({ challengeId, name, error }: { challengeId: number; name: string; error: string }) => {
  const message = `❌ Challenge error — [${challengeId}] ${name}\n${error.slice(0, 1000)}`;
  for (const userId of allowedIds) await bot.api.sendMessage(userId, message).catch(() => {});
});

// Catch errors from all command handlers and return a useful reply instead of
// leaving the Telegram command unanswered.
bot.catch(async (err) => {
  console.error("[bot] Update handler failed:", err.error);
  await err.ctx.reply(`❌ Command failed: ${(err.error as Error)?.message ?? "Unexpected error"}`).catch(() => {});
});

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * /start_run <ctf_base_url> <token> [flag_regex]
 *
 * Starts a solving run. flag_regex defaults to a common CTF pattern.
 */
bot.command("start_run", async (ctx: Context) => {
  const parts = ctx.message?.text?.split(/\s+/) ?? [];
  // parts[0] = "/start_run", parts[1] = url, parts[2] = token, parts[3] = regex
  if (parts.length < 3) {
    await ctx.reply(
      "Usage: /start_run <ctf_base_url> <token> [flag_regex]\n" +
        "Example: /start_run https://ctf.example.com mytoken123 flag\\{[^}]+\\}"
    );
    return;
  }

  const ctfBaseUrl = parts[1];
  const token = parts[2];
  const flagRegex = parts[3] ?? "flag\\{[^}]+\\}";

  // Validate URL
  try {
    new URL(ctfBaseUrl);
  } catch {
    await ctx.reply("❌ Invalid CTF base URL.");
    return;
  }

  try {
    const runId = await runner.start({
      ctfBaseUrl,
      token,
      flagRegex,
      createdBy: ctx.from!.id,
    });
    await ctx.reply(
      `🚀 Run started!\nID: ${runId}\nCTF: ${ctfBaseUrl}\nFlag regex: ${flagRegex}\n\nUse /status to track progress. Found flags will be sent here for manual submission.`
    );
  } catch (err) {
    await ctx.reply(`❌ Failed to start run: ${(err as Error).message}`);
  }
});

/**
 * /status — show queued/running/found/failed counts for the active run
 */
bot.command("status", async (ctx: Context) => {
  const run = runner.currentRunId
    ? { id: runner.currentRunId }
    : await getActiveRun() ?? await getLatestRun();

  if (!run) {
    await ctx.reply("No active run. Start one with /start_run.");
    return;
  }

  const counts = await getStatusCounts(run.id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  await ctx.reply(
    `📊 Run ${run.id.slice(0, 8)}...\n` +
      `⏳ Queued:  ${counts.queued}\n` +
      `🔄 Running: ${counts.running}\n` +
      `✅ Found:   ${counts.found}\n` +
      `⚠️ Unverified: ${counts.unverified}\n` +
      `❌ Failed:  ${counts.failed}\n` +
      `──────────\n` +
      `   Total:  ${total}`,
  );
});

/**
 * /flags — list verified and unverified flag candidates
 */
bot.command("flags", async (ctx: Context) => {
  const run = runner.currentRunId
    ? { id: runner.currentRunId }
    : await getActiveRun() ?? await getLatestRun();

  if (!run) {
    await ctx.reply("No active run.");
    return;
  }

  const verified = await getVerifiedFlags(run.id);
  const unverified = await getUnverifiedFlags(run.id);

  if (verified.length === 0 && unverified.length === 0) {
    await ctx.reply("No flags found yet.");
    return;
  }

  let msg = "";

  if (verified.length > 0) {
    msg += `✅ Verified Flags (${verified.length})\n`;
    for (const f of verified) {
      const ev = f.evidence?.split("\n")[0]?.slice(0, 80) ?? "";
      msg += `• [${f.challengeCategory}] ${f.challengeName}: ${f.flagCandidate}\n  ${ev}\n`;
    }
  }

  if (unverified.length > 0) {
    if (msg) msg += "\n";
    msg += `⚠️ Unverified Candidates (${unverified.length})\n`;
    for (const f of unverified) {
      msg += `• ${f.challengeName}: ${f.flagCandidate ?? "unknown"}\n  Reason: ${f.error ?? f.stopReason}\n`;
    }
  }

  // Telegram message limit is 4096 chars
  if (msg.length > 4000) {
    msg = msg.slice(0, 4000) + "\n...(truncated)";
  }

  await ctx.reply(msg);
});

/**
 * /stop — cancel the active run and force-stop all containers
 */
bot.command("stop", async (ctx: Context) => {
  if (!runner.currentRunId) {
    await ctx.reply("No active run to stop.");
    return;
  }

  await ctx.reply("⏹ Stopping run and killing containers...");
  try {
    await runner.stop();
    await ctx.reply("✅ Run stopped. Any flags already found remain available with /flags.");
  } catch (err) {
    await ctx.reply(`❌ Error stopping run: ${(err as Error).message}`);
  }
});

/**
 * /help
 */
bot.command("help", async (ctx: Context) => {
  await ctx.reply(
    `*CTF Bot Commands*\n\n` +
      `/start_run <url> <token> [flag_regex] — Start solving a CTF\n` +
      `/status — Show current run progress\n` +
      `/flags — List found flag candidates for manual CTFd submission\n` +
      `/stop — Cancel the active run\n` +
      `/help — Show this message`,
    { parse_mode: "Markdown" }
  );
});

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) {
    await ctx.reply("Unknown command. Use /help to see available commands.");
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

console.log("CTF Bot starting...");
bot.start({
  onStart: () => console.log("Bot is running."),
}).catch((err) => {
  console.error("Bot fatal error:", err);
  process.exit(1);
});
