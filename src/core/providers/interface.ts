import type { ToolDefinition } from '../tools/types.js';
import type { IncidentReport } from '../models/report.js';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface BaseMessage {
  role: MessageRole;
}

export interface SystemMessage extends BaseMessage {
  role: 'system';
  content: string;
}

export interface UserMessage extends BaseMessage {
  role: 'user';
  content: string;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  content?: string;
  toolCalls?: ToolCallRequest[];
}

export interface ToolResultMessage extends BaseMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}

export type AIMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AIResponse {
  content?: string;
  toolCalls?: ToolCallRequest[];
  report?: IncidentReport;
  usage?: TokenUsage;
}

export interface AIProvider {
  readonly id: string;
  chat(options: {
    messages: AIMessage[];
    tools: ToolDefinition[];
    abortSignal?: AbortSignal;
  }): Promise<AIResponse>;
}
