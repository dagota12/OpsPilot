import type {
  AIProvider,
  AIMessage,
  AIResponse,
  ToolCallRequest,
} from './interface.js';
import type { ToolDefinition } from '../tools/types.js';
import type { IncidentReport } from '../models/report.js';
import type { ScenarioId } from '../../diagnostics/mock.js';

export interface MockStep {
  response: AIResponse;
}

export class MockAIProvider implements AIProvider {
  readonly id = 'mock';
  private stepIndex = 0;
  private scriptedResponses: AIResponse[] = [];
  private scenarioId?: ScenarioId;

  constructor(options?: {
    scenarioId?: ScenarioId;
    scriptedResponses?: AIResponse[];
  }) {
    if (options?.scenarioId) {
      this.scenarioId = options.scenarioId;
    }
    if (options?.scriptedResponses) {
      this.scriptedResponses = [...options.scriptedResponses];
    }
  }

  setScriptedResponses(responses: AIResponse[]): void {
    this.scriptedResponses = [...responses];
    this.stepIndex = 0;
  }

  setScenario(scenarioId: ScenarioId): void {
    this.scenarioId = scenarioId;
    this.stepIndex = 0;
    this.scriptedResponses = [];
  }

  async chat(options: {
    messages: AIMessage[];
    tools: ToolDefinition[];
    abortSignal?: AbortSignal;
  }): Promise<AIResponse> {
    if (options.abortSignal?.aborted) {
      throw new Error('Chat operation was aborted');
    }

    // 1. If custom scripted responses are queued, return them in order
    if (this.scriptedResponses.length > 0) {
      if (this.stepIndex < this.scriptedResponses.length) {
        const response = this.scriptedResponses[this.stepIndex]!;
        this.stepIndex++;
        return response;
      }
      // If we ran out of scripted responses, return a generic completion
      return { content: 'No more scripted steps available.' };
    }

    // 2. Otherwise run built-in scenario state machine
    if (this.scenarioId) {
      return this.handleScenario(this.scenarioId, options.messages);
    }

    return { content: 'Mock provider ready with no active scenario or scripts.' };
  }

