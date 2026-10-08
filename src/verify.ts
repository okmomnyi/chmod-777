/**
 * Flag verifier.
 *
 * A result is "verified" iff:
 *  1. flagCandidate is non-null
 *  2. flagCandidate matches the flag regex
 *  3. evidence actually contains the flagCandidate string
 *
 * Results that fail any check are marked "unverified" and kept separate.
 */
import type { SolverResult } from "./agent/types.js";

export type VerifiedFlag = {
  verified: true;
  challengeId: number;
  flag: string;
  evidence: string;
  confidence: "high" | "low";
};

export type UnverifiedFlag = {
  verified: false;
  challengeId: number;
  flag: string | null;
  reason: string;
  evidence: string | null;
};

export type VerifyResult = VerifiedFlag | UnverifiedFlag;

export function verifyResult(
  result: SolverResult,
  flagRegex: string
): VerifyResult {
  const { challengeId, flagCandidate, evidence } = result;

  if (!flagCandidate) {
    return {
      verified: false,
      challengeId,
      flag: null,
      reason: "no flag candidate found",
      evidence: null,
    };
  }

  let re: RegExp;
  try {
    re = new RegExp(flagRegex);
  } catch (e) {
    return {
      verified: false,
      challengeId,
      flag: flagCandidate,
      reason: `invalid flagRegex: ${(e as Error).message}`,
      evidence,
    };
  }

  if (!re.test(flagCandidate)) {
    return {
      verified: false,
      challengeId,
      flag: flagCandidate,
      reason: `flag "${flagCandidate}" does not match regex ${flagRegex}`,
      evidence,
    };
  }

  if (!evidence || !evidence.includes(flagCandidate)) {
    return {
      verified: false,
      challengeId,
      flag: flagCandidate,
      reason: "flag not found in evidence string",
      evidence,
    };
  }

  return {
    verified: true,
    challengeId,
    flag: flagCandidate,
    evidence,
    confidence: result.confidence === "high" ? "high" : "low",
  };
}
