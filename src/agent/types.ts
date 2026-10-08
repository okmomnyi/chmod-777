import type { ChallengeDetail } from "../platforms/ctfd.js";

export interface SolverConfig {
  /** The challenge to solve */
  challenge: ChallengeDetail;
  /** CTFd base URL (needed for http_request context) */
  ctfBaseUrl: string;
  /** Regex pattern for the CTF's flag format, e.g. "flag\\{[^}]+\\}" */
  flagRegex: string;
  /** Docker image to use for the sandbox */
  sandboxImage: string;
  /** Absolute path to the directory containing challenge files (mounted read-only) */
  filesDir: string;
  /** Run identifier for spend tracking */
  runId: string;
  /** Max agent steps before giving up */
  maxSteps?: number;
  /** Wall-clock timeout in milliseconds */
  timeoutMs?: number;
  /** Max output chars to feed back to LLM per tool call */
  maxOutputChars?: number;
}

export interface SolverResult {
  challengeId: number;
  /** The flag candidate found (or null if not found) */
  flagCandidate: string | null;
  /** The exact command + output that produced the flag */
  evidence: string | null;
  stepsUsed: number;
  /** "found" | "timeout" | "max_steps" | "token_budget" | "error" */
  stopReason: StopReason;
  confidence: "high" | "low" | "none";
  error?: string;
}

export type StopReason =
  | "found"
  | "timeout"
  | "max_steps"
  | "token_budget"
  | "error";

export interface ToolCallResult {
  toolName: string;
  output: string;
  truncated: boolean;
}
