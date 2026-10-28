import type { DiagnosticTool } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface PolicyCheckResult {
  allowed: boolean;
  code?: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'POLICY_DENIAL' | 'NOT_READ_ONLY';
  message: string;
  tool?: DiagnosticTool;
  validatedParams?: any;
}

export interface PolicyOptions {
  allowedNamespaces?: string[];
  investigationNamespace?: string;
  maxOutputSizeBytes?: number;
  perToolTimeoutMs?: number;
}

export class ToolPolicy {
  constructor(private registry: ToolRegistry) {}

  evaluateCall(
    toolName: string,
    rawParams: unknown,
    options: PolicyOptions = {}
  ): PolicyCheckResult {
    // 1. Check tool existence
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        allowed: false,
        code: 'UNKNOWN_TOOL',
        message: `Tool '${toolName}' is not registered or supported.`,
      };
    }

    // 2. Enforce read-only constraint
    if (!tool.isReadOnly) {
      return {
        allowed: false,
        code: 'NOT_READ_ONLY',
        message: `Tool '${toolName}' violates read-only policy.`,
      };
    }

    // 3. Schema validation with Zod
    const parseResult = tool.definition.parameters.safeParse(rawParams);
    if (!parseResult.success) {
      const issueDetails = parseResult.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(', ');
      return {
        allowed: false,
        code: 'INVALID_ARGUMENTS',
        message: `Invalid arguments for tool '${toolName}': ${issueDetails}`,
      };
    }

    const validatedParams = parseResult.data as Record<string, unknown>;

    // 4. Namespace authorization check
    const targetNamespace = (validatedParams['namespace'] as string | undefined) ?? options.investigationNamespace;

    if (options.allowedNamespaces && options.allowedNamespaces.length > 0) {
      if (targetNamespace && !options.allowedNamespaces.includes(targetNamespace)) {
        return {
          allowed: false,
          code: 'POLICY_DENIAL',
          message: `Namespace '${targetNamespace}' is not in the allowed namespaces: [${options.allowedNamespaces.join(', ')}].`,
        };
      }
    }

    return {
      allowed: true,
      message: 'Tool call permitted.',
      tool,
      validatedParams,
    };
  }

  enforceOutputLimit(data: unknown, maxSizeBytes: number = 32 * 1024): { output: unknown; truncated: boolean } {
    try {
      const str = JSON.stringify(data);
      const byteLength = Buffer.byteLength(str, 'utf8');
      if (byteLength <= maxSizeBytes) {
        return { output: data, truncated: false };
      }

      if (typeof data === 'string') {
        const truncatedStr = data.slice(0, Math.floor(maxSizeBytes * 0.9)) + '\n... [TRUNCATED DUE TO SIZE LIMIT]';
        return { output: truncatedStr, truncated: true };
      }

      // If array or object, convert to truncated string representation
      const truncatedStr = str.slice(0, Math.floor(maxSizeBytes * 0.9)) + '... [TRUNCATED]';
      return {
        output: {
          _truncated: true,
          originalSizeBytes: byteLength,
          preview: truncatedStr,
        },
        truncated: true,
      };
    } catch {
      return { output: data, truncated: false };
    }
  }
}
