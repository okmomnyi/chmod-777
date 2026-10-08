/**
 * Solver loop — runs the LLM agent against one CTF challenge inside a sandbox.
 *
 * Flow:
 *  1. Build system prompt with challenge details
 *  2. Send to LLM, receive tool calls
 *  3. Execute tools in container, append results
 *  4. Repeat until stop condition met
 *  5. Return SolverResult
 */
import { join } from "path";
import { mkdirSync } from "fs";
import { getRouter } from "../providers/router.js";
import { SpendCapExceededError } from "../providers/spend-tracker.js";
import type { Message } from "../providers/types.js";
import { AGENT_TOOLS } from "./tools.js";
import { createSandbox } from "./container.js";
import { executeTool } from "./executor.js";
import type { SolverConfig, SolverResult, StopReason } from "./types.js";

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_MAX_OUTPUT_CHARS = 2048;
const SANDBOX_IMAGE = "ctf-sandbox:latest";
const MAX_TOOL_ROUNDS_IN_CONTEXT = 4;

function buildSystemPrompt(cfg: SolverConfig): string {
  const { challenge, flagRegex } = cfg;
  const connInfo = challenge.connection_info
    ? `\nConnection: ${challenge.connection_info}`
    : "";
  const files =
    challenge.files && challenge.files.length > 0
      ? `\nFiles (available at /work/files/): ${challenge.files.join(", ")}`
      : "\nNo files attached.";

  return `You are an expert CTF solver. Your goal is to find the flag for this challenge.

## Challenge
Name: ${challenge.name}
Category: ${challenge.category}
Points: ${challenge.value}
${connInfo}${files}

## Description
${challenge.description}

## Flag Format
${flagRegex
    ? `The flag matches this regex: ${flagRegex}`
    : "No flag regex was provided. Look for common PREFIX{value} flag formats or values explicitly labeled as a flag. Do not treat session cookies, JWTs, API keys, or arbitrary tokens as flags. Only report a candidate if it appears literally in tool output; do not invent one."}

## Instructions
- Use the provided tools to explore files, run commands, and interact with services.
- Challenge files are at /work/files/ (read-only). Write scratch files to /work/scratch/.
- When you find the flag in tool output, output it clearly.
- Never submit a flag to CTFd. The operator submits verified flags manually.
- Think step by step. Explain your reasoning before each tool call.
- Do NOT guess the flag — it must appear in actual tool output.
- You have a limited number of steps; be efficient.`;
}

function extractFlag(
  text: string,
  flagRegex?: string | null,
  ctfBaseUrl?: string
): string | null {
  if (flagRegex) {
    try {
      const matches = text.match(new RegExp(flagRegex, "g"));
      return matches ? matches[0] : null;
    } catch {
      return null;
    }
  }

  // Without a challenge-specific pattern, accept well-known prefixes,
  // the CTF site's own brand, or prefixes with uppercase flag-style names.
  const commonFlag = text.match(/\b[A-Za-z][A-Za-z0-9_.-]{0,31}\{[^{}\r\n]{1,256}\}/);
  if (commonFlag) {
    const prefix = commonFlag[0].slice(0, commonFlag[0].indexOf("{"));
    const normalizedPrefix = prefix.toLowerCase();
    const knownPrefixes = new Set(["flag", "ctf", "picoctf", "htb", "bugpwn"]);
    let siteBrand = false;
    try {
      const hostLabels = new URL(ctfBaseUrl ?? "").hostname.toLowerCase().split(".");
      const genericLabels = new Set(["ctf", "www", "com", "org", "net", "io", "co", "uk", "edu", "gov"]);
      siteBrand = hostLabels.some((label) => !genericLabels.has(label) && label === normalizedPrefix);
    } catch {
      // The run URL is validated before reaching the solver; continue without a host hint.
    }
    const uppercaseCount = [...prefix].filter((char) => char >= "A" && char <= "Z").length;
    if (knownPrefixes.has(normalizedPrefix) || siteBrand || uppercaseCount >= 2) {
      return commonFlag[0];
    }
  }

  const labeledFlag = text.match(/\bflag\s*(?:is\s*)?[:=]\s*[`"']?([^\s`"'<>]{4,256})/i);
  const candidate = labeledFlag?.[1];
  if (!candidate || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate)) {
    return null;
  }
  return candidate;
}

/** Keep the system/user instructions and the most recent complete tool rounds. */
function compactMessages(messages: Message[]): Message[] {
  const prefix = messages.slice(0, 2);
  const history = messages.slice(2);
  const assistantCallIndexes = history
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "assistant" && Boolean(message.tool_calls?.length))
    .map(({ index }) => index);

  if (assistantCallIndexes.length <= MAX_TOOL_ROUNDS_IN_CONTEXT) return messages;
  const firstRecentRound = assistantCallIndexes[assistantCallIndexes.length - MAX_TOOL_ROUNDS_IN_CONTEXT];
  return [...prefix, ...history.slice(firstRecentRound)];
}

