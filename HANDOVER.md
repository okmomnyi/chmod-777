# CTF Bot — Handover Document

## What This Is

A TypeScript/Node.js tool that automates solving CTFd-based CTF challenges using
LLM agents. Controlled via Telegram. It finds flags but **never submits them**.

---

## Current State

### ✅ Done

| Component | Status | Notes |
|---|---|---|
| `src/providers/` | Complete | LLMClient interface, AgentRouter + OpenRouter adapters, router with concurrency + spend caps |
| `src/platforms/ctfd.ts` | Complete | Read-only CTFd client (fetchChallenges, fetchChallengeDetail, downloadFiles) |
| `src/agent/` | Complete | Solver loop, tool definitions, executor, container lifecycle |
| `src/runner.ts` | Complete | p-limit worker pool, EventEmitter push notifications |
| `src/bot.ts` | Complete | grammY Telegram bot, all 5 commands, auth middleware |
| `src/db.ts` | Complete | SQLite schema + all CRUD (runs, challenges, results) |
| `src/verify.ts` | Complete | Flag verifier — regex check + evidence containment check |
| `docker/Dockerfile.sandbox` | Complete | Built and tagged as `ctf-sandbox:latest` |
| TypeScript build | ✅ Clean | `npm run build` passes, no errors |
| Docker image | ✅ Built | `ctf-sandbox:latest` exists on the Docker daemon |

### ❌ Blocked

**AgentRouter API authentication is failing.**

- The gateway at `https://agentrouter.org` returns `401 unauthorized client detected`
  for all API calls made from this server, including from curl.
- The same key works in Claude Code on the user's local machine.
- Root cause is unknown — possible causes:
  - The gateway uses a different API path or request format than standard OpenAI compat
  - The server IP (`154.159.252.184`) may be blocked by the gateway
  - The gateway may require a session cookie or browser fingerprint
- OpenRouter is not yet configured (apiKey is placeholder in providers.json)

---

## Immediate Next Steps

### Option A — Fix AgentRouter (preferred)

1. Log into the AgentRouter web UI at `https://agentrouter.org`
2. Check: API key status, IP allowlist settings, allowed request origins
3. Also try generating a new key and test directly:
   ```bash
   curl -s "https://agentrouter.org/v1/chat/completions" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <new-key>" \
     -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"stream":false}'
   ```
4. If successful, update `config/providers.json` → `providers.agentrouter.apiKey`
5. Run `npm run test:providers` — should show `✅ agentrouter OK`

### Option B — Use OpenRouter instead

1. Get an API key from https://openrouter.ai
2. Update `config/providers.json`:
   ```json
   "openrouter": {
     "apiKey": "<your-key>",
     "models": {
       "cheap": "deepseek/deepseek-chat",
       "claude": "anthropic/claude-3.5-sonnet"
     }
   }
   ```
3. Run `npm run test:providers`

---

## File Layout

```
ctf-bot/
├── config/
│   └── providers.json          ← API keys, model names, telegram token, spend caps
├── docker/
│   └── Dockerfile.sandbox      ← Sandbox image (angr removed; install on-demand)
├── src/
│   ├── bot.ts                  ← Telegram bot entry point
│   ├── runner.ts               ← Worker pool orchestrator
│   ├── db.ts                   ← SQLite layer (better-sqlite3)
│   ├── verify.ts               ← Flag verification logic
│   ├── agent/
│   │   ├── solver.ts           ← LLM agent loop for one challenge
│   │   ├── tools.ts            ← Tool definitions (run_shell, read_file, write_file, http_request)
│   │   ├── executor.ts         ← Tool execution dispatch
│   │   ├── container.ts        ← Docker sandbox create/exec/stop
│   │   ├── index.ts            ← Re-exports
│   │   └── types.ts            ← SolverConfig, SolverResult, StopReason
│   ├── platforms/
│   │   ├── ctfd.ts             ← CTFd read-only client
│   │   └── test-ctfd.ts        ← Manual CTFd smoke test
│   └── providers/
│       ├── agentrouter.ts      ← AgentRouter adapter
│       ├── openrouter.ts       ← OpenRouter adapter
│       ├── openai-compat.ts    ← Base OpenAI-compat HTTP client
│       ├── router.ts           ← Concurrency router + spend caps
│       ├── spend-tracker.ts    ← Per-run / per-challenge token caps
│       ├── config.ts           ← providers.json loader + Zod schema
│       ├── types.ts            ← LLMClient, Message, ChatOptions, etc.
│       ├── index.ts            ← Re-exports
│       └── test.ts             ← Provider smoke test
├── ecosystem.config.cjs        ← PM2 config
├── package.json
└── tsconfig.json
```

---

## Key Config: `config/providers.json`

```json
{
  "providers": {
    "agentrouter": {
      "baseUrl": "https://agentrouter.org/v1",   ← MUST include /v1
      "apiKey": "sk-...",                          ← Currently failing auth
      "models": {
        "cheap": "deepseek-v4-flash",
        "claude": "claude-opus-4-8"
      },
      "maxConcurrency": 5,
      "timeoutMs": 120000
    },
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "OPENROUTER_API_KEY_PLACEHOLDER",  ← Fill this in
      "models": {
        "cheap": "OPENROUTER_CHEAP_MODEL_PLACEHOLDER",
        "claude": "anthropic/claude-3.5-sonnet"
      }
    }
  },
  "spendCaps": {
    "perChallengeTokens": 100000,
    "perRunTokens": 2000000
  },
  "telegram": {
    "botToken": "...",
    "allowedUserIds": [6699127848]
  }
}
```

**Placeholder logic**: any provider with `PLACEHOLDER` in its apiKey or baseUrl is
silently skipped by the router. You need at least one fully configured provider.

---

## How to Run

```bash
# Build
npm run build

# Test providers (do this first)
npm run test:providers

# Run bot (dev mode)
npm run dev:bot

# Run with PM2
pm2 start ecosystem.config.cjs

# Rebuild Docker sandbox image (if Dockerfile changes)
DOCKER_HOST=unix:///var/run/docker.sock docker build \
  -f docker/Dockerfile.sandbox -t ctf-sandbox:latest .
```

---

## Docker Notes

- Docker daemon is at `unix:///var/run/docker.sock` (not the default podman socket)
- Always set `DOCKER_HOST=unix:///var/run/docker.sock` for docker CLI commands
- The bot reads `DOCKER_HOST` env var automatically at runtime via `container.ts`
- Sandbox image name: `ctf-sandbox:latest` (already built)
- `angr` was removed from the Dockerfile — install per-challenge if needed:
  `pip3 install angr` inside the container via `run_shell`

---

## Security Properties (Non-Negotiable)

- No CTFd submit endpoint exists anywhere in the codebase — grep for "submit" to verify
- Containers: non-root (uid 1000), no Docker socket, read-only file mount, 512MB RAM, 1 CPU
- Spend caps enforced in `router.ts` before every API call, not just in the agent loop
- Telegram bot rejects all messages from user IDs not in `allowedUserIds`

---

## Known Limitations / TODOs

- `src/agent/executor.ts` — needs review; `read_file` returns base64 for binaries but
  the LLM may not handle that well without explicit instructions
- `http_request` tool has no redirect following limit — could be abused on a malicious CTF
- No rate limiting on Telegram commands (a user could spam `/start_run`)
- PM2 ecosystem only configures the bot process; runner is embedded in bot.ts via import.
  If you want them as separate processes, split runner.ts into a standalone script.
- SQLite `data/ctf-bot.db` is created in `process.cwd()` — make sure PM2 runs from the
  project root or set an absolute path in `db.ts`
