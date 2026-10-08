# Requirements Document: ctf-bot

## Introduction

`ctf-bot` is a TypeScript/Node.js tool that autonomously attempts to solve CTFd-based CTF challenges using LLM agents operating inside isolated Docker containers. It is controlled through a Telegram bot and is strictly read-only with respect to the CTF platform — it finds flags and reports them, but never submits them. The system coordinates two long-running processes (bot and runner), an LLM provider router, a Docker sandbox orchestrator, and a SQLite database for persistent state.

## Requirements

### Requirement 1: LLM Provider Interface and Adapters

**User Story:** As a developer, I want a unified LLM client interface with two provider adapters (AgentRouter and OpenRouter) so that the agent loop can call any compatible API without knowing which one it's using.

1. The system MUST define a `LLMClient` interface with a `chat(messages, tools, options)` method returning content, tool calls, and token usage.
2. The system MUST implement an `AgentRouterAdapter` that calls an OpenAI-compatible API using a configurable base URL and API key from `providers.json`.
3. The system MUST implement an `OpenRouterAdapter` that calls the OpenRouter API using a configurable base URL and API key from `providers.json`.
4. Each adapter MUST support a `tier` parameter (`"cheap"` or `"smart"`) that selects the appropriate model ID as configured per provider in `providers.json`.
5. The system MUST load all provider configuration (base URL, API key, model IDs, concurrency limit, spend cap) from a `providers.json` file that is excluded from version control.

---

### Requirement 2: Provider Router with Concurrency, Retry, and Spend Cap

**User Story:** As the system, I want a router that manages provider selection, concurrency, retries, and spend limits so that LLM calls are reliable and cost-controlled.

1. The router MUST select a provider per call based on available `p-limit` concurrency slots and MUST enforce a per-provider maximum concurrent request limit.
2. The router MUST automatically retry a failed call against the secondary provider when the primary returns HTTP 429 or any 5xx status code.
3. The router MUST check accumulated LLM spend for the current run before each API call and MUST throw a `SpendCapExceededError` without making the call if the per-run cap would be exceeded.
4. The router MUST track and persist the token cost of every successful API call to the database for the current run.

---

### Requirement 3: CTFd Read-Only Platform Client

**User Story:** As a CTF participant, I want the tool to fetch challenge details and files from a CTFd instance so that the agent has everything it needs to attempt a challenge.

1. The CTFd client MUST implement `fetchChallenges(baseUrl, token)` that returns all available challenges via the CTFd API (`GET /api/v1/challenges`) authenticated with the provided token.
2. The CTFd client MUST implement `fetchChallengeDetail(id)` that returns full challenge metadata including description, connection info, file paths, and tags from `GET /api/v1/challenges/:id`.
3. The CTFd client MUST implement `downloadFiles(id)` that downloads all files associated with a challenge and writes them to `work/<id>/files/` on the host filesystem, returning the list of local paths.
4. The CTFd client MUST NOT contain any function that makes a POST, PUT, or PATCH request to any CTFd endpoint including `/api/v1/challenges/:id/attempt` or any other submit-like path.
5. The CTFd client MUST validate all API responses with Zod schemas before use.

---

### Requirement 4: Docker Solver Sandbox

**User Story:** As a security-conscious operator, I want each solver agent to run in an isolated Docker container so that a misbehaving agent cannot access the host system, secrets, or unintended network targets.

1. The system MUST provide a Dockerfile for a solver sandbox image based on Ubuntu 24.04 that includes Python 3, pwntools, binwalk, exiftool, curl, file, netcat, and build tools.
2. Solver containers MUST run as a non-root user (`uid:gid = 1000:1000`).
3. The challenge's `work/<id>/files/` directory MUST be bind-mounted into the container at `/work/files` as read-only.
4. The container MUST have a writable tmpfs mount at `/work/scratch` with a size limit of 256 MB for intermediate work.
5. Solver containers MUST NOT have access to the host Docker socket or any Docker API.
6. Solver containers MUST NOT have access to any host filesystem path beyond the read-only challenge files mount.
7. API keys, bot tokens, and any credentials MUST NOT be passed to or accessible inside solver containers.
8. If the challenge provides a `connection_info` host, the container's network MUST be restricted to only that host; otherwise the container MUST have no outbound network access.
9. Solver containers MUST drop all Linux capabilities (`CapDrop: ["ALL"]`) and MUST apply the `no-new-privileges` security option.

---

### Requirement 5: Agent Solver Loop

**User Story:** As a CTF participant, I want an autonomous agent that iteratively uses tools to investigate a challenge until it finds the flag or exhausts its budget, so that challenges can be solved without manual intervention.

