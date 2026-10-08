// ─── LLM Provider Types ────────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCallContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type MessageContent =
  | string
  | TextContent
  | ToolCallContent
  | ToolResultContent;

export interface Message {
  role: MessageRole;
  content: MessageContent | MessageContent[];
  /** Present when role === "tool" */
  tool_call_id?: string;
  name?: string;
}

// OpenAI-compatible tool definition
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
  /** Total tokens used in this call */
  tokensUsed: number;
  promptTokens: number;
  completionTokens: number;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | string;
}

/** Tier controls which model class to use */
export type ModelTier = "cheap" | "smart";

export interface ChatOptions {
  messages: Message[];
  tools?: ToolDefinition[];
  tier?: ModelTier;
  /** Max tokens for the completion */
  maxTokens?: number;
  temperature?: number;
  /** Used by the router to track spend against a cap */
  runId?: string;
  challengeId?: number;
}

/** Core interface every provider adapter must implement */
export interface LLMClient {
  chat(options: ChatOptions): Promise<ChatResponse>;
  readonly name: string;
}
