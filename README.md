# CTF Bot

Telegram-controlled CTFd challenge research assistant. It fetches challenge metadata and files, runs an LLM solver in Docker, verifies candidate flags against a configured regex and evidence, then sends results to authorized Telegram users. **Flags are delivered for a person to submit manually; the bot has no automatic submission command.**

## Configure

1. Copy `.env.example` to `.env` and fill in `DATABASE_URL` with Neon’s pooled PostgreSQL connection string, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_USER_IDS`.
2. Set at least one of `OPENROUTER_API_KEY` or `NVIDIA_API_KEY`. Both can be set to enable provider failover.
3. Install dependencies with `npm install`.
4. Build with `npm run build`, then start with `npm run dev:bot` or PM2 using `ecosystem.config.cjs`.

On first database use, the app creates the PostgreSQL tables and indexes. `config/providers.json` remains supported for model and spend-cap overrides; environment variables override API keys and Telegram credentials.

Default model configuration uses OpenRouter's `openrouter/free` route and NVIDIA's hosted NIM endpoint (`https://integrate.api.nvidia.com/v1`). Model IDs can be overridden with the variables shown in `.env.example`.

## Telegram commands

- `/start_run <ctf_base_url> <token> [flag_regex]` starts a challenge run.
- `/status` shows the latest run's queued, running, found, unverified, and failed counts.
- `/flags` lists verified flags separately from unverified candidates, including the reason when available.
- `/stop` stops the active run and its containers.
- `/help` lists the commands.

The bot reports unknown commands and handler errors in Telegram. A verified flag is pushed as soon as it is found, with a short evidence excerpt and a reminder to submit it manually on CTFd.

## Notes

- CTFd reads are implemented in `src/platforms/ctfd.ts`; there is no `/submit` command, and the HTTP tool rejects standard CTFd challenge-attempt routes.
- SQLite has been replaced by Neon-compatible PostgreSQL via `pg`.
- The solver sandbox is configured in `docker/Dockerfile.sandbox` and `src/agent/container.ts`.
- `npm run test:providers` makes live API calls to any configured provider. `npm run test:ctfd` requires `CTF_URL` and `CTF_TOKEN`.
