import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { InvestigationEngine } from '../src/core/engine/investigation-engine.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { ToolPolicy } from '../src/core/policy/policy.js';
import { MockAIProvider } from '../src/core/providers/mock.js';
import { MockDiagnosticBackend } from '../src/diagnostics/mock.js';
import { createStandardTools } from '../src/diagnostics/tools.js';
import type { DiagnosticTool } from '../src/core/tools/types.js';

describe('OpsPilot InvestigationEngine (Milestone 1)', () => {
  let registry: ToolRegistry;
  let policy: ToolPolicy;
  let backend: MockDiagnosticBackend;
  let provider: MockAIProvider;

  beforeEach(() => {
    registry = new ToolRegistry();
    backend = new MockDiagnosticBackend('crashloop-missing-env');
    const tools = createStandardTools(backend);
    for (const tool of tools) {
      registry.register(tool);
    }
    policy = new ToolPolicy(registry);
    provider = new MockAIProvider({ scenarioId: 'crashloop-missing-env' });
  });

  it('successfully investigates Scenario 1: CrashLoopBackOff missing env', async () => {
    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Why is auth-service restarting?');

    expect(run.status).toBe('COMPLETED');
    expect(run.toolCallCount).toBe(2);
    expect(run.evidence.length).toBe(2);
    expect(run.evidence[0]?.toolName).toBe('get_pod_status');
    expect(run.evidence[1]?.toolName).toBe('get_container_logs');

    // Verify report
    expect(run.report).toBeDefined();
    expect(run.report?.summary).toContain('JWT_SECRET_KEY');
    expect(run.report?.observedFacts.length).toBe(2);
    expect(run.report?.hypotheses[0]?.statement).toContain('JWT_SECRET_KEY');
    expect(run.report?.confidence).toBe('high');
  });

  it('successfully investigates Scenario 2: OOMKilled', async () => {
    backend.setScenario('oom-killed');
    provider.setScenario('oom-killed');

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Why did image-processor terminate?');

    expect(run.status).toBe('COMPLETED');
    expect(run.toolCallCount).toBe(2);
    expect(run.evidence.length).toBe(2);
    expect(run.report?.summary).toContain('OOMKilled');
    expect(run.report?.observedFacts[0]?.statement).toContain('exitCode 137');
  });

  it('successfully investigates Scenario 3: Failed readiness probe', async () => {
    backend.setScenario('failed-readiness-probe');
    provider.setScenario('failed-readiness-probe');

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Why is payment-gateway 0/1 ready?');

    expect(run.status).toBe('COMPLETED');
    expect(run.toolCallCount).toBe(2);
    expect(run.evidence.length).toBe(2);
    expect(run.report?.summary).toContain('readiness health check');
    expect(run.report?.recommendations.length).toBeGreaterThan(0);
  });

  it('enforces policy denial and halts if model attempts unauthorized namespace', async () => {
    provider.setScriptedResponses([
      {
        content: 'Inspecting kube-system pods...',
        toolCalls: [
          {
            id: 'call_unauth',
            name: 'get_pod_status',
            arguments: { namespace: 'kube-system', podName: 'core-dns' },
          },
        ],
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Check cluster health', {
      allowedNamespaces: ['default', 'staging'],
    });

    expect(run.status).toBe('POLICY_DENIAL');
    expect(run.terminationReason).toContain("Namespace 'kube-system' is not in the allowed namespaces");
    expect(run.evidence.length).toBe(0); // Unauthorized tool NEVER executed
    const auditDenials = run.auditLog.filter((a) => a.type === 'POLICY_DENIAL');
    expect(auditDenials.length).toBe(1);
  });

  it('rejects unknown tools without executing anything', async () => {
    provider.setScriptedResponses([
      {
        content: 'Attempting to run unauthorized tool...',
        toolCalls: [
          {
            id: 'call_rogue',
            name: 'delete_deployment',
            arguments: { namespace: 'default' },
          },
        ],
      },
      {
        content: 'Tool failed as expected. Concluding investigation.',
        report: {
          id: 'rep_rogue',
          summary: 'Attempted unsupported operation.',
          observedFacts: [],
          hypotheses: [],
          recommendations: [],
          confidence: 'low',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Do cleanup');

    expect(run.status).toBe('COMPLETED');
    expect(run.evidence.length).toBe(0); // delete_deployment was never executed
    const denialLog = run.auditLog.find((a) => a.type === 'POLICY_DENIAL');
    expect(denialLog?.details['code']).toBe('UNKNOWN_TOOL');
  });

  it('validates tool arguments at runtime and rejects invalid schemas', async () => {
    provider.setScriptedResponses([
      {
        content: 'Passing invalid arguments...',
        toolCalls: [
          {
            id: 'call_invalid',
            name: 'get_pod_status',
            arguments: { namespace: '' }, // empty string violates z.string().min(1)
          },
        ],
      },
      {
        content: 'Got validation error, completing.',
        report: {
          id: 'rep_invalid',
          summary: 'Invalid arguments prevented execution.',
          observedFacts: [],
          hypotheses: [],
          recommendations: [],
          confidence: 'low',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Check pods');

    expect(run.status).toBe('COMPLETED');
    expect(run.evidence.length).toBe(0);
    const denialLog = run.auditLog.find((a) => a.type === 'POLICY_DENIAL');
    expect(denialLog?.details['code']).toBe('INVALID_ARGUMENTS');
  });

  it('safely handles per-tool execution timeouts', async () => {
    const hangingTool: DiagnosticTool<{ namespace: string }> = {
      definition: {
        name: 'hanging_tool',
        description: 'Simulates a hanging diagnostic call',
        parameters: z.object({ namespace: z.string() }),
      },
      isReadOnly: true,
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { success: true, executionTimeMs: 500 };
      },
    };
    registry.register(hangingTool);

    provider.setScriptedResponses([
      {
        toolCalls: [
          {
            id: 'call_hang',
            name: 'hanging_tool',
            arguments: { namespace: 'default' },
          },
        ],
      },
      {
        content: 'Hanging tool failed as expected.',
        report: {
          id: 'rep_timeout',
          summary: 'Tool timed out.',
          observedFacts: [],
          hypotheses: [],
          recommendations: [],
          confidence: 'low',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Run slow diagnostic', {
      perToolTimeoutMs: 50, // 50ms timeout < 500ms execution
    });

    expect(run.status).toBe('COMPLETED');
    expect(run.evidence.length).toBe(0);
    const resultLog = run.auditLog.find((a) => a.type === 'TOOL_RESULT');
    expect(resultLog?.details['success']).toBe(false);
    expect(resultLog?.details['error']).toContain('timed out after 50ms');
  });

  it('terminates with BUDGET_EXHAUSTED when exceeding maxToolCalls', async () => {
    // Return an endless sequence of tool calls
    provider.setScriptedResponses([
      {
        toolCalls: [
          { id: 'c1', name: 'get_pod_status', arguments: { namespace: 'default', podName: 'auth-service' } },
        ],
      },
      {
        toolCalls: [
          { id: 'c2', name: 'get_pod_status', arguments: { namespace: 'default', podName: 'auth-service' } },
        ],
      },
      {
        toolCalls: [
          { id: 'c3', name: 'get_pod_status', arguments: { namespace: 'default', podName: 'auth-service' } },
        ],
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Investigate endlessly', {
      maxToolCalls: 2,
    });

    expect(run.status).toBe('BUDGET_EXHAUSTED');
    expect(run.toolCallCount).toBe(2);
    expect(run.terminationReason).toContain('Exceeded maximum tool call budget of 2');
  });

  it('rejects registering non-read-only tools into the registry', () => {
    const maliciousTool = {
      definition: {
        name: 'delete_pod',
        description: 'Deletes a pod',
        parameters: z.object({ namespace: z.string() }),
      },
      isReadOnly: false,
      execute: async () => ({ success: true, executionTimeMs: 0 }),
    };

    expect(() => registry.register(maliciousTool as any)).toThrow(
      "OpsPilot only permits read-only tools"
    );
  });
});
