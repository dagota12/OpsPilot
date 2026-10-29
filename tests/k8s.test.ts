import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppsV1Api, BatchV1Api } from '@kubernetes/client-node';
import { K8sDiagnosticBackend } from '../src/diagnostics/k8s.js';

describe('K8sDiagnosticBackend', () => {
  let mockCoreApi: any;
  let mockAppsApi: any;
  let mockBatchApi: any;
  let mockKc: any;
  let backend: K8sDiagnosticBackend;

  beforeEach(() => {
    mockCoreApi = {
      listNamespacedPod: vi.fn(),
      readNamespacedPod: vi.fn(),
      readNamespacedPodLog: vi.fn(),
      listNamespacedEvent: vi.fn(),
      listNode: vi.fn(),
      readNode: vi.fn(),
      listEventForAllNamespaces: vi.fn(),
    };

    mockAppsApi = {
      readNamespacedDeployment: vi.fn(),
    };

    mockBatchApi = {
      readNamespacedJob: vi.fn(),
      readNamespacedCronJob: vi.fn(),
    };

    mockKc = {
      getCurrentContext: vi.fn().mockReturnValue('test-context'),
      getCurrentCluster: vi.fn().mockReturnValue({ name: 'test-cluster', server: 'https://127.0.0.1:6443' }),
      setCurrentContext: vi.fn(),
      makeApiClient: vi.fn().mockImplementation((apiClass: any) => {
        if (apiClass === AppsV1Api || apiClass.name?.includes('AppsV1Api')) return mockAppsApi;
        if (apiClass === BatchV1Api || apiClass.name?.includes('BatchV1Api')) return mockBatchApi;
        return mockCoreApi;
      }),
    };

    backend = new K8sDiagnosticBackend({ kubeConfig: mockKc });
  });

  it('reports current cluster context and server info', () => {
    const info = backend.getContextInfo();
    expect(info.currentContext).toBe('test-context');
    expect(info.clusterName).toBe('test-cluster');
    expect(info.server).toBe('https://127.0.0.1:6443');
  });

  it('queries live deployment status and extracts rollout conditions', async () => {
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { name: 'api-service', namespace: 'default' },
      spec: { replicas: 2 },
      status: {
        replicas: 2,
        readyReplicas: 1,
        availableReplicas: 1,
        conditions: [
          { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
        ],
      },
    });

    const status: any = await backend.getDeploymentStatus({
      deploymentName: 'api-service',
      namespace: 'default',
    });

    expect(status.name).toBe('api-service');
    expect(status.desiredReplicas).toBe(2);
    expect(status.readyReplicas).toBe(1);
    expect(status.conditions.length).toBe(1);
  });

  it('queries pod status and formats container restart counts and termination states', async () => {
    mockCoreApi.readNamespacedPod.mockResolvedValue({
      metadata: { name: 'worker-pod-123', namespace: 'default' },
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'False' }],
        containerStatuses: [
          {
            name: 'worker',
            ready: false,
            restartCount: 4,
            state: {
              waiting: { reason: 'CrashLoopBackOff', message: 'Back-off 5m' },
            },
            lastState: {
              terminated: { exitCode: 1, reason: 'Error' },
            },
          },
        ],
      },
    });

    const result: any = await backend.getPodStatus({
      namespace: 'default',
      podName: 'worker-pod-123',
    });

    expect(result.pods.length).toBe(1);
    expect(result.pods[0].name).toBe('worker-pod-123');
    expect(result.pods[0].ready).toBe(false);
    expect(result.pods[0].restartCount).toBe(4);
    expect(result.pods[0].containerStatuses[0].state.waiting.reason).toBe('CrashLoopBackOff');
  });

  it('retrieves container logs with tail lines', async () => {
    mockCoreApi.readNamespacedPodLog.mockResolvedValue('line 1\nline 2\nFatal Error\n');

    const result: any = await backend.getContainerLogs({
      namespace: 'default',
      podName: 'worker-pod-123',
      tailLines: 50,
    });

    expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledWith({
      name: 'worker-pod-123',
      namespace: 'default',
      container: undefined,
      tailLines: 50,
    });
    expect(result.logs).toContain('Fatal Error');
  });

  it('retrieves and sorts warning events ahead of normal events', async () => {
    mockCoreApi.listNamespacedEvent.mockResolvedValue({
      items: [
        { type: 'Normal', reason: 'Scheduled', message: 'Successfully assigned pod' },
        { type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container' },
      ],
    });

    const result: any = await backend.getPodEvents({ namespace: 'default' });
    expect(result.events.length).toBe(2);
    expect(result.events[0].type).toBe('Warning');
    expect(result.events[0].reason).toBe('BackOff');
  });

  it('queries workload configuration for Job and redacts sensitive environment variables', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValue({
      metadata: { name: 'db-migration', namespace: 'default' },
      spec: {
        completions: 1,
        backoffLimit: 2,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'migrate',
                image: 'db-migration:v1.0',
                imagePullPolicy: 'Never',
                command: ['npm', 'run', 'migrate'],
                env: [
                  { name: 'NODE_ENV', value: 'production' },
                  { name: 'DB_PASSWORD', value: 'super-secret-123' },
                  { name: 'API_SECRET_KEY', value: 'token-xyz' },
                  { name: 'CONFIG_FILE', valueFrom: { configMapKeyRef: { name: 'app-config', key: 'file' } } },
                ],
                resources: {
                  requests: { memory: '256Mi' },
                  limits: { memory: '512Mi' },
                },
              },
            ],
          },
        },
      },
    });

    const config: any = await backend.getWorkloadConfig({
      name: 'db-migration',
      namespace: 'default',
      kind: 'job',
    });

    expect(config.kind).toBe('Job');
    expect(config.name).toBe('db-migration');
    expect(config.restartPolicy).toBe('Never');
    expect(config.containers.length).toBe(1);
    expect(config.containers[0].imagePullPolicy).toBe('Never');
    expect(config.containers[0].resources.limits.memory).toBe('512Mi');

    // Verify sensitive variables are safely redacted
    const envVars = config.containers[0].env;
    expect(envVars.find((e: any) => e.name === 'NODE_ENV').value).toBe('production');
    expect(envVars.find((e: any) => e.name === 'DB_PASSWORD').value).toBe('[REDACTED]');
    expect(envVars.find((e: any) => e.name === 'API_SECRET_KEY').value).toBe('[REDACTED]');
    expect(envVars.find((e: any) => e.name === 'CONFIG_FILE').source).toBe('configMapKeyRef');
  });

  it('queries node status including conditions, pressure signals, and bootID', async () => {
    mockCoreApi.readNode.mockResolvedValue({
      metadata: {
        name: 'first-cluster-worker',
        labels: { 'node-role.kubernetes.io/worker': '' },
      },
      status: {
        conditions: [
          { type: 'Ready', status: 'True', reason: 'KubeletReady' },
          { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory' },
          { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure' },
        ],
        nodeInfo: {
          kubeletVersion: 'v1.31.0',
          bootID: 'boot-id-1234',
          osImage: 'Ubuntu 24.04',
        },
      },
    });

    const result: any = await backend.getNodeStatus({ nodeName: 'first-cluster-worker' });
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].name).toBe('first-cluster-worker');
    expect(result.nodes[0].ready).toBe(true);
    expect(result.nodes[0].roles).toContain('worker');
    expect(result.nodes[0].conditions.find((c: any) => c.type === 'MemoryPressure').status).toBe('False');
    expect(result.nodes[0].nodeInfo.bootID).toBe('boot-id-1234');
  });

  it('queries node events and includes retention disclaimer', async () => {
    mockCoreApi.listEventForAllNamespaces.mockResolvedValue({
      items: [
        {
          type: 'Warning',
          reason: 'NodeNotReady',
          message: 'Node became not ready',
          involvedObject: { kind: 'Node', name: 'first-cluster-worker' },
          lastTimestamp: '2026-10-29T05:25:00Z',
        },
      ],
    });

    const result: any = await backend.getNodeEvents({ nodeName: 'first-cluster-worker' });
    expect(result.nodeName).toBe('first-cluster-worker');
    expect(result.events.length).toBe(1);
    expect(result.events[0].reason).toBe('NodeNotReady');
    expect(result.retentionNote).toContain('1 hour by default');
    expect(result.retentionNote).toContain('journalctl -u kubelet');
  });
});
