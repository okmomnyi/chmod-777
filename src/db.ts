/**
 * SQLite persistence layer using better-sqlite3.
 *
 * Schema:
 *   runs          — one row per /start_run invocation
 *   challenges    — mirrored from CTFd (name, category, etc.)
 *   results       — solver outcomes per run+challenge
 */
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";

const DB_PATH = join(process.cwd(), "data", "ctf-bot.db");

export type RunStatus = "running" | "stopped" | "done";
export type ChallengeStatus = "queued" | "running" | "found" | "failed";

export interface Run {
  id: string;
  ctfBaseUrl: string;
  flagRegex: string;
  status: RunStatus;
  startedAt: number;
  stoppedAt: number | null;
  createdBy: number; // Telegram user ID
}

export interface ChallengeRecord {
  id: number;
  name: string;
  category: string;
  value: number;
  description: string;
}

export interface ResultRecord {
  runId: string;
  challengeId: number;
  status: ChallengeStatus;
  flagCandidate: string | null;
  evidence: string | null;
  verified: boolean;
  confidence: string;
  stepsUsed: number;
  stopReason: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      ctfBaseUrl  TEXT NOT NULL,
      flagRegex   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'running',
      startedAt   INTEGER NOT NULL,
      stoppedAt   INTEGER,
      createdBy   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS challenges (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT '',
      value       INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS results (
      runId         TEXT NOT NULL,
      challengeId   INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'queued',
      flagCandidate TEXT,
      evidence      TEXT,
      verified      INTEGER NOT NULL DEFAULT 0,
      confidence    TEXT NOT NULL DEFAULT 'none',
      stepsUsed     INTEGER NOT NULL DEFAULT 0,
      stopReason    TEXT NOT NULL DEFAULT '',
      startedAt     INTEGER NOT NULL,
      finishedAt    INTEGER,
      error         TEXT,
      PRIMARY KEY (runId, challengeId),
      FOREIGN KEY (runId) REFERENCES runs(id)
    );
  `);
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export function insertRun(run: Run): void {
  getDb().prepare(`
    INSERT INTO runs (id, ctfBaseUrl, flagRegex, status, startedAt, stoppedAt, createdBy)
    VALUES (@id, @ctfBaseUrl, @flagRegex, @status, @startedAt, @stoppedAt, @createdBy)
  `).run(run);
}

export function updateRunStatus(id: string, status: RunStatus, stoppedAt?: number): void {
  getDb().prepare(`
    UPDATE runs SET status = @status, stoppedAt = @stoppedAt WHERE id = @id
  `).run({ id, status, stoppedAt: stoppedAt ?? null });
}

export function getRun(id: string): Run | undefined {
  return getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Run | undefined;
}

export function getActiveRun(): Run | undefined {
  return getDb().prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY startedAt DESC LIMIT 1`).get() as Run | undefined;
}

// ─── Challenges ───────────────────────────────────────────────────────────────

export function upsertChallenge(c: ChallengeRecord): void {
  getDb().prepare(`
    INSERT INTO challenges (id, name, category, value, description)
    VALUES (@id, @name, @category, @value, @description)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      value = excluded.value,
      description = excluded.description
  `).run(c);
}

export function getChallenge(id: number): ChallengeRecord | undefined {
  return getDb().prepare(`SELECT * FROM challenges WHERE id = ?`).get(id) as ChallengeRecord | undefined;
}

// ─── Results ─────────────────────────────────────────────────────────────────

export function upsertResult(r: ResultRecord): void {
  getDb().prepare(`
    INSERT INTO results (runId, challengeId, status, flagCandidate, evidence, verified,
      confidence, stepsUsed, stopReason, startedAt, finishedAt, error)
    VALUES (@runId, @challengeId, @status, @flagCandidate, @evidence, @verified,
      @confidence, @stepsUsed, @stopReason, @startedAt, @finishedAt, @error)
    ON CONFLICT(runId, challengeId) DO UPDATE SET
      status = excluded.status,
      flagCandidate = excluded.flagCandidate,
      evidence = excluded.evidence,
      verified = excluded.verified,
      confidence = excluded.confidence,
      stepsUsed = excluded.stepsUsed,
      stopReason = excluded.stopReason,
      finishedAt = excluded.finishedAt,
      error = excluded.error
  `).run({ ...r, verified: r.verified ? 1 : 0 });
}

export function getResults(runId: string): ResultRecord[] {
  type RawResult = Omit<ResultRecord, "verified"> & { verified: number };
  return (getDb().prepare(`SELECT * FROM results WHERE runId = ?`).all(runId) as RawResult[])
    .map((r) => ({ ...r, verified: r.verified === 1 }));
}

export function getStatusCounts(runId: string): Record<ChallengeStatus, number> {
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) as cnt FROM results WHERE runId = ? GROUP BY status
  `).all(runId) as Array<{ status: string; cnt: number }>;

  const counts: Record<ChallengeStatus, number> = { queued: 0, running: 0, found: 0, failed: 0 };
  for (const row of rows) {
    counts[row.status as ChallengeStatus] = row.cnt;
  }
  return counts;
}

export function isAlreadySolved(runId: string, challengeId: number): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM results WHERE runId = ? AND challengeId = ? AND status IN ('found', 'failed')
  `).get(runId, challengeId);
  return !!row;
}

export function getVerifiedFlags(runId: string): Array<ResultRecord & { challengeName: string; challengeCategory: string }> {
  return getDb().prepare(`
    SELECT r.*, c.name as challengeName, c.category as challengeCategory
    FROM results r
    JOIN challenges c ON r.challengeId = c.id
    WHERE r.runId = ? AND r.verified = 1
    ORDER BY r.finishedAt DESC
  `).all(runId) as Array<ResultRecord & { challengeName: string; challengeCategory: string }>;
}

export function getUnverifiedFlags(runId: string): Array<ResultRecord & { challengeName: string; challengeCategory: string }> {
  return getDb().prepare(`
    SELECT r.*, c.name as challengeName, c.category as challengeCategory
    FROM results r
    JOIN challenges c ON r.challengeId = c.id
    WHERE r.runId = ? AND r.flagCandidate IS NOT NULL AND r.verified = 0
    ORDER BY r.finishedAt DESC
  `).all(runId) as Array<ResultRecord & { challengeName: string; challengeCategory: string }>;
}
