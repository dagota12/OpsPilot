import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { InvestigationEngine } from '../src/core/engine/investigation-engine.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { ToolPolicy } from '../src/core/policy/policy.js';
import { MockAIProvider } from '../src/core/providers/mock.js';
import { MockDiagnosticBackend } from '../src/diagnostics/mock.js';
import { createStandardTools } from '../src/diagnostics/tools.js';

describe('Node Diagnostics & Infrastructure Investigation (get_node_status & get_node_events)', () => {
  let registry: ToolRegistry;
  let policy: ToolPolicy;
  let backend: MockDiagnosticBackend;
  let provider: MockAIProvider;

  beforeEach(() => {
    registry = new ToolRegistry();
    backend = new MockDiagnosticBackend('node-pressure-reboot');
    const tools = createStandardTools(backend);
    for (const tool of tools) {
      registry.register(tool);
    }
    policy = new ToolPolicy(registry);
    provider = new MockAIProvider({ scenarioId: 'node-pressure-reboot' });
  });

  it('correctly reports healthy node readiness, conditions, and metadata', async () => {
    provider.setScriptedResponses([
      {
        toolCalls: [
          {
            id: 'call_node_status',
            name: 'get_node_status',
            arguments: { nodeName: 'first-cluster-worker' },
          },
        ],
      },
      {
        report: {
          id: 'rep_healthy_node',
          summary: 'Node first-cluster-worker is Ready with no memory or disk pressure.',
          observedFacts: [
            {
              id: 'f1',
              statement: 'Node first-cluster-worker condition Ready is True and MemoryPressure is False.',
              evidenceRef: ['call_node_status'],
            },
          ],
          hypotheses: [],
          recommendations: ['No action required for node health.'],
          confidence: 'high',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Check node health');

    expect(run.status).toBe('COMPLETED');
    expect(run.evidence.length).toBe(1);
    const nodeEvidence = run.evidence[0]?.output as any;
    expect(nodeEvidence.nodes[0].name).toBe('first-cluster-worker');
    expect(nodeEvidence.nodes[0].ready).toBe(true);
    expect(nodeEvidence.nodes[0].conditions.find((c: any) => c.type === 'MemoryPressure').status).toBe('False');
    expect(run.report?.confidence).toBe('high');
  });

  it('detects NotReady and MemoryPressure conditions on nodes', async () => {
    // Override scenario with an unhealthy node
    const unhealthyBackend = new MockDiagnosticBackend('node-pressure-reboot');
    (unhealthyBackend as any).scenario.nodes['unhealthy-worker'] = {
      name: 'unhealthy-worker',
      ready: false,
      roles: ['worker'],
      conditions: [
        { type: 'Ready', status: 'False', reason: 'KubeletNotReady', message: 'Kubelet stopped posting node status' },
        { type: 'MemoryPressure', status: 'True', reason: 'KubeletHasInsufficientMemory', message: 'Available memory below threshold' },
        { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure' },
      ],
      taints: [{ key: 'node.kubernetes.io/unreachable', effect: 'NoExecute' }],
    };

    const localRegistry = new ToolRegistry();
    createStandardTools(unhealthyBackend).forEach((t) => localRegistry.register(t));
    const localPolicy = new ToolPolicy(localRegistry);

    provider.setScriptedResponses([
      {
        toolCalls: [
          {
            id: 'call_unhealthy',
            name: 'get_node_status',
            arguments: { nodeName: 'unhealthy-worker' },
          },
        ],
      },
      {
        report: {
          id: 'rep_unhealthy',
          summary: 'Node unhealthy-worker is under MemoryPressure and currently NotReady.',
          observedFacts: [
            {
              id: 'f1',
              statement: 'Node unhealthy-worker has MemoryPressure=True and Ready=False.',
              evidenceRef: ['call_unhealthy'],
            },
          ],
          hypotheses: [
            {
              id: 'h1',
              statement: 'Node-level OOM or kernel panic caused kubelet to become unresponsive.',
              likelihood: 'high',
              reasoning: 'Active MemoryPressure condition combined with KubeletNotReady.',
            },
          ],
          recommendations: ['Investigate node OS memory consumption and restart kubelet if needed.'],
          confidence: 'high',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry: localRegistry, policy: localPolicy });
    const run = await engine.investigate('Check unhealthy node');

    expect(run.status).toBe('COMPLETED');
    const nodeOutput = run.evidence[0]?.output as any;
    expect(nodeOutput.nodes[0].ready).toBe(false);
    expect(nodeOutput.nodes[0].conditions.find((c: any) => c.type === 'MemoryPressure').status).toBe('True');
  });

  it('retrieves relevant node warning events when available', async () => {
    (backend as any).scenario.nodeEvents['first-cluster-worker'] = [
      {
        type: 'Warning',
        reason: 'EvictionThresholdMet',
        message: 'Attempting to evict pods due to ephemeral-storage pressure',
        count: 2,
        firstTimestamp: '2026-10-29T05:20:00Z',
        lastTimestamp: '2026-10-29T05:24:00Z',
        involvedObject: { kind: 'Node', name: 'first-cluster-worker' },
      },
    ];

    provider.setScriptedResponses([
      {
        toolCalls: [
          {
            id: 'call_events',
            name: 'get_node_events',
            arguments: { nodeName: 'first-cluster-worker' },
          },
        ],
      },
      {
        report: {
          id: 'rep_events',
          summary: 'Node warning event EvictionThresholdMet detected.',
          observedFacts: [
            {
              id: 'f1',
              statement: 'EvictionThresholdMet event recorded on node first-cluster-worker.',
              evidenceRef: ['call_events'],
            },
          ],
          hypotheses: [],
          recommendations: [],
          confidence: 'high',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Check node events');

    expect(run.status).toBe('COMPLETED');
    const eventsOutput = run.evidence[0]?.output as any;
    expect(eventsOutput.events.length).toBe(1);
    expect(eventsOutput.events[0].reason).toBe('EvictionThresholdMet');
    expect(eventsOutput.retentionNote).toContain('1 hour by default');
  });

  it('handles expired/missing event history honestly and identifies host logs as the next evidence source', async () => {
    // In this scenario, nodeEvents is empty [] (representing expired events)
    provider.setScriptedResponses([
      {
        toolCalls: [
          {
            id: 'call_node_events_empty',
            name: 'get_node_events',
            arguments: { nodeName: 'first-cluster-worker' },
          },
        ],
      },
      {
        report: {
          id: 'rep_reboot_missing_events',
          summary: 'Cannot confirm a historical node reboot via Kubernetes API because event history has expired.',
          observedFacts: [
            {
              id: 'f1',
              statement: 'get_node_events returned 0 active events for first-cluster-worker (events expired past 1h TTL).',
              evidenceRef: ['call_node_events_empty'],
            },
          ],
          hypotheses: [
            {
              id: 'h1',
              statement: 'A past node reboot or host crash may have occurred, but cannot be confirmed by Kubernetes API events alone.',
              likelihood: 'medium',
              reasoning: 'API event retention has expired. Host systemd or hypervisor logs are required.',
            },
          ],
          recommendations: [
            'Inspect host systemd journal on the worker node: journalctl -u kubelet -b -1 or dmesg logs.',
            'Check hypervisor/cloud instance termination metrics for host restart events.',
          ],
          confidence: 'medium',
          uncertaintyNotes: 'Kubernetes API event buffer contains no recent events for node first-cluster-worker. Host logs required to verify reboot.',
          diagnosticGaps: [
            'Kubernetes API event history expired (>1h). Direct host/hypervisor logs required for confirmation.',
          ],
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Did the worker node reboot?');

    expect(run.status).toBe('COMPLETED');
    expect(run.report?.confidence).toBe('medium'); // Correctly refrained from claiming 'high' without evidence!
    expect(run.report?.recommendations[0]).toContain('journalctl -u kubelet');
    expect(run.report?.diagnosticGaps?.some((g) => g.includes('event history expired'))).toBe(true);
  });

  it('regression: adaptive investigation follows pod-to-node reference for synchronized restarts before concluding', async () => {
    // Step 1: Model inspects pod status, sees synchronized exitCode 255 on 'first-cluster-worker'
    // Step 2: Model adaptively extracts nodeName 'first-cluster-worker' from pod status rather than guessing
    // Step 3: Model inspects get_node_status and get_node_events for 'first-cluster-worker'
    // Step 4: Model delivers a grounded report
    provider.setScriptedResponses([
      {
        content: 'Inspecting affected pods...',
        toolCalls: [
          {
            id: 'step1_pod_status',
            name: 'get_pod_status',
            arguments: { namespace: 'default' },
          },
        ],
      },
      {
        content: 'Multiple pods terminated simultaneously with exit code 255 on node first-cluster-worker. Following pod nodeName reference to inspect the node...',
        toolCalls: [
          {
            id: 'step2_node_status',
            name: 'get_node_status',
            arguments: { nodeName: 'first-cluster-worker' },
          },
          {
            id: 'step3_node_events',
            name: 'get_node_events',
            arguments: { nodeName: 'first-cluster-worker' },
          },
        ],
      },
      {
        content: 'Investigation concluded.',
        report: {
          id: 'rep_synchronized_restarts',
          summary: 'Multiple pods experienced synchronized exit code 255 terminations hosted on first-cluster-worker. Node is currently Ready, and Kubernetes event buffer has expired.',
          observedFacts: [
            {
              id: 'f1',
              statement: 'Pods zcinema-api and zcinema-db-1 terminated at the same timestamp (05:25:00Z) with exitCode 255 hosted on first-cluster-worker.',
              evidenceRef: ['step1_pod_status'],
            },
            {
              id: 'f2',
              statement: 'Node first-cluster-worker is currently in Ready status with bootID 7a7dcbf1-3da2-4841-96bd-c28deb37eca6.',
              evidenceRef: ['step2_node_status'],
            },
            {
              id: 'f3',
              statement: 'Node event history contains 0 active events (expired).',
              evidenceRef: ['step3_node_events'],
            },
          ],
          hypotheses: [
            {
              id: 'h1',
              statement: 'Node-level interruption or reboot on first-cluster-worker triggered abrupt container teardown.',
              likelihood: 'medium',
              reasoning: 'Synchronized terminations on the same host node. Unconfirmed because API event buffer has expired.',
            },
          ],
          recommendations: [
            'Inspect node systemd journal via journalctl -u kubelet on first-cluster-worker.',
          ],
          confidence: 'medium',
          diagnosticGaps: [
            'Kubernetes API event buffer does not retain events from 05:25 UTC. Host OS logs required for root cause verification.',
          ],
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Investigate synchronized restarts on my cluster');

    expect(run.status).toBe('COMPLETED');
    expect(run.toolCallCount).toBe(3);
    expect(run.evidence.length).toBe(3);

    // Verify tool execution order: pod status -> node status -> node events
    expect(run.evidence[0]?.toolName).toBe('get_pod_status');
    expect(run.evidence[1]?.toolName).toBe('get_node_status');
    expect(run.evidence[2]?.toolName).toBe('get_node_events');

    // Verify target node name was followed from pod status
    expect((run.evidence[1]?.params as any).nodeName).toBe('first-cluster-worker');
    expect((run.evidence[2]?.params as any).nodeName).toBe('first-cluster-worker');

    // Verify report citations
    expect(run.report?.observedFacts.length).toBe(3);
    expect(run.report?.observedFacts[1]?.evidenceRef).toEqual(['step2_node_status']);
    expect(run.report?.observedFacts[2]?.evidenceRef).toEqual(['step3_node_events']);
  });

  it('enforces read-only policy and tool budget for node diagnostic tools', async () => {
    expect(registry.get('get_node_status')?.isReadOnly).toBe(true);
    expect(registry.get('get_node_events')?.isReadOnly).toBe(true);

    // Budget enforcement
    provider.setScriptedResponses([
      {
        toolCalls: [
          { id: 'c1', name: 'get_node_status', arguments: {} },
        ],
      },
      {
        toolCalls: [
          { id: 'c2', name: 'get_node_events', arguments: {} },
        ],
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const budgetRun = await engine.investigate('Budget limit check', { maxToolCalls: 1 });
    expect(budgetRun.status).toBe('BUDGET_EXHAUSTED');
    expect(budgetRun.toolCallCount).toBe(1);
  });
});
