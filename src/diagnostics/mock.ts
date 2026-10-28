import type {
  DiagnosticBackend,
  DeploymentStatusParams,
  PodStatusParams,
  PodEventsParams,
  ContainerLogsParams,
  ResourceUsageParams,
} from './interface.js';

export interface MockClusterScenario {
  id: string;
  name: string;
  description: string;
  deployments: Record<string, unknown>;
  pods: Record<string, unknown>;
  events: Record<string, unknown>;
  logs: Record<string, string>;
  resourceUsage: Record<string, unknown>;
}

export const MOCK_SCENARIOS: Record<string, MockClusterScenario> = {
  'crashloop-missing-env': {
    id: 'crashloop-missing-env',
    name: 'CrashLoopBackOff due to missing environment variable',
    description: 'auth-service is crashing repeatedly because JWT_SECRET_KEY is not defined',
    deployments: {
      'auth-service': {
        name: 'auth-service',
        replicas: 1,
        readyReplicas: 0,
        availableReplicas: 0,
        conditions: [
          { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' },
          { type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated' },
        ],
      },
    },
    pods: {
      'auth-service': [
        {
          name: 'auth-service-789f68cb-abcde',
          phase: 'Running',
          ready: false,
          restartCount: 6,
          containerStatuses: [
            {
              name: 'auth-service',
              ready: false,
              restartCount: 6,
              state: {
                waiting: {
                  reason: 'CrashLoopBackOff',
                  message: 'back-off 5m0s restarting failed container',
                },
              },
              lastState: {
                terminated: {
                  exitCode: 1,
                  reason: 'Error',
                  startedAt: '2026-10-28T13:00:00Z',
                  finishedAt: '2026-10-28T13:00:02Z',
                },
              },
            },
          ],
        },
      ],
    },
    events: {
      'auth-service': [
        {
          type: 'Warning',
          reason: 'BackOff',
          count: 14,
          message: 'Back-off restarting failed container auth-service in pod auth-service-789f68cb-abcde_default',
          firstTimestamp: '2026-10-28T12:45:00Z',
          lastTimestamp: '2026-10-28T13:05:00Z',
        },
      ],
    },
    logs: {
      'auth-service-789f68cb-abcde': `[2026-10-28 13:00:01] INFO  Starting Auth Service v1.4.2
[2026-10-28 13:00:01] INFO  Loading configuration...
[2026-10-28 13:00:02] FATAL Missing required environment variable: JWT_SECRET_KEY
[2026-10-28 13:00:02] FATAL Application failed to initialize
Process exited with code 1`,
    },
    resourceUsage: {
      'auth-service-789f68cb-abcde': {
        cpu: { current: '4m', limit: '200m' },
        memory: { current: '38Mi', limit: '256Mi' },
      },
    },
  },

  'oom-killed': {
    id: 'oom-killed',
    name: 'Pod terminated due to OOMKilled (Out of Memory)',
    description: 'image-processor exceeded its 512Mi memory limit while processing high-resolution images',
    deployments: {
      'image-processor': {
        name: 'image-processor',
        replicas: 1,
        readyReplicas: 0,
        availableReplicas: 0,
        conditions: [
          { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' },
        ],
      },
    },
    pods: {
      'image-processor': [
        {
          name: 'image-processor-547dfb6f7-xyz12',
          phase: 'Running',
          ready: false,
          restartCount: 3,
          containerStatuses: [
            {
              name: 'processor',
              ready: false,
              restartCount: 3,
              state: {
                waiting: {
                  reason: 'CrashLoopBackOff',
                  message: 'back-off restarting failed container',
                },
              },
              lastState: {
                terminated: {
                  exitCode: 137,
                  reason: 'OOMKilled',
                  startedAt: '2026-10-28T12:50:00Z',
                  finishedAt: '2026-10-28T12:51:30Z',
                },
              },
            },
          ],
        },
      ],
    },
    events: {
      'image-processor': [
        {
          type: 'Warning',
          reason: 'OOMKilling',
          count: 3,
          message: 'Memory cgroup out of memory: Killed process 1452 (node) total-vm:845MB, anon-rss:512MB, file-rss:0KB',
          firstTimestamp: '2026-10-28T12:40:00Z',
          lastTimestamp: '2026-10-28T12:51:30Z',
        },
      ],
    },
    logs: {
      'image-processor-547dfb6f7-xyz12': `[2026-10-28 12:50:00] INFO  Worker started, awaiting image processing jobs
[2026-10-28 12:50:15] INFO  Processing batch job #941 (image size 4000x3000)
[2026-10-28 12:50:45] WARN  Memory threshold exceeded: 480Mi used of 512Mi limit
[2026-10-28 12:51:28] INFO  Allocating image buffer 64MB...
Killed`,
    },
    resourceUsage: {
      'image-processor-547dfb6f7-xyz12': {
        cpu: { current: '85m', limit: '500m' },
        memory: { current: '512Mi', limit: '512Mi', limitExceeded: true },
      },
    },
  },

  'failed-readiness-probe': {
    id: 'failed-readiness-probe',
    name: 'Pod Running 0/1 Ready due to failing readiness probe',
    description: 'payment-gateway is failing readiness probe because backend database connection failed',
    deployments: {
      'payment-gateway': {
        name: 'payment-gateway',
        replicas: 1,
        readyReplicas: 0,
        availableReplicas: 0,
        conditions: [
          { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' },
        ],
      },
    },
    pods: {
      'payment-gateway': [
        {
          name: 'payment-gateway-695c8c694d-qwert',
          phase: 'Running',
          ready: false,
          restartCount: 0,
          containerStatuses: [
            {
              name: 'gateway',
              ready: false,
              restartCount: 0,
              state: {
                running: {
                  startedAt: '2026-10-28T12:30:00Z',
                },
              },
            },
          ],
        },
      ],
    },
    events: {
      'payment-gateway': [
        {
          type: 'Warning',
          reason: 'Unhealthy',
          count: 22,
          message: 'Readiness probe failed: HTTP probe failed with statuscode: 500',
          firstTimestamp: '2026-10-28T12:31:00Z',
          lastTimestamp: '2026-10-28T13:00:00Z',
        },
      ],
    },
    logs: {
      'payment-gateway-695c8c694d-qwert': `[2026-10-28 12:30:01] INFO  Payment Gateway started on port 8080
[2026-10-28 12:30:05] ERROR Failed to connect to database at postgres.database.svc.cluster.local:5432: connection refused
[2026-10-28 12:30:15] ERROR GET /healthz/ready -> 500 Internal Server Error (Database unreachable)
[2026-10-28 12:30:25] ERROR GET /healthz/ready -> 500 Internal Server Error (Database unreachable)`,
    },
    resourceUsage: {
      'payment-gateway-695c8c694d-qwert': {
        cpu: { current: '12m', limit: '500m' },
        memory: { current: '98Mi', limit: '512Mi' },
      },
    },
  },
};

export class MockDiagnosticBackend implements DiagnosticBackend {
  private scenario: MockClusterScenario;

  constructor(scenarioId: keyof typeof MOCK_SCENARIOS = 'crashloop-missing-env') {
    const s = MOCK_SCENARIOS[scenarioId];
    if (!s) {
      throw new Error(`Unknown mock scenario: ${scenarioId}`);
    }
    this.scenario = s;
  }

  setScenario(scenarioId: keyof typeof MOCK_SCENARIOS): void {
    const s = MOCK_SCENARIOS[scenarioId];
    if (!s) {
      throw new Error(`Unknown mock scenario: ${scenarioId}`);
    }
    this.scenario = s;
  }

  async getDeploymentStatus(params: DeploymentStatusParams): Promise<unknown> {
    const dep = this.scenario.deployments[params.deploymentName];
    if (!dep) {
      throw new Error(`Deployment '${params.deploymentName}' not found in namespace '${params.namespace}'`);
    }
    return dep;
  }

  async getPodStatus(params: PodStatusParams): Promise<unknown> {
    const matchingKey = Object.keys(this.scenario.pods).find((k) =>
      params.podName ? params.podName.includes(k) : true
    );
    if (!matchingKey || !this.scenario.pods[matchingKey]) {
      return { pods: [] };
    }
    return { pods: this.scenario.pods[matchingKey] };
  }

  async getPodEvents(params: PodEventsParams): Promise<unknown> {
    const key = Object.keys(this.scenario.events).find((k) =>
      params.podName ? params.podName.includes(k) : params.involvedObjectName ? params.involvedObjectName.includes(k) : true
    );
    if (!key || !this.scenario.events[key]) {
      return { events: [] };
    }
    return { events: this.scenario.events[key] };
  }

  async getContainerLogs(params: ContainerLogsParams): Promise<unknown> {
    const logKey = Object.keys(this.scenario.logs).find((k) => params.podName.includes(k) || k.includes(params.podName));
    if (!logKey || !this.scenario.logs[logKey]) {
      throw new Error(`No logs found for pod '${params.podName}' in namespace '${params.namespace}'`);
    }
    return { logs: this.scenario.logs[logKey] };
  }

  async getResourceUsage(params: ResourceUsageParams): Promise<unknown> {
    if (params.podName) {
      const usageKey = Object.keys(this.scenario.resourceUsage).find((k) => params.podName?.includes(k));
      if (usageKey && this.scenario.resourceUsage[usageKey]) {
        return { pod: params.podName, usage: this.scenario.resourceUsage[usageKey] };
      }
    }
    return { usages: this.scenario.resourceUsage };
  }
}
