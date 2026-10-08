# CTF Bot — Handover

## Current behavior

This TypeScript app is controlled through Telegram. It fetches CTFd challenge data, runs a tool-using LLM solver in Docker, verifies candidates against the selected flag regex and captured tool evidence, persists runs and results in PostgreSQL, and sends verified flags to authorized Telegram users. **Flag submission is manual. The bot has no `/submit` command; the HTTP tool blocks the standard CTFd challenge-attempt endpoint.**

The bot replies to unknown commands and command-handler failures. Verified results are pushed as soon as a challenge finishes; challenge and run failures are also sent to Telegram. `/flags` separates verified flags from unverified candidates.

## Runtime setup

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to the pooled Neon Postgres connection string.
3. Set `TELEGRAM_BOT_TOKEN` and comma-separated `TELEGRAM_ALLOWED_USER_IDS`.
4. Set at least one provider key: `OPENROUTER_API_KEY` or `NVIDIA_API_KEY`.
5. Run `npm install`, `npm run build`, then `npm run dev:bot` or `pm2 start ecosystem.config.cjs`.

The database creates its tables on first use. Provider models default to OpenRouter `openrouter/free` and NVIDIA NIM `nvidia/nemotron-3.5-lightning-30b-a3b`, with a smart tier configured for each. Environment variables can override keys and model IDs. `config/providers.json` is optional and remains supported for provider tuning and spend caps.

## Main files

- `src/bot.ts` — Telegram commands, authorization, push notifications, and handler errors.
- `src/runner.ts` — challenge queue, worker concurrency, verification, Postgres updates, and run events.
- `src/db.ts` — Neon/Postgres connection pool, schema initialization, and CRUD operations.
- `src/platforms/ctfd.ts` — CTFd challenge reads and file downloads.
- `src/agent/solver.ts` — per-challenge LLM loop and tool-output flag detection.
- `src/agent/container.ts` — Docker sandbox lifecycle.
- `src/providers/` — OpenAI-compatible OpenRouter and NVIDIA NIM clients plus failover router.
- `src/verify.ts` — pure candidate regex/evidence verification.

## Operational limitations to address separately

- The CTFd response payloads are not currently validated with Zod.
- The existing sandbox network configuration does not enforce an egress allowlist; treat untrusted challenge content and network access accordingly.
- Per-run and per-challenge token accounting is in-memory and resets when the process restarts.
- There is one PM2 process; the runner is embedded in the bot process.
- Existing SQLite data is not automatically migrated to Neon. The Postgres tables are initialized separately.

## Commands

- `/start_run <ctf_base_url> <token> [flag_regex]`
- `/status`
- `/flags`
- `/stop`
- `/help`

`npm run test:providers` makes live calls to configured provider APIs. `npm run test:ctfd` requires `CTF_URL` and `CTF_TOKEN`.
