import type { AIProvider, AIMessage, ToolCallRequest } from '../providers/interface.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolPolicy } from '../policy/policy.js';
import type {
  InvestigationRun,
  InvestigationOptions,
  InvestigationStatus,
  AuditEntry,
} from '../models/investigation.js';
import type { IncidentReport, Evidence } from '../models/report.js';

export interface EngineDependencies {
  provider: AIProvider;
  registry: ToolRegistry;
  policy: ToolPolicy;
}

export class InvestigationEngine {
  private provider: AIProvider;
  private registry: ToolRegistry;
  private policy: ToolPolicy;

  constructor(deps: EngineDependencies) {
    this.provider = deps.provider;
    this.registry = deps.registry;
    this.policy = deps.policy;
  }

  async investigate(
    prompt: string,
    options: InvestigationOptions = {},
    abortSignal?: AbortSignal
  ): Promise<InvestigationRun> {
    const startedAt = Date.now();
    const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const maxToolCalls = options.maxToolCalls ?? 10;
    const maxDurationMs = options.maxDurationMs ?? 60_000;
    const perToolTimeoutMs = options.perToolTimeoutMs ?? 5_000;
    const maxOutputSizeBytes = options.maxOutputSizeBytes ?? 32 * 1024;
    const allowedNamespaces = options.allowedNamespaces;

    const auditLog: AuditEntry[] = [];
    const evidenceList: Evidence[] = [];
    let toolCallCount = 0;
    let status: InvestigationStatus = 'INVESTIGATING';
    let terminationReason: string | undefined;
    let finalReport: IncidentReport | undefined;

    const addAudit = (type: AuditEntry['type'], details: Record<string, unknown>) => {
      const entry: AuditEntry = { timestamp: Date.now(), type, details };
      auditLog.push(entry);
      options.onProgress?.(entry);
    };

    addAudit('STATUS_CHANGE', { status: 'INVESTIGATING', prompt, options });

    const targetNamespace = options.targetNamespace || 'default';

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: `You are OpsPilot, an expert AI DevOps incident investigator.
Your goal is to investigate infrastructure failures using read-only diagnostic tools.
Target Kubernetes Namespace: "${targetNamespace}". Unless explicitly instructed otherwise by the user, you MUST pass namespace="${targetNamespace}" in your diagnostic tool calls.
Batch your diagnostic queries when possible (e.g. calling get_pod_status, get_pod_events together) to minimize investigation latency.
Ground all conclusions strictly in collected evidence. Do not guess or fabricate state.
Distinguish clearly between observed facts, hypotheses, and recommendations.`,
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    try {
      while (status === 'INVESTIGATING') {
        // 1. Check overall investigation timeout
        if (Date.now() - startedAt > maxDurationMs) {
          status = 'TIMEOUT';
          terminationReason = `Investigation exceeded max duration of ${maxDurationMs}ms`;
          addAudit('STATUS_CHANGE', { status, terminationReason });
          break;
        }

        // 2. Check cancellation
        if (abortSignal?.aborted) {
          status = 'CANCELLED';
          terminationReason = 'Investigation cancelled by user';
          addAudit('STATUS_CHANGE', { status, terminationReason });
          break;
        }

        // 3. Call AI Provider
        const availableTools = this.registry.getDefinitions();
        const aiResponse = await this.provider.chat({
          messages,
          tools: availableTools,
          abortSignal,
        });

        // If provider returned a final report or concluded
        if (aiResponse.report) {
          finalReport = this.validateReportEvidence(aiResponse.report, evidenceList);
          status = 'COMPLETED';
          terminationReason = 'Investigation concluded with final incident report';
          addAudit('STATUS_CHANGE', { status, terminationReason, reportId: finalReport.id });
          break;
        }

        // If no tool calls requested
        if (!aiResponse.toolCalls || aiResponse.toolCalls.length === 0) {
          status = 'COMPLETED';
          terminationReason = 'Model completed response without requesting further tools';
          // Synthesize minimal report if none provided
          if (!finalReport && aiResponse.content) {
            finalReport = {
              id: `rep_${Date.now()}`,
              summary: aiResponse.content,
              observedFacts: [],
              hypotheses: [],
              recommendations: [],
              confidence: 'medium',
            };
          }
          addAudit('STATUS_CHANGE', { status, terminationReason });
          break;
        }

        // Add assistant's message to conversation
        messages.push({
          role: 'assistant',
          content: aiResponse.content,
          toolCalls: aiResponse.toolCalls,
        });

        // 4. Process tool calls
        for (const toolCall of aiResponse.toolCalls) {
          // Check tool budget
          if (toolCallCount >= maxToolCalls) {
            status = 'BUDGET_EXHAUSTED';
            terminationReason = `Exceeded maximum tool call budget of ${maxToolCalls}`;
            addAudit('STATUS_CHANGE', { status, terminationReason });
            break;
          }

          // Route namespace to targetNamespace if user specified a non-default namespace and model omitted or defaulted it
          if (options.targetNamespace && options.targetNamespace !== 'default') {
            if (!toolCall.arguments['namespace'] || toolCall.arguments['namespace'] === 'default') {
              toolCall.arguments['namespace'] = options.targetNamespace;
            }
          }

          toolCallCount++;
          addAudit('TOOL_REQUEST', {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          });

          // Policy evaluation (validates tool exists, is read-only, valid schema, and allowed namespace)
          const policyCheck = this.policy.evaluateCall(toolCall.name, toolCall.arguments, {
            allowedNamespaces,
            maxOutputSizeBytes,
            perToolTimeoutMs,
          });

          if (!policyCheck.allowed) {
            addAudit('POLICY_DENIAL', {
              id: toolCall.id,
              name: toolCall.name,
              code: policyCheck.code,
              message: policyCheck.message,
            });

            // If it's an explicit namespace violation, mark policy denial termination
            if (policyCheck.code === 'POLICY_DENIAL' || policyCheck.code === 'NOT_READ_ONLY') {
              status = 'POLICY_DENIAL';
              terminationReason = policyCheck.message;
              break;
            }

            // For invalid arguments or unknown tools, feedback to conversation
            messages.push({
              role: 'tool',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: JSON.stringify({ error: policyCheck.message }),
              isError: true,
            });
            continue;
          }

          // Execute tool with timeout and cooperative cancellation
          const tool = policyCheck.tool!;
          const validatedParams = policyCheck.validatedParams;

          let toolOutput: unknown;
          let toolError: string | undefined;
          let isError = false;

          const toolAbortController = new AbortController();
          const onParentAbort = () => toolAbortController.abort();
          if (abortSignal) {
            if (abortSignal.aborted) {
              toolAbortController.abort();
            } else {
              abortSignal.addEventListener('abort', onParentAbort, { once: true });
            }
          }

          let timeoutId: NodeJS.Timeout | undefined;
          try {
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                toolAbortController.abort(); // Signal tool to cancel underlying work
                reject(new Error(`Tool '${toolCall.name}' timed out after ${perToolTimeoutMs}ms`));
              }, perToolTimeoutMs);
            });

            const executionPromise = tool.execute(validatedParams, {
              namespace: validatedParams.namespace,
              abortSignal: toolAbortController.signal,
            });

            const result = await Promise.race([executionPromise, timeoutPromise]);

            if (result.success) {
              const sanitized = this.policy.enforceOutputLimit(result.data, maxOutputSizeBytes);
              toolOutput = sanitized.output;

              evidenceList.push({
                id: toolCall.id,
                toolName: toolCall.name,
                params: validatedParams,
                output: toolOutput,
                timestamp: Date.now(),
              });
            } else {
              isError = true;
              toolError = result.error;
            }
          } catch (err: any) {
            isError = true;
            toolError = err.message || String(err);
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (abortSignal) {
              abortSignal.removeEventListener('abort', onParentAbort);
            }
          }

