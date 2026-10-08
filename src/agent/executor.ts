/**
 * Tool executor — dispatches LLM tool calls to actual container operations.
 * Each tool has its own input validation; invalid calls return an error string
 * rather than throwing so the agent can recover.
 */
import type { SandboxContainer } from "./container.js";

export interface ToolInput {
  name: string;
  arguments: Record<string, unknown>;
}

const MAX_OUTPUT_CHARS = 4096;

function truncate(s: string, limit = MAX_OUTPUT_CHARS): { output: string; truncated: boolean } {
  if (s.length <= limit) return { output: s, truncated: false };
  return {
    output: s.slice(0, limit) + `\n... [truncated: ${s.length - limit} more chars]`,
    truncated: true,
  };
}

export async function executeTool(
  tool: ToolInput,
  container: SandboxContainer,
  maxOutputChars = MAX_OUTPUT_CHARS
): Promise<{ output: string; truncated: boolean }> {
  const { name, arguments: args } = tool;

  try {
    switch (name) {
      case "run_shell": {
        const cmd = String(args.cmd ?? "");
        if (!cmd.trim()) {
          return { output: "Error: cmd is required", truncated: false };
        }
        const timeout = typeof args.timeout === "number" ? args.timeout : 30;
        const raw = await container.exec(cmd, timeout);
        return truncate(raw, maxOutputChars);
      }

      case "read_file": {
        const path = String(args.path ?? "");
        if (!path.startsWith("/")) {
          return {
            output: "Error: path must be absolute",
            truncated: false,
          };
        }

        // Try reading as text first; fall back to base64 for binary
        const raw = await container.exec(
          `file -b "${path}" && cat "${path}"`,
          15
        );

        // Crude binary detection: if file output contains 'data' or we got
        // non-UTF-8, re-read as base64
        const isBinary =
          /^(data|ELF|PE32|MS-DOS|PNG|JPEG|GIF|PDF|Zip|gzip)/i.test(raw);

        if (isBinary) {
          const b64 = await container.exec(`base64 "${path}"`, 15);
          return truncate(`[base64]\n${b64}`, maxOutputChars);
        }

        return truncate(raw, maxOutputChars);
      }

      case "write_file": {
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");

        if (!path.startsWith("/work/scratch/")) {
          return {
            output: "Error: write_file path must be under /work/scratch/",
            truncated: false,
          };
        }

        // Write via echo to avoid shell escaping nightmares — use printf for
        // content with special chars
        const escaped = content.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
        const dirCmd = `mkdir -p "$(dirname '${path}')"`;
        const writeCmd = `printf '%s' '${escaped}' > '${path}'`;
        await container.exec(`${dirCmd} && ${writeCmd}`, 15);
        return { output: `Wrote ${content.length} bytes to ${path}`, truncated: false };
      }

      case "http_request": {
        const url = String(args.url ?? "");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return { output: "Error: URL must start with http:// or https://", truncated: false };
        }

        const method = String(args.method ?? "GET").toUpperCase();
        const headers = (args.headers as Record<string, string>) ?? {};
        const body = args.body !== undefined ? String(args.body) : undefined;

        const response = await fetch(url, {
          method,
          headers,
          body: body ?? undefined,
          redirect: "follow",
        });

        const responseText = await response.text();
        const headerLines = [...response.headers.entries()]
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");

        const combined =
          `HTTP ${response.status} ${response.statusText}\n` +
          `${headerLines}\n\n` +
          responseText;

        return truncate(combined, maxOutputChars);
      }

      default:
        return { output: `Error: unknown tool "${name}"`, truncated: false };
    }
  } catch (err) {
    return {
      output: `Error executing ${name}: ${(err as Error).message}`,
      truncated: false,
    };
  }
}