  private handleScenario(scenario: string, messages: AIMessage[]): AIResponse {
    const toolMessages = messages.filter((m) => m.role === 'tool');
    const userMsg = messages.filter((m) => m.role === 'user').pop()?.content.trim().toLowerCase() || '';
    const isGreeting =
      /^(hi|hello|hey|greetings|howdy|good\s+(morning|afternoon|evening)|who\s+are\s+you|what\s+can\s+you\s+do)\b/i.test(userMsg) &&
      !/(investigate|check|restart|fail|status|error|pod|deploy|node|service|endpoint|issue|why|what)/i.test(userMsg);

    if (isGreeting && toolMessages.length === 0) {
      return {
        content: `Hello! I'm OpsPilot, your AI DevOps incident investigator. I'm ready to inspect workloads, pods, services, and nodes in your cluster. What would you like to investigate?`,
      };
    }

    if (scenario === 'crashloop-missing-env') {
      if (toolMessages.length === 0) {
        return {
          content: 'Inspecting auth-service pod status...',
          toolCalls: [
            {
              id: 'call_1',
              name: 'get_pod_status',
              arguments: { namespace: 'default', podName: 'auth-service' },
            },
          ],
        };
      }
      if (toolMessages.length === 1) {
        return {
          content: 'Pod is in CrashLoopBackOff with exit code 1. Checking container logs...',
          toolCalls: [
            {
              id: 'call_2',
              name: 'get_container_logs',
              arguments: { namespace: 'default', podName: 'auth-service-789f68cb-abcde' },
            },
          ],
        };
      }
      // Final report
      const report: IncidentReport = {
        id: 'rep_crashloop_1',
        summary: 'auth-service is repeatedly crashing on startup due to missing environment variable JWT_SECRET_KEY.',
        observedFacts: [
          {
            id: 'fact_1',
            statement: 'Pod auth-service-789f68cb-abcde is in CrashLoopBackOff state with exit code 1 and 6 restarts.',
            evidenceRef: ['call_1'],
          },
          {
            id: 'fact_2',
            statement: 'Container stdout/stderr contains: "FATAL Missing required environment variable: JWT_SECRET_KEY".',
            evidenceRef: ['call_2'],
          },
        ],
        hypotheses: [
          {
            id: 'hypo_1',
            statement: 'The deployment or secret manifest lacks the JWT_SECRET_KEY environment variable binding.',
            likelihood: 'high',
            reasoning: 'The application explicitly halts initialization when JWT_SECRET_KEY is undefined.',
          },
        ],
        recommendations: [
          'Verify that the Secret containing JWT_SECRET_KEY exists in namespace default.',
          'Check the auth-service Deployment spec to ensure env or envFrom correctly maps JWT_SECRET_KEY.',
        ],
        confidence: 'high',
      };
      return { report, content: 'Investigation complete: Missing JWT_SECRET_KEY identified.' };
    }

    if (scenario === 'oom-killed') {
      if (toolMessages.length === 0) {
        return {
          content: 'Inspecting image-processor pod status...',
          toolCalls: [
            {
              id: 'call_1',
              name: 'get_pod_status',
              arguments: { namespace: 'default', podName: 'image-processor' },
            },
          ],
        };
      }
      if (toolMessages.length === 1) {
        return {
          content: 'Pod terminated with exit code 137 (OOMKilled). Checking resource usage and events...',
          toolCalls: [
            {
              id: 'call_2',
              name: 'get_resource_usage',
              arguments: { namespace: 'default', podName: 'image-processor-547dfb6f7-xyz12' },
            },
          ],
        };
      }
      const report: IncidentReport = {
        id: 'rep_oom_1',
        summary: 'image-processor was terminated by Linux OOM killer (OOMKilled) because container memory usage exceeded its 512Mi limit.',
        observedFacts: [
          {
            id: 'fact_1',
            statement: 'Container terminated with exitCode 137 and reason OOMKilled.',
            evidenceRef: ['call_1'],
          },
          {
            id: 'fact_2',
            statement: 'Resource usage reached exactly 512Mi limit during high-resolution image processing.',
            evidenceRef: ['call_2'],
          },
        ],
        hypotheses: [
          {
            id: 'hypo_1',
            statement: 'Configured memory limit (512Mi) is inadequate for 4000x3000 image batch processing jobs.',
            likelihood: 'high',
            reasoning: 'The process was killed immediately after attempting to allocate a 64MB buffer at 480Mi usage.',
          },
        ],
        recommendations: [
          'Increase the container memory limit in deployment spec from 512Mi to 1Gi or 2Gi.',
          'Consider streaming image buffer processing or adding concurrency throttles.',
        ],
        confidence: 'high',
      };
      return { report, content: 'Investigation complete: OOMKilled limit breach.' };
    }

    if (scenario === 'failed-readiness-probe') {
      if (toolMessages.length === 0) {
        return {
          content: 'Checking payment-gateway pod events and readiness...',
          toolCalls: [
            {
              id: 'call_1',
              name: 'get_pod_events',
              arguments: { namespace: 'default', podName: 'payment-gateway' },
            },
          ],
        };
      }
      if (toolMessages.length === 1) {
        return {
          content: 'Readiness probe failed HTTP 500. Inspecting container logs...',
          toolCalls: [
            {
              id: 'call_2',
              name: 'get_container_logs',
              arguments: { namespace: 'default', podName: 'payment-gateway-695c8c694d-qwert' },
            },
          ],
        };
      }
      const report: IncidentReport = {
        id: 'rep_readiness_1',
        summary: 'payment-gateway pod is running but unready (0/1 Ready) because the readiness health check returns HTTP 500 when Postgres is unreachable.',
        observedFacts: [
          {
            id: 'fact_1',
            statement: 'Pod events report Readiness probe failed: HTTP probe failed with statuscode: 500 (22 occurrences).',
            evidenceRef: ['call_1'],
          },
          {
            id: 'fact_2',
            statement: 'Container logs show "connection refused" to postgres.database.svc.cluster.local:5432 during readiness check.',
            evidenceRef: ['call_2'],
          },
        ],
        hypotheses: [
          {
            id: 'hypo_1',
            statement: 'PostgreSQL database service in database namespace is down or network policy prevents cross-namespace ingress.',
            likelihood: 'high',
            reasoning: 'Application startup log explicitly notes connection refused to Postgres host.',
          },
        ],
        recommendations: [
          'Check Postgres service and pod status in database namespace.',
          'Verify network policies and DNS resolution for postgres.database.svc.cluster.local.',
        ],
        confidence: 'high',
      };
      return { report, content: 'Investigation complete: Failing readiness probe due to database connection refusal.' };
    }

    if (scenario === 'pending-migration-job') {
      if (toolMessages.length === 0) {
        return {
          content: 'Inspecting migration-job pod status...',
          toolCalls: [
            {
              id: 'call_1',
              name: 'get_pod_status',
              arguments: { namespace: 'default', podName: 'migration-job-wprdn' },
            },
          ],
        };
      }
      if (toolMessages.length === 1) {
        return {
          content: 'Pod is Pending with ErrImageNeverPull. Inspecting parent Job specification...',
          toolCalls: [
            {
              id: 'call_2',
              name: 'get_workload_config',
              arguments: { namespace: 'default', kind: 'job', name: 'migration-job' },
            },
          ],
        };
      }
      const report: IncidentReport = {
        id: 'rep_pending_migration',
        summary: 'Migration job is blocked in Pending because container image zcinema-api:jenkins-26 is missing locally with imagePullPolicy Never.',
        observedFacts: [
          {
            id: 'fact_1',
            statement: 'Pod migration-job-wprdn is Pending with ErrImageNeverPull.',
            evidenceRef: ['call_1'],
          },
          {
            id: 'fact_2',
            statement: 'Job migration-job defines container migrate with imagePullPolicy Never.',
            evidenceRef: ['call_2'],
          },
        ],
        hypotheses: [
          {
            id: 'hypo_1',
            statement: 'The image tag is not present on the node and imagePullPolicy Never prevents pulling it.',
            likelihood: 'high',
            reasoning: 'Verified by inspecting the Job workload specification and pod status.',
          },
        ],
        recommendations: [
          'Change imagePullPolicy to IfNotPresent or load the missing image onto the cluster nodes.',
        ],
        confidence: 'high',
      };
      return { report, content: 'Investigation complete: Migration job image missing with pull policy Never.' };
    }

    return { content: 'No scenario matched.' };
  }
}
