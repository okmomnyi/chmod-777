/**
 * Base adapter for any OpenAI-compatible chat completion API.
 * OpenRouter and NVIDIA NIM extend this.
 */
import type {
  ChatOptions,
  ChatResponse,
  LLMClient,
  Message,
  ToolDefinition,
} from "./types.js";
import type { ProviderConfig } from "./config.js";

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none";
  max_tokens?: number;
  temperature?: number;
  stream: false;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function normalizeMessages(messages: Message[]): OpenAIMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return {
        role: m.role,
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      };
    }

    if (Array.isArray(m.content)) {
      // Flatten array content — OpenAI compat APIs expect plain string or
      // tool_calls on assistant messages, not content arrays.
      const textParts = m.content
        .filter((c) => typeof c === "object" && "type" in c && c.type === "text")
        .map((c) => (c as { type: "text"; text: string }).text)
        .join("\n");

      return {
        role: m.role,
        content: textParts || null,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      };
    }

    // Single content object
    const c = m.content;
    if (typeof c === "object" && "type" in c) {
      if (c.type === "text") {
        return { role: m.role, content: c.text };
      }
      if (c.type === "tool_result") {
        return {
          role: "tool",
          content: c.content,
          tool_call_id: c.tool_use_id,
        };
      }
    }

    return { role: m.role, content: String(m.content) };
  });
}

export class OpenAICompatClient implements LLMClient {
  readonly name: string;
  protected readonly config: ProviderConfig;
  protected readonly providerName: string;

  constructor(name: string, config: ProviderConfig) {
    this.name = name;
    this.providerName = name;
    this.config = config;
  }

  protected selectModel(tier: ChatOptions["tier"] = "cheap"): string {
    return this.config.models[tier];
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const model = this.selectModel(options.tier);
    const messages = normalizeMessages(options.messages);

    const body: OpenAIRequest = {
      model,
      messages,
      stream: false,
      ...(options.tools && options.tools.length > 0
        ? { tools: options.tools, tool_choice: "auto" }
        : {}),
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs
    );

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          "HTTP-Referer": "https://github.com/ctf-bot",
          "X-Title": "CTF-Bot",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }

    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(
        `${this.name} API error ${response.status}: ${errText}`
      );
      (err as NodeJS.ErrnoException).code = String(response.status);
      throw err;
    }

    const data = (await response.json()) as OpenAIResponse;
    const choice = data.choices[0];
    if (!choice) throw new Error(`${this.name}: empty choices in response`);

    return {
      id: data.id,
      model: data.model,
      content: choice.message.content ?? null,
      toolCalls: choice.message.tool_calls ?? [],
      tokensUsed: data.usage?.total_tokens ?? 0,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      finishReason: choice.finish_reason,
    };
  }
}
