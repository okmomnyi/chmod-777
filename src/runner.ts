/**
 * Worker pool — orchestrates challenge solving for a run.
 *
 * - Uses p-limit for concurrency (default 5)
 * - Skips already-solved challenges
 * - Persists all state to SQLite
 * - Emits events for the bot to relay as push messages
 */
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { join } from "path";
import pLimit from "p-limit";
import {
  insertRun,
  updateRunStatus,
  upsertChallenge,
  upsertResult,
  isAlreadySolved,
  getRun,
} from "./db.js";
import {
  fetchChallenges,
  fetchChallengeDetail,
  downloadFiles,
} from "./platforms/ctfd.js";
import { solveChallenge } from "./agent/solver.js";
import { verifyResult } from "./verify.js";
import type { VerifiedFlag, UnverifiedFlag } from "./verify.js";

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? "ctf-sandbox:latest";
const DEFAULT_CONCURRENCY = 5;

export interface RunOptions {
  ctfBaseUrl: string;
  token: string;
  flagRegex: string;
  concurrency?: number;
  createdBy: number; // Telegram user ID
}

export interface RunnerEvents {
  "flag:verified": (flag: VerifiedFlag & { challengeName: string; challengeCategory: string }) => void;
  "flag:unverified": (flag: UnverifiedFlag & { challengeName: string }) => void;
  "challenge:start": (info: { challengeId: number; name: string }) => void;
  "challenge:done": (info: { challengeId: number; name: string; status: string }) => void;
  "run:done": (info: { runId: string; found: number; failed: number }) => void;
  "run:error": (err: Error) => void;
}

export class Runner extends EventEmitter {
  private runId: string | null = null;
  private abortController: AbortController | null = null;

  /** Starts a new solving run. Returns the runId immediately; solving is async. */
  async start(opts: RunOptions): Promise<string> {
    if (this.runId && getRun(this.runId)?.status === "running") {
      throw new Error("A run is already in progress. Stop it first with /stop.");
    }

    const runId = randomUUID();
    this.runId = runId;
    this.abortController = new AbortController();

    insertRun({
      id: runId,
      ctfBaseUrl: opts.ctfBaseUrl,
      flagRegex: opts.flagRegex,
      status: "running",
      startedAt: Date.now(),
      stoppedAt: null,
      createdBy: opts.createdBy,
    });

    // Run asynchronously — don't await
    this._runLoop(runId, opts).catch((err: Error) => {
      this.emit("run:error", err);
      updateRunStatus(runId, "done", Date.now());
    });

    return runId;
  }

  async stop(): Promise<void> {
    if (!this.runId) return;
    this.abortController?.abort();
    updateRunStatus(this.runId, "stopped", Date.now());

    // Force-stop containers for this run
    const { stopRunContainers } = await import("./agent/container.js");
    await stopRunContainers(this.runId);

    this.runId = null;
    this.abortController = null;
  }

  get currentRunId(): string | null {
    return this.runId;
  }

  private async _runLoop(runId: string, opts: RunOptions): Promise<void> {
    const { signal } = this.abortController!;
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    const limit = pLimit(concurrency);

    // 1. Fetch challenge list
    const challenges = await fetchChallenges(opts.ctfBaseUrl, opts.token);

    // 2. Enqueue all unsolved challenges
    const tasks = challenges
      .filter((c) => !c.solved_by_me)
      .filter((c) => !isAlreadySolved(runId, c.id));

    // Persist challenge metadata
    for (const c of challenges) {
      upsertChallenge({
        id: c.id,
        name: c.name,
        category: c.category,
        value: c.value,
        description: "",
      });
    }

    // 3. Queue as "queued" in DB
    for (const c of tasks) {
      upsertResult({
        runId,
        challengeId: c.id,
        status: "queued",
        flagCandidate: null,
        evidence: null,
        verified: false,
        confidence: "none",
        stepsUsed: 0,
        stopReason: "",
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
      });
    }

    let found = 0;
    let failed = 0;

    // 4. Process with concurrency limit
    await Promise.allSettled(
      tasks.map((c) =>
        limit(async () => {
          if (signal.aborted) return;

          this.emit("challenge:start", { challengeId: c.id, name: c.name });

          // Mark running
          upsertResult({
            runId,
            challengeId: c.id,
            status: "running",
            flagCandidate: null,
            evidence: null,
            verified: false,
            confidence: "none",
            stepsUsed: 0,
            stopReason: "",
            startedAt: Date.now(),
            finishedAt: null,
            error: null,
          });

          try {
            // Fetch full detail + download files
            const detail = await fetchChallengeDetail(
              opts.ctfBaseUrl,
              opts.token,
              c.id
            );

            // Update description in DB
            upsertChallenge({
              id: c.id,
              name: c.name,
              category: c.category,
              value: c.value,
              description: detail.description,
            });

            const filesDir = join(process.cwd(), "work", String(c.id), "files");
            await downloadFiles(opts.ctfBaseUrl, opts.token, c.id);

            if (signal.aborted) return;

            // Run solver
            const solverResult = await solveChallenge({
              challenge: detail,
              ctfBaseUrl: opts.ctfBaseUrl,
              flagRegex: opts.flagRegex,
              sandboxImage: SANDBOX_IMAGE,
              filesDir,
              runId,
            });

            // Verify
            const verification = verifyResult(solverResult, opts.flagRegex);

            const status = verification.verified ? "found" : "failed";
            if (verification.verified) found++;
            else failed++;

            upsertResult({
              runId,
              challengeId: c.id,
              status,
              flagCandidate: solverResult.flagCandidate,
              evidence: solverResult.evidence,
              verified: verification.verified,
              confidence: solverResult.confidence,
              stepsUsed: solverResult.stepsUsed,
              stopReason: solverResult.stopReason,
              startedAt: Date.now(),
              finishedAt: Date.now(),
              error: solverResult.error ?? null,
            });

            if (verification.verified) {
              this.emit("flag:verified", {
                ...(verification as VerifiedFlag),
                challengeName: c.name,
                challengeCategory: c.category,
              });
            } else if (solverResult.flagCandidate) {
              this.emit("flag:unverified", {
                ...(verification as UnverifiedFlag),
                challengeName: c.name,
              });
            }

            this.emit("challenge:done", {
              challengeId: c.id,
              name: c.name,
              status,
            });
          } catch (err) {
            failed++;
            upsertResult({
              runId,
              challengeId: c.id,
              status: "failed",
              flagCandidate: null,
              evidence: null,
              verified: false,
              confidence: "none",
              stepsUsed: 0,
              stopReason: "error",
              startedAt: Date.now(),
              finishedAt: Date.now(),
              error: (err as Error).message,
            });

            this.emit("challenge:done", {
              challengeId: c.id,
              name: c.name,
              status: "failed",
            });
          }
        })
      )
    );

    if (!signal.aborted) {
      updateRunStatus(runId, "done", Date.now());
      this.emit("run:done", { runId, found, failed });
      this.runId = null;
    }
  }
}

// Singleton runner
let _runner: Runner | null = null;
export function getRunner(): Runner {
  if (!_runner) _runner = new Runner();
  return _runner;
}
