/** Neon/PostgreSQL persistence layer. Set DATABASE_URL to a Neon pooled URL. */
import { Pool } from "pg";
import "dotenv/config";

export type RunStatus = "running" | "stopped" | "done";
export type ChallengeStatus = "queued" | "running" | "found" | "failed" | "unverified";

export interface Run {
  id: string;
  ctfBaseUrl: string;
  flagRegex: string;
  status: RunStatus;
  startedAt: number;
  stoppedAt: number | null;
  createdBy: number;
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

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required (use your Neon pooled connection string).");
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  pool.on("error", (err) => console.error("[db] PostgreSQL pool error:", err.message));
  return pool;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          ctf_base_url TEXT NOT NULL,
          flag_regex TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          started_at BIGINT NOT NULL,
          stopped_at BIGINT,
          created_by BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS challenges (
          id BIGINT PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT '',
          value INTEGER NOT NULL DEFAULT 0,
          description TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS results (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          challenge_id BIGINT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          flag_candidate TEXT,
          evidence TEXT,
          verified BOOLEAN NOT NULL DEFAULT FALSE,
          confidence TEXT NOT NULL DEFAULT 'none',
          steps_used INTEGER NOT NULL DEFAULT 0,
          stop_reason TEXT NOT NULL DEFAULT '',
          started_at BIGINT NOT NULL,
          finished_at BIGINT,
          error TEXT,
          PRIMARY KEY (run_id, challenge_id)
        );
        CREATE INDEX IF NOT EXISTS results_run_status_idx ON results(run_id, status);
      `);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  await schemaReady;
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
  schemaReady = null;
}

export async function insertRun(run: Run): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO runs (id, ctf_base_url, flag_regex, status, started_at, stopped_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [run.id, run.ctfBaseUrl, run.flagRegex, run.status, run.startedAt, run.stoppedAt, run.createdBy],
  );
}

export async function updateRunStatus(id: string, status: RunStatus, stoppedAt?: number): Promise<void> {
  await ensureSchema();
  await getPool().query(`UPDATE runs SET status=$2, stopped_at=$3 WHERE id=$1`, [id, status, stoppedAt ?? null]);
}

const RUN_COLUMNS = `id, ctf_base_url AS "ctfBaseUrl", flag_regex AS "flagRegex", status,
  started_at AS "startedAt", stopped_at AS "stoppedAt", created_by AS "createdBy"`;

export async function getRun(id: string): Promise<Run | undefined> {
  await ensureSchema();
  const result = await getPool().query<Run>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id=$1`, [id]);
  return result.rows[0];
}

export async function getActiveRun(): Promise<Run | undefined> {
  await ensureSchema();
  const result = await getPool().query<Run>(`SELECT ${RUN_COLUMNS} FROM runs WHERE status='running' ORDER BY started_at DESC LIMIT 1`);
  return result.rows[0];
}

export async function getLatestRun(): Promise<Run | undefined> {
  await ensureSchema();
  const result = await getPool().query<Run>(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY started_at DESC LIMIT 1`);
  return result.rows[0];
}

export async function upsertChallenge(c: ChallengeRecord): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO challenges (id,name,category,value,description) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category,
       value=EXCLUDED.value, description=EXCLUDED.description`,
    [c.id, c.name, c.category, c.value, c.description],
  );
}

export async function getChallenge(id: number): Promise<ChallengeRecord | undefined> {
  await ensureSchema();
  const result = await getPool().query<ChallengeRecord>(`SELECT id,name,category,value,description FROM challenges WHERE id=$1`, [id]);
  return result.rows[0];
}

export async function upsertResult(r: ResultRecord): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO results (run_id,challenge_id,status,flag_candidate,evidence,verified,confidence,
      steps_used,stop_reason,started_at,finished_at,error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (run_id,challenge_id) DO UPDATE SET status=EXCLUDED.status,
       flag_candidate=EXCLUDED.flag_candidate, evidence=EXCLUDED.evidence, verified=EXCLUDED.verified,
       confidence=EXCLUDED.confidence, steps_used=EXCLUDED.steps_used, stop_reason=EXCLUDED.stop_reason,
       started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at, error=EXCLUDED.error`,
    [r.runId,r.challengeId,r.status,r.flagCandidate,r.evidence,r.verified,r.confidence,
      r.stepsUsed,r.stopReason,r.startedAt,r.finishedAt,r.error],
  );
}

const RESULT_COLUMNS = `run_id AS "runId", challenge_id AS "challengeId", status,
  flag_candidate AS "flagCandidate", evidence, verified, confidence, steps_used AS "stepsUsed",
  stop_reason AS "stopReason", started_at AS "startedAt", finished_at AS "finishedAt", error`;

export async function getResults(runId: string): Promise<ResultRecord[]> {
  await ensureSchema();
  const result = await getPool().query<ResultRecord>(`SELECT ${RESULT_COLUMNS} FROM results WHERE run_id=$1`, [runId]);
  return result.rows;
}

export async function getStatusCounts(runId: string): Promise<Record<ChallengeStatus, number>> {
  await ensureSchema();
  const result = await getPool().query<{ status: ChallengeStatus; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM results WHERE run_id=$1 GROUP BY status`, [runId],
  );
  const counts: Record<ChallengeStatus, number> = { queued: 0, running: 0, found: 0, failed: 0, unverified: 0 };
  for (const row of result.rows) counts[row.status] = Number(row.count);
  return counts;
}

export async function isAlreadySolved(runId: string, challengeId: number): Promise<boolean> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT 1 FROM results WHERE run_id=$1 AND challenge_id=$2 AND status IN ('found','failed','unverified') LIMIT 1`,
    [runId, challengeId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface FlagRow extends ResultRecord { challengeName: string; challengeCategory: string }

export async function getVerifiedFlags(runId: string): Promise<FlagRow[]> {
  await ensureSchema();
  const result = await getPool().query<FlagRow>(
    `SELECT r.run_id AS "runId", r.challenge_id AS "challengeId", r.status,
      r.flag_candidate AS "flagCandidate", r.evidence, r.verified, r.confidence,
      r.steps_used AS "stepsUsed", r.stop_reason AS "stopReason", r.started_at AS "startedAt",
      r.finished_at AS "finishedAt", r.error, c.name AS "challengeName", c.category AS "challengeCategory"
     FROM results r JOIN challenges c ON c.id=r.challenge_id
     WHERE r.run_id=$1 AND r.verified=TRUE ORDER BY r.finished_at DESC`, [runId],
  );
  return result.rows;
}

export async function getUnverifiedFlags(runId: string): Promise<FlagRow[]> {
  await ensureSchema();
  const result = await getPool().query<FlagRow>(
    `SELECT r.run_id AS "runId", r.challenge_id AS "challengeId", r.status,
      r.flag_candidate AS "flagCandidate", r.evidence, r.verified, r.confidence,
      r.steps_used AS "stepsUsed", r.stop_reason AS "stopReason", r.started_at AS "startedAt",
      r.finished_at AS "finishedAt", r.error, c.name AS "challengeName", c.category AS "challengeCategory"
     FROM results r JOIN challenges c ON c.id=r.challenge_id
     WHERE r.run_id=$1 AND r.flag_candidate IS NOT NULL AND r.verified=FALSE ORDER BY r.finished_at DESC`, [runId],
  );
  return result.rows;
}
