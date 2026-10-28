import type { z } from 'zod';

export interface ToolDefinition<TParams = any> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
}

export interface ToolExecutionContext {
  namespace?: string;
  abortSignal?: AbortSignal;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  truncated?: boolean;
  executionTimeMs: number;
}

export interface DiagnosticTool<TParams = any, TResult = any> {
  readonly definition: ToolDefinition<TParams>;
  readonly isReadOnly: true;
  execute(params: TParams, context: ToolExecutionContext): Promise<ToolResult<TResult>>;
}
