/**
 * In-memory spend tracker.
 * Tracks token usage per run and per challenge, enforcing caps
 * defined in providers.json before the agent loop even fires.
 */

interface SpendEntry {
  tokens: number;
}

export class SpendTracker {
  private readonly perRunCap: number;
  private readonly perChallengeCap: number;

  private runSpend = new Map<string, SpendEntry>();
  private challengeSpend = new Map<string, SpendEntry>();

  constructor(perRunCap: number, perChallengeCap: number) {
    this.perRunCap = perRunCap;
    this.perChallengeCap = perChallengeCap;
  }

  private runKey(runId: string): string {
    return `run:${runId}`;
  }

  private challengeKey(runId: string, challengeId: number): string {
    return `${runId}:challenge:${challengeId}`;
  }

  /**
   * Check whether a new call is allowed before making it.
   * Throws if over cap so the caller can decide what to do.
   */
  checkCaps(runId: string, challengeId?: number): void {
    const runEntry = this.runSpend.get(this.runKey(runId));
    if (runEntry && runEntry.tokens >= this.perRunCap) {
      throw new SpendCapExceededError(
        `Run ${runId} exceeded per-run token cap (${this.perRunCap})`
      );
    }

    if (challengeId !== undefined) {
      const cKey = this.challengeKey(runId, challengeId);
      const cEntry = this.challengeSpend.get(cKey);
      if (cEntry && cEntry.tokens >= this.perChallengeCap) {
        throw new SpendCapExceededError(
          `Challenge ${challengeId} in run ${runId} exceeded per-challenge token cap (${this.perChallengeCap})`
        );
      }
    }
  }

  record(runId: string, tokens: number, challengeId?: number): void {
    const rk = this.runKey(runId);
    const existing = this.runSpend.get(rk) ?? { tokens: 0 };
    this.runSpend.set(rk, { tokens: existing.tokens + tokens });

    if (challengeId !== undefined) {
      const ck = this.challengeKey(runId, challengeId);
      const cExisting = this.challengeSpend.get(ck) ?? { tokens: 0 };
      this.challengeSpend.set(ck, { tokens: cExisting.tokens + tokens });
    }
  }

  getRunTokens(runId: string): number {
    return this.runSpend.get(this.runKey(runId))?.tokens ?? 0;
  }

  getChallengeTokens(runId: string, challengeId: number): number {
    return (
      this.challengeSpend.get(this.challengeKey(runId, challengeId))?.tokens ??
      0
    );
  }

  resetRun(runId: string): void {
    // Remove run-level entry
    this.runSpend.delete(this.runKey(runId));
    // Remove all challenge entries for this run
    for (const key of this.challengeSpend.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.challengeSpend.delete(key);
      }
    }
  }
}

export class SpendCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendCapExceededError";
  }
}
