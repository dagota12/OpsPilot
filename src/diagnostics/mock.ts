import type {
  DiagnosticBackend,
  DeploymentStatusParams,
  PodStatusParams,
  PodEventsParams,
  ContainerLogsParams,
  ResourceUsageParams,
  WorkloadConfigParams,
  NodeStatusParams,
  NodeEventsParams,
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
  workloadConfigs?: Record<string, unknown>;
  nodes?: Record<string, unknown>;
  nodeEvents?: Record<string, unknown[]>;
}

export type ScenarioId =
  | 'crashloop-missing-env'
  | 'oom-killed'
  | 'failed-readiness-probe'
  | 'pending-migration-job'
  | 'node-pressure-reboot';

export const MOCK_SCENARIOS: Record<ScenarioId, MockClusterScenario> = {
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
    workloadConfigs: {
      'payment-gateway': {
        kind: 'Deployment',
        name: 'payment-gateway',
        namespace: 'default',
        containers: [
          {
            name: 'gateway',
            image: 'payment-gateway:v1.0',
            imagePullPolicy: 'IfNotPresent',
            resources: { limits: { memory: '512Mi', cpu: '500m' } },
          },
        ],
      },
    },
  },
  'pending-migration-job': {
    id: 'pending-migration-job',
    name: 'Migration Job stuck in Pending due to ErrImageNeverPull',
    description: 'migration-job-pod is Pending because image zcinema-api:jenkins-26 has pullPolicy Never and is not present',
    deployments: {},
    pods: {
      'migration-job': [
        {
          name: 'migration-job-wprdn',
          phase: 'Pending',
          ready: false,
          restartCount: 0,
          ownerReferences: [{ kind: 'Job', name: 'migration-job' }],
          conditions: [
            { type: 'PodScheduled', status: 'True' },
            { type: 'ContainersReady', status: 'False', reason: 'ContainersNotReady', message: 'containers with unready status: [migrate]' },
          ],
          containerStatuses: [
            {
              name: 'migrate',
              ready: false,
              restartCount: 0,
              image: 'zcinema-api:jenkins-26',
              state: {
                waiting: {
                  reason: 'ErrImageNeverPull',
                  message: 'Container image "zcinema-api:jenkins-26" is not present with pull policy of Never',
                },
              },
            },
          ],
        },
      ],
    },
    events: {
      'migration-job': [
        {
          type: 'Warning',
          reason: 'ErrImageNeverPull',
          count: 5,
          message: 'Container image "zcinema-api:jenkins-26" is not present with pull policy of Never',
          firstTimestamp: '2026-10-28T14:00:00Z',
          lastTimestamp: '2026-10-28T14:15:00Z',
        },
      ],
    },
    logs: {},
    resourceUsage: {},
    workloadConfigs: {
      'migration-job': {
        kind: 'Job',
        name: 'migration-job',
        namespace: 'default',
        restartPolicy: 'Never',
        backoffLimit: 3,
        containers: [
          {
            name: 'migrate',
            image: 'zcinema-api:jenkins-26',
            imagePullPolicy: 'Never',
            command: ['npm', 'run', 'migrate'],
            resources: { requests: { memory: '256Mi' }, limits: { memory: '512Mi' } },
            env: [{ name: 'DATABASE_URL', value: '[REDACTED]' }],
          },
        ],
      },
    },
  },
  'node-pressure-reboot': {
    id: 'node-pressure-reboot',
    name: 'Synchronized pod termination with exit code 255 across worker node',
    description: 'Multiple pods on first-cluster-worker terminated abruptly at the same time with exit code 255.',
    deployments: {
      'zcinema-api': {
        name: 'zcinema-api',
        replicas: 2,
        readyReplicas: 2,
        availableReplicas: 2,
      },
    },
    pods: {
      'zcinema': [
        {
          name: 'zcinema-api-dbc55fc96-pqjdz',
          phase: 'Running',
          ready: true,
          restartCount: 15,
          nodeName: 'first-cluster-worker',
          containerStatuses: [
            {
              name: 'api',
              ready: true,
              restartCount: 15,
              lastState: {
                terminated: {
                  exitCode: 255,
                  reason: 'Error',
                  finishedAt: '2026-10-29T05:25:00Z',
                },
              },
            },
          ],
        },
        {
          name: 'zcinema-db-1',
          phase: 'Running',
          ready: true,
          restartCount: 125,
          nodeName: 'first-cluster-worker',
          containerStatuses: [
            {
              name: 'postgres',
              ready: true,
              restartCount: 125,
              lastState: {
                terminated: {
                  exitCode: 255,
                  reason: 'Error',
                  finishedAt: '2026-10-29T05:25:00Z',
                },
              },
            },
          ],
        },
      ],
    },
    events: {},
    logs: {},
    resourceUsage: {},
    nodes: {
      'first-cluster-worker': {
        name: 'first-cluster-worker',
        ready: true,
        roles: ['worker'],
        conditions: [
          { type: 'Ready', status: 'True', reason: 'KubeletReady' },
          { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory' },
          { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure' },
          { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID' },
        ],
        taints: [],
        nodeInfo: {
          kubeletVersion: 'v1.31.0',
          osImage: 'Ubuntu 24.04 LTS',
          bootID: '7a7dcbf1-3da2-4841-96bd-c28deb37eca6',
        },
        capacity: { cpu: '4', memory: '8Gi', pods: '110' },
        allocatable: { cpu: '4', memory: '8Gi', pods: '110' },
      },
    },
    nodeEvents: {
      'first-cluster-worker': [], // Expired events (0 count)
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

  async getWorkloadConfig(params: WorkloadConfigParams): Promise<unknown> {
    const config = this.scenario.workloadConfigs?.[params.name];
    if (config) {
      return config;
    }
    const dep = this.scenario.deployments[params.name];
    if (dep) {
      return {
        kind: 'Deployment',
        name: params.name,
        namespace: params.namespace,
        deployment: dep,
      };
    }
    throw new Error(`Workload '${params.name}' not found in namespace '${params.namespace}'`);
  }

  async getNodeStatus(params: NodeStatusParams): Promise<unknown> {
    if (params.nodeName) {
      const node = this.scenario.nodes?.[params.nodeName];
      if (node) {
        return { nodes: [node] };
      }
      return {
        nodes: [
          {
            name: params.nodeName,
            ready: true,
            roles: ['worker'],
            conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady' }],
            nodeInfo: { kubeletVersion: 'v1.31.0', bootID: 'mock-boot-id' },
          },
        ],
      };
    }

    const allNodes = this.scenario.nodes ? Object.values(this.scenario.nodes) : [
      {
        name: 'default-worker-1',
        ready: true,
        roles: ['worker'],
        conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady' }],
        nodeInfo: { kubeletVersion: 'v1.31.0', bootID: 'mock-boot-id' },
      },
    ];
    return { nodes: allNodes };
  }

  async getNodeEvents(params: NodeEventsParams): Promise<unknown> {
    const nodeEventsMap = this.scenario.nodeEvents || {};
    let events: any[] = [];

    if (params.nodeName) {
      events = nodeEventsMap[params.nodeName] || [];
    } else {
      events = Object.values(nodeEventsMap).flat();
    }

    const limit = params.limit ?? 30;
    return {
      nodeName: params.nodeName,
      totalEventsCount: events.length,
      events: events.slice(0, limit),
      retentionNote:
        'Kubernetes API events are retained for 1 hour by default. Older historical events may have expired. If confirming historical node interruptions or reboots is required, inspect host systemd journal logs (e.g. journalctl -u kubelet).',
    };
  }
}
