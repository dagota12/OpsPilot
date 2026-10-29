import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { InvestigationEngine } from '../src/core/engine/investigation-engine.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { ToolPolicy } from '../src/core/policy/policy.js';
import { MockAIProvider } from '../src/core/providers/mock.js';
import { MockDiagnosticBackend } from '../src/diagnostics/mock.js';
import { createStandardTools } from '../src/diagnostics/tools.js';

describe('Adaptive Investigation & get_workload_config (Quality & Regression)', () => {
  let registry: ToolRegistry;
  let policy: ToolPolicy;
  let backend: MockDiagnosticBackend;
  let provider: MockAIProvider;

  beforeEach(() => {
    registry = new ToolRegistry();
    backend = new MockDiagnosticBackend('pending-migration-job');
    const tools = createStandardTools(backend);
    for (const tool of tools) {
      registry.register(tool);
    }
    policy = new ToolPolicy(registry);
    provider = new MockAIProvider({ scenarioId: 'pending-migration-job' });
  });

  it('executes an adaptive multi-step investigation where pod status leads to inspecting parent Job config', async () => {
    // Step 1: Model inspects pod status
    // Step 2: Pod reveals phase: 'Pending' and ownerReference Job: 'migration-job'
    // Step 3: Model adaptively requests get_pod_events and get_workload_config for Job
    // Step 4: Model concludes with grounded report
    provider.setScriptedResponses([
      {
        content: 'Checking pod status first...',
        toolCalls: [
          {
            id: 'call_pod_1',
            name: 'get_pod_status',
            arguments: { namespace: 'default', podName: 'migration-job-wprdn' },
          },
        ],
      },
      {
        content: 'Pod is Pending. Now inspecting warning events and parent Job specification adaptively...',
        toolCalls: [
          {
            id: 'call_events_2',
            name: 'get_pod_events',
            arguments: { namespace: 'default', podName: 'migration-job-wprdn' },
          },
          {
            id: 'call_job_3',
            name: 'get_workload_config',
            arguments: { namespace: 'default', kind: 'job', name: 'migration-job' },
          },
        ],
      },
      {
        content: 'Root cause identified.',
        report: {
          id: 'rep_migration_01',
          summary: 'Migration job is blocked in Pending because container image zcinema-api:jenkins-26 is missing locally with imagePullPolicy Never.',
          observedFacts: [
            {
              id: 'fact_pod_pending',
              statement: 'migration-job-wprdn pod is in Pending phase with ContainersNotReady condition.',
              evidenceRef: ['call_pod_1'],
            },
            {
              id: 'fact_err_pull',
              statement: 'ErrImageNeverPull event fired: image not present with pull policy Never.',
              evidenceRef: ['call_events_2'],
            },
            {
              id: 'fact_job_spec',
              statement: 'Job migration-job defines container migrate with imagePullPolicy Never.',
              evidenceRef: ['call_job_3'],
            },
          ],
          hypotheses: [
            {
              id: 'hypo_1',
              statement: 'The migration Job cannot start because the target image is not present on the node cache and pull policy forbids pulling from a registry.',
              likelihood: 'high',
              reasoning: 'Corroborated by Job workload spec setting imagePullPolicy Never alongside pod event ErrImageNeverPull.',
            },
          ],
          recommendations: [
            'Push or load the container image to the cluster worker node, or update the Job imagePullPolicy to IfNotPresent.',
          ],
          confidence: 'high',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Why is the migration job pod pending?');

    expect(run.status).toBe('COMPLETED');
    expect(run.toolCallCount).toBe(3);
    expect(run.evidence.length).toBe(3);

    // Verify tools were called in adaptive order
    expect(run.evidence[0]?.toolName).toBe('get_pod_status');
    expect(run.evidence[1]?.toolName).toBe('get_pod_events');
    expect(run.evidence[2]?.toolName).toBe('get_workload_config');

    // Verify workload config data
    const jobConfigEvidence = run.evidence[2]?.output as any;
    expect(jobConfigEvidence?.kind).toBe('Job');
    expect(jobConfigEvidence?.name).toBe('migration-job');
    expect(jobConfigEvidence?.containers[0]?.imagePullPolicy).toBe('Never');

    // Verify report integrity
    expect(run.report?.confidence).toBe('high');
    expect(run.report?.observedFacts.length).toBe(3);
    expect(run.report?.observedFacts[2]?.evidenceRef).toEqual(['call_job_3']);
  });

  it('unlinks unsupported factual claims and downgrades confidence to low', async () => {
    provider.setScriptedResponses([
      {
        toolCalls: [
          {
            id: 'call_pod_real',
            name: 'get_pod_status',
            arguments: { namespace: 'default' },
          },
        ],
      },
      {
        report: {
          id: 'rep_unsupported',
          summary: 'Contains claims not supported by evidence.',
          observedFacts: [
            {
              id: 'f1',
              statement: 'Grounded pod observation.',
              evidenceRef: ['call_pod_real'],
            },
            {
              id: 'f2',
              statement: 'Unsupported root-cause claim stating memory was 100% full without running resource tool.',
              evidenceRef: [], // No evidence provided
            },
          ],
          hypotheses: [
            {
              id: 'h1',
              statement: 'OOM kill due to memory exhaustion.',
              likelihood: 'high',
              reasoning: 'Guessed without diagnostic proof.',
            },
          ],
          recommendations: ['Increase memory limits'],
          confidence: 'high',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Check memory pressure');

    expect(run.status).toBe('COMPLETED');
    expect(run.report).toBeDefined();

    // The fact with empty evidenceRef was flagged as unsupported
    expect(run.report?.confidence).toBe('low');
    expect(run.report?.uncertaintyNotes).toContain('invalid or nonexistent evidence IDs');
    expect(run.report?.diagnosticGaps).toBeDefined();
    expect(run.report?.diagnosticGaps?.some((g) => g.includes('Unsupported root-cause claim'))).toBe(true);
  });

  it('flags a report that claims a resource was inspected when the tool was never executed', async () => {
    provider.setScriptedResponses([
      {
        toolCalls: [
          {
            id: 'call_pod_only',
            name: 'get_pod_status',
            arguments: { namespace: 'default' },
          },
        ],
      },
      {
        report: {
          id: 'rep_fake_tool',
          summary: 'Claims deployment was inspected when only get_pod_status was run.',
          observedFacts: [
            {
              id: 'f1',
              statement: 'Pod status was inspected.',
              evidenceRef: ['call_pod_only'],
            },
            {
              id: 'f2',
              statement: 'Deployment specification was inspected and replicas are 0.',
              evidenceRef: ['call_deployment_never_run'], // Tool was NEVER executed!
            },
          ],
          hypotheses: [],
          recommendations: [],
          confidence: 'high',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Check deployment health');

    expect(run.status).toBe('COMPLETED');
    // f2's reference must be stripped and confidence lowered to low
    expect(run.report?.observedFacts[1]?.evidenceRef).toEqual([]);
    expect(run.report?.confidence).toBe('low');
    expect(run.report?.diagnosticGaps?.length).toBeGreaterThan(0);
  });

  it('flags a report that references a tool call that failed with an error', async () => {
    provider.setScriptedResponses([
      {
        toolCalls: [
          {
            id: 'call_fail',
            name: 'get_workload_config',
            arguments: { namespace: 'default', name: 'nonexistent-service' },
          },
        ],
      },
      {
        report: {
          id: 'rep_failed_tool',
          summary: 'Claims nonexistent service config was inspected.',
          observedFacts: [
            {
              id: 'f1',
              statement: 'Workload configuration for nonexistent-service has port 8080.',
              evidenceRef: ['call_fail'], // Tool call failed with 404/Error
            },
          ],
          hypotheses: [],
          recommendations: [],
          confidence: 'high',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Inspect nonexistent service');

    expect(run.status).toBe('COMPLETED');
    expect(run.evidence.length).toBe(0); // Failed call produces NO evidence!
    expect(run.report?.observedFacts[0]?.evidenceRef).toEqual([]);
    expect(run.report?.confidence).toBe('low');
  });

  it('preserves existing namespace, read-only, timeout, and tool-budget enforcement', async () => {
    // 1. Tool budget enforcement with get_workload_config
    provider.setScriptedResponses([
      {
        toolCalls: [
          { id: 'c1', name: 'get_workload_config', arguments: { namespace: 'default', name: 'auth-service' } },
        ],
      },
      {
        toolCalls: [
          { id: 'c2', name: 'get_workload_config', arguments: { namespace: 'default', name: 'auth-service' } },
        ],
      },
      {
        toolCalls: [
          { id: 'c3', name: 'get_workload_config', arguments: { namespace: 'default', name: 'auth-service' } },
        ],
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const budgetRun = await engine.investigate('Budget check', { maxToolCalls: 2 });

    expect(budgetRun.status).toBe('BUDGET_EXHAUSTED');
    expect(budgetRun.toolCallCount).toBe(2);

    // 2. Namespace policy enforcement
    provider.setScriptedResponses([
      {
        toolCalls: [
          { id: 'c_forbidden', name: 'get_workload_config', arguments: { namespace: 'kube-system', name: 'coredns' } },
        ],
      },
    ]);

    const nsRun = await engine.investigate('Namespace check', { allowedNamespaces: ['default'] });
    expect(nsRun.status).toBe('POLICY_DENIAL');
    expect(nsRun.terminationReason).toContain('kube-system');

    // 3. Read-only policy enforcement
    expect(registry.get('get_workload_config')?.isReadOnly).toBe(true);
  });
});