export async function solveChallenge(cfg: SolverConfig): Promise<SolverResult> {
  const maxSteps = cfg.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = cfg.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  const scratchDir = join(
    process.cwd(),
    "work",
    String(cfg.challenge.id),
    "scratch"
  );
  mkdirSync(scratchDir, { recursive: true });

  const router = getRouter();
  const messages: Message[] = [
    { role: "system", content: buildSystemPrompt(cfg) },
    {
      role: "user",
      content:
        "Start solving the challenge. Use your tools to explore and find the flag.",
    },
  ];

  let flagCandidate: string | null = null;
  let evidence: string | null = null;
  let stepsUsed = 0;
  let stopReason: StopReason = "error";
  let errorMsg: string | undefined;

  const sandbox = await createSandbox({
    image: cfg.sandboxImage ?? SANDBOX_IMAGE,
    challengeId: cfg.challenge.id,
    filesDir: cfg.filesDir,
    scratchDir,
    challengeHost: cfg.challenge.host,
    runId: cfg.runId,
  });

  const deadline = Date.now() + timeoutMs;

  try {
    while (stepsUsed < maxSteps) {
      if (Date.now() > deadline) {
        stopReason = "timeout";
        break;
      }

      let response;
      try {
        response = await router.chatWithEscalation({
          messages: compactMessages(messages),
          tools: AGENT_TOOLS,
          tier: "cheap",
          maxTokens: 1024,
          runId: cfg.runId,
          challengeId: cfg.challenge.id,
        });
      } catch (err) {
        if (err instanceof SpendCapExceededError) {
          stopReason = "token_budget";
          errorMsg = (err as Error).message;
          break;
        }
        throw err;
      }

      stepsUsed++;

      // No tool calls — model returned a text answer
      if (response.toolCalls.length === 0) {
        // Only actual tool output is accepted as flag evidence.
        stopReason = "max_steps";
        break;
      }

      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        // Preserve the assistant's tool calls so providers receive the
        // matching call IDs when the tool results are sent on the next turn.
        ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
      });

      // Execute each tool call
      for (const tc of response.toolCalls) {
        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = JSON.parse(tc.function.arguments);
        } catch {
          toolArgs = {};
        }

        const result = await executeTool(
          { name: tc.function.name, arguments: toolArgs },
          sandbox,
          maxOutputChars
        );

        // Append tool result to messages
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result.output,
        });

        // Check for flag in tool output (authoritative stop condition)
        const found = extractFlag(result.output, cfg.flagRegex, cfg.ctfBaseUrl);
        if (found) {
          flagCandidate = found;
          evidence = `Tool: ${tc.function.name}\nInput: ${tc.function.arguments}\n\nOutput:\n${result.output}`;
          stopReason = "found";
        }
      }

      if (stopReason === "found") break;
    }

    if (stepsUsed >= maxSteps && stopReason === "error") {
      stopReason = "max_steps";
    }
  } catch (err) {
    stopReason = "error";
    errorMsg = (err as Error).message;
  } finally {
    await sandbox.stop();
  }

  const confidence =
    flagCandidate && stopReason === "found"
      ? evidence?.includes("[model text") ? "low" : "high"
      : "none";

  return {
    challengeId: cfg.challenge.id,
    flagCandidate,
    evidence,
    stepsUsed,
    stopReason,
    confidence,
    error: errorMsg,
  };
}