1. The solver MUST send the challenge description and full conversation history to the LLM and execute any tool calls returned, feeding truncated output back in a loop.
2. The solver MUST expose four tools to the LLM: `run_shell(cmd, timeoutMs)`, `read_file(path)`, `write_file(path, content)`, and `http_request(url, method, body)`.
3. The solver MUST truncate all tool output to a maximum of 4096 characters before appending it to the conversation history.
4. The solver MUST stop and return a result when the configured flag regex matches a substring of any tool's output string (not the LLM's text response).
5. The solver MUST stop after a configurable maximum number of steps (default 30).
6. The solver MUST stop when the cumulative token usage for the challenge exceeds the configured per-challenge token budget.
7. The solver MUST stop when a configurable wall-clock timeout (default 10 minutes) is exceeded.
8. On any stop condition, the solver MUST return a `SolveResult` containing: `challengeId`, `flagCandidate`, `evidence` (the exact command + output that produced the flag), `stepsUsed`, `tokensUsed`, `stopReason`, and `confidence`.
9. The solver SHOULD escalate from the `"cheap"` tier to the `"smart"` tier after step 15 to improve success rate on harder challenges.

---

### Requirement 6: Flag Verification

**User Story:** As a CTF participant, I want every flag candidate to be independently verified before it is reported so that I can trust the results I receive.

1. `verifyFlag` MUST return `verified: false` if the `flagCandidate` does not match the run's configured flag regex.
2. `verifyFlag` MUST return `verified: false` if the `evidence` string does not contain the exact `flagCandidate` string.
3. Flags that fail verification MUST be stored with `verified = false` in the database and MUST be displayed in a separate section from verified flags in all bot output; they MUST never be mixed with verified flags.
4. `verifyFlag` MUST be a pure function with no side effects.

---

### Requirement 7: Runner Worker Pool

**User Story:** As a CTF participant, I want the runner to manage multiple challenges in parallel so that the entire CTF can be attempted efficiently within time and resource limits.

1. The runner MUST use `p-limit` to enforce a configurable maximum number of concurrently active solver containers (default: 5).
2. The runner MUST skip any challenge that already has a `found` status in the database for the current run.
3. The runner MUST write challenge state to SQLite at each transition: `queued` → `running` → `found` / `failed` / `unverified`.
4. The runner MUST emit a `flagFound` event immediately after a challenge result is verified, passing the `VerifiedResult` to listeners.
5. The runner MUST implement a `stop()` method that clears the pending queue, force-stops all active containers, and marks in-flight challenges as `failed`.
6. The runner MUST emit a `runComplete` event when all challenges have been processed or the run is stopped, including summary counts and total LLM spend.

---

### Requirement 8: Telegram Bot Interface

**User Story:** As a CTF participant, I want to control the tool and receive flag alerts through Telegram so that I can manage a run from my phone or computer without access to the server.

1. The bot MUST check every incoming update against a configured `allowedUserIds` list before invoking any handler; updates from non-allowlisted users MUST be silently dropped.
2. The bot MUST implement `/start_run <ctf_base_url> <token> [flag_regex]` that validates arguments, starts a new run, and confirms to the user.
3. The bot MUST implement `/status` that reports current counts of challenges in each status: queued, running, found, failed.
4. The bot MUST implement `/flags` that lists verified flag candidates with challenge name and evidence snippet, followed by a separate section for unverified candidates with their failure reason.
5. The bot MUST implement `/stop` that cancels the run, reports the number of containers killed and challenges cancelled.
6. The bot MUST send an immediate push message to the controlling user when a verified flag is found, formatted as: `✅ [category] challenge-name: flag{...}` with a one-line evidence summary.

---

### Requirement 9: Database and Persistence

**User Story:** As an operator, I want all run and challenge state persisted to SQLite so that the bot can report status accurately and results survive process restarts.

1. The database MUST maintain a `runs` table storing: `run_id`, `ctf_base_url`, `flag_regex`, `status`, `started_at`, `stopped_at`, `spend_usd`, `spend_cap_usd`.
2. The database MUST maintain a `challenges` table storing: `id`, `run_id`, `name`, `category`, `description`, `connection_info`, `status`, `flag_candidate`, `evidence`, `verified`, `steps_used`, `tokens_used`, `stop_reason`, `confidence`, `created_at`, `updated_at`.
3. The SQLite database MUST be opened in WAL mode to support concurrent reads from the bot while the runner writes.

---

### Requirement 10: Deployment and Build Order

**User Story:** As a developer, I want a clear build order and a PM2 configuration so that the system can be developed incrementally and run reliably in production.

1. The system MUST provide a PM2 `ecosystem.config.js` that runs `bot.ts` and `runner.ts` as separate named processes.
2. API keys and sensitive configuration MUST be stored in files excluded from version control (`providers.json`) and MUST NOT be committed to the repository.
3. The implementation MUST follow the prescribed build order: providers/ first, then platforms/ctfd.ts, then agent/, then runner.ts, then bot.ts last.
