import { describe, it, expect, beforeEach } from 'vitest';
import { InvestigationEngine } from '../src/core/engine/investigation-engine.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { ToolPolicy } from '../src/core/policy/policy.js';
import { MockAIProvider } from '../src/core/providers/mock.js';
import { MockDiagnosticBackend } from '../src/diagnostics/mock.js';
import { createStandardTools } from '../src/diagnostics/tools.js';

describe('Network & Service Diagnostics (get_service_status & get_endpoints_status)', () => {
  let registry: ToolRegistry;
  let policy: ToolPolicy;
  let backend: MockDiagnosticBackend;
  let provider: MockAIProvider;

  beforeEach(() => {
    registry = new ToolRegistry();
    backend = new MockDiagnosticBackend('service-endpoints-missing');
    const tools = createStandardTools(backend);
    for (const tool of tools) {
      registry.register(tool);
    }
    policy = new ToolPolicy(registry);
    provider = new MockAIProvider({ scenarioId: 'service-endpoints-missing' as any });
  });

  it('inspects service status and returns selector and port configuration', async () => {
    const result: any = await backend.getServiceStatus({
      serviceName: 'web-service',
      namespace: 'default',
    });

    expect(result.services.length).toBe(1);
    expect(result.services[0].name).toBe('web-service');
    expect(result.services[0].selector).toEqual({ app: 'web-frontend' });
    expect(result.services[0].ports[0].port).toBe(80);
    expect(result.services[0].ports[0].targetPort).toBe(8080);
  });

  it('inspects endpoints status and detects 0 ready endpoints', async () => {
    const result: any = await backend.getEndpointsStatus({
      serviceName: 'web-service',
      namespace: 'default',
    });

    expect(result.endpoints.length).toBe(1);
    expect(result.endpoints[0].hasEndpoints).toBe(false);
    expect(result.endpoints[0].readyEndpointsCount).toBe(0);
    expect(result.endpoints[0].warning).toContain('0 endpoints');
    expect(result.endpoints[0].warning).toContain('web-frontend');
  });

  it('runs an adaptive investigation discovering service selector mismatch through endpoints check', async () => {
    provider.setScriptedResponses([
      // Step 1: Query service configuration
      {
        content: 'Inspecting service configuration for web-service...',
        toolCalls: [
          {
            id: 'call_svc_status',
            name: 'get_service_status',
            arguments: { serviceName: 'web-service', namespace: 'default' },
          },
        ],
      },
      // Step 2: Query service endpoints to check backend routing
      {
        content: 'Service is configured with selector app=web-frontend. Checking its endpoints...',
        toolCalls: [
          {
            id: 'call_ep_status',
            name: 'get_endpoints_status',
            arguments: { serviceName: 'web-service', namespace: 'default' },
          },
        ],
      },
      // Step 3: Check actual pod labels in the namespace
      {
        content: 'Endpoints count is 0. Checking pod status to verify pod labels...',
        toolCalls: [
          {
            id: 'call_pod_status',
            name: 'get_pod_status',
            arguments: { namespace: 'default' },
          },
        ],
      },
      // Step 4: Conclude investigation with grounded evidence
      {
        report: {
          id: 'rep_net_01',
          summary: 'web-service is returning 502/503 errors because it has 0 ready endpoints due to a selector mismatch (service selects app=web-frontend, but pods have app=frontend).',
          observedFacts: [
            {
              id: 'f1',
              statement: 'web-service has selector app=web-frontend and targetPort 8080.',
              evidenceRef: ['call_svc_status'],
            },
            {
              id: 'f2',
              statement: 'web-service has 0 ready endpoints.',
              evidenceRef: ['call_ep_status'],
            },
            {
              id: 'f3',
              statement: 'Running frontend pods are labeled app=frontend, mismatching the service selector.',
              evidenceRef: ['call_pod_status'],
            },
          ],
          hypotheses: [
            {
              id: 'h1',
              statement: 'Label selector mismatch in web-service definition.',
              likelihood: 'high',
              reasoning: 'The service specifies app=web-frontend, but the deployment pods are labeled app=frontend.',
            },
          ],
          recommendations: [
            'Update the web-service selector to match the running pod label app: frontend.',
          ],
          confidence: 'high',
        },
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate(
      'Why is web-service returning 502 Bad Gateway / connection refused?',
      { targetNamespace: 'default' }
    );

    expect(run.status).toBe('COMPLETED');
    expect(run.evidence.length).toBe(3);
    expect(run.evidence.map((e) => e.toolName)).toEqual(['get_service_status', 'get_endpoints_status', 'get_pod_status']);
    expect(run.report?.confidence).toBe('high');
    expect(run.report?.summary).toContain('0 ready endpoints');
    expect(run.report?.observedFacts.length).toBe(3);
  });
});
