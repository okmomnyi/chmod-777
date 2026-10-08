/**
 * Tool definitions exposed to the LLM agent.
 * These match the OpenAI function-calling schema.
 */
import type { ToolDefinition } from "../providers/types.js";

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Execute a shell command inside the sandbox container. " +
        "Working directory is /work. Challenge files are at /work/files/ (read-only). " +
        "You may write scratch files to /work/scratch/. " +
        "Avoid commands that produce huge output — pipe through head/tail if needed.",
      parameters: {
        type: "object",
        properties: {
          cmd: {
            type: "string",
            description: "The shell command to run (executed via bash -c).",
          },
          timeout: {
            type: "number",
            description:
              "Optional timeout in seconds (default: 30, max: 120).",
          },
        },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the container filesystem. " +
        "Challenge files live at /work/files/. " +
        "Returns base64 for binary files, UTF-8 text otherwise.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file inside the container.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file inside the container at /work/scratch/. " +
        "Useful for creating Python scripts, payloads, etc.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute path inside the container (must be under /work/scratch/).",
          },
          content: {
            type: "string",
            description: "File content (text).",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description:
        "Make an HTTP/HTTPS request to the challenge server. " +
        "Use this for web challenges, API endpoints, or any network interaction. " +
        "NOTE: outbound network is restricted to the challenge host only.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full URL to request.",
          },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
            description: "HTTP method (default: GET).",
          },
          headers: {
            type: "object",
            description: "Optional HTTP headers as key-value pairs.",
            additionalProperties: { type: "string" },
          },
          body: {
            type: "string",
            description: "Optional request body (for POST/PUT/PATCH).",
          },
        },
        required: ["url"],
      },
    },
  },
];