          addAudit('TOOL_RESULT', {
            id: toolCall.id,
            name: toolCall.name,
            success: !isError,
            error: toolError,
          });

          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: JSON.stringify(isError ? { error: toolError } : toolOutput),
            isError,
          });
        }
      }
    } catch (err: any) {
      if (abortSignal?.aborted || err.message?.includes('aborted')) {
        status = 'CANCELLED';
        terminationReason = 'Investigation cancelled by user';
        addAudit('STATUS_CHANGE', { status, terminationReason });
      } else {
        status = 'FAILED';
        terminationReason = err.message || String(err);
        addAudit('ERROR', { error: terminationReason });
      }
    }

    const completedAt = Date.now();

    return {
      id: runId,
      prompt,
      namespace: targetNamespace,
      status,
      startedAt,
      completedAt,
      terminationReason,
      toolCallCount,
      evidence: evidenceList,
      report: finalReport,
      auditLog,
    };
  }

  private validateReportEvidence(report: IncidentReport, evidenceList: Evidence[]): IncidentReport {
    const validEvidenceIds = new Set<string>();
    for (const e of evidenceList) {
      validEvidenceIds.add(e.id);
      validEvidenceIds.add(e.toolName);
    }
    const unsupportedFacts: string[] = [];

    const validatedFacts = report.observedFacts.map((fact) => {
      const validRefs = fact.evidenceRef.filter((ref) => validEvidenceIds.has(ref));
      if (validRefs.length === 0 && fact.evidenceRef.length > 0) {
        unsupportedFacts.push(fact.statement);
      }
      return {
        ...fact,
        evidenceRef: validRefs,
      };
    });

    let uncertaintyNotes = report.uncertaintyNotes;
    let confidence = report.confidence;

    if (unsupportedFacts.length > 0) {
      const note = `Warning: ${unsupportedFacts.length} observed fact(s) referenced invalid or nonexistent evidence IDs and were unlinked.`;
      uncertaintyNotes = uncertaintyNotes ? `${uncertaintyNotes} | ${note}` : note;
      confidence = 'low';
    }

    return {
      ...report,
      observedFacts: validatedFacts,
      confidence,
      uncertaintyNotes,
    };
  }
}
