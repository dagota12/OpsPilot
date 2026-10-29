import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppsV1Api } from '@kubernetes/client-node';
import { K8sDiagnosticBackend } from '../src/diagnostics/k8s.js';

describe('K8sDiagnosticBackend', () => {
  let mockCoreApi: any;
  let mockAppsApi: any;
  let mockKc: any;
  let backend: K8sDiagnosticBackend;

  beforeEach(() => {
    mockCoreApi = {
      listNamespacedPod: vi.fn(),
      readNamespacedPod: vi.fn(),
      readNamespacedPodLog: vi.fn(),
      listNamespacedEvent: vi.fn(),
    };

    mockAppsApi = {
      readNamespacedDeployment: vi.fn(),
    };

    mockKc = {
      getCurrentContext: vi.fn().mockReturnValue('test-context'),
      getCurrentCluster: vi.fn().mockReturnValue({ name: 'test-cluster', server: 'https://127.0.0.1:6443' }),
      setCurrentContext: vi.fn(),
      makeApiClient: vi.fn().mockImplementation((apiClass: any) => {
        if (apiClass === AppsV1Api || apiClass.name?.includes('AppsV1Api')) return mockAppsApi;
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
});
