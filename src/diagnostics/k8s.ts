import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  BatchV1Api,
} from '@kubernetes/client-node';
import type {
  DiagnosticBackend,
  DeploymentStatusParams,
  PodStatusParams,
  PodEventsParams,
  ContainerLogsParams,
  ResourceUsageParams,
  WorkloadConfigParams,
} from './interface.js';

export interface K8sBackendOptions {
  kubeConfig?: KubeConfig;
  context?: string;
  kubeconfigPath?: string;
}

export class K8sDiagnosticBackend implements DiagnosticBackend {
  private kc: KubeConfig;
  private coreApi: CoreV1Api;
  private appsApi: AppsV1Api;
  private batchApi: BatchV1Api;

  constructor(options: K8sBackendOptions = {}) {
    this.kc = options.kubeConfig || new KubeConfig();

    if (!options.kubeConfig) {
      if (options.kubeconfigPath) {
        this.kc.loadFromFile(options.kubeconfigPath);
      } else {
        this.kc.loadFromDefault();
      }
    }

    if (options.context) {
      this.kc.setCurrentContext(options.context);
    }

    this.coreApi = this.kc.makeApiClient(CoreV1Api);
    this.appsApi = this.kc.makeApiClient(AppsV1Api);
    this.batchApi = this.kc.makeApiClient(BatchV1Api);
  }

  getContextInfo(): { currentContext: string; clusterName: string; server: string } {
    const currentContext = this.kc.getCurrentContext() || 'unknown';
    const currentCluster = this.kc.getCurrentCluster();
    return {
      currentContext,
      clusterName: currentCluster?.name || 'unknown',
      server: currentCluster?.server || 'unknown',
    };
  }

  async getDeploymentStatus(params: DeploymentStatusParams): Promise<unknown> {
    try {
      const dep = await this.appsApi.readNamespacedDeployment({
        name: params.deploymentName,
        namespace: params.namespace,
      });

      return {
        name: dep.metadata?.name,
        namespace: dep.metadata?.namespace,
        desiredReplicas: dep.spec?.replicas ?? 1,
        replicas: dep.status?.replicas ?? 0,
        readyReplicas: dep.status?.readyReplicas ?? 0,
        availableReplicas: dep.status?.availableReplicas ?? 0,
        updatedReplicas: dep.status?.updatedReplicas ?? 0,
        conditions: (dep.status?.conditions || []).map((c: any) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
          lastUpdateTime: c.lastUpdateTime,
        })),
      };
    } catch (err: any) {
      throw new Error(
        `Failed to read deployment '${params.deploymentName}' in namespace '${params.namespace}': ${err.body?.message || err.message || err}`
      );
    }
  }

  async getPodStatus(params: PodStatusParams): Promise<unknown> {
    try {
      let rawPods: any[] = [];

      if (params.podName) {
        try {
          const pod = await this.coreApi.readNamespacedPod({
            name: params.podName,
            namespace: params.namespace,
          });
          rawPods = [pod];
        } catch {
          // If direct lookup fails (e.g. prefix was passed), search namespace
          const podList = await this.coreApi.listNamespacedPod({
            namespace: params.namespace,
          });
          rawPods = (podList.items || []).filter((p: any) =>
            p.metadata?.name?.includes(params.podName!)
          );
        }
      } else {
        const podList = await this.coreApi.listNamespacedPod({
          namespace: params.namespace,
          labelSelector: params.labelSelector,
        });
        rawPods = podList.items || [];
      }

      const formattedPods = rawPods.map((p: any) => {
        const containerStatuses = (p.status?.containerStatuses || []).map((cs: any) => ({
          name: cs.name,
          ready: cs.ready,
          restartCount: cs.restartCount,
          image: cs.image,
          state: cs.state,
          lastState: cs.lastState,
        }));

        const totalRestarts = containerStatuses.reduce(
          (acc: number, c: any) => acc + (c.restartCount || 0),
          0
        );

        const isReady =
          (p.status?.conditions || []).find((c: any) => c.type === 'Ready')?.status === 'True';

        return {
          name: p.metadata?.name,
          namespace: p.metadata?.namespace,
          phase: p.status?.phase,
          ready: isReady,
          restartCount: totalRestarts,
          nodeName: p.spec?.nodeName,
          startTime: p.status?.startTime,
          ownerReferences: (p.metadata?.ownerReferences || []).map((o: any) => ({
            kind: o.kind,
            name: o.name,
          })),
          conditions: (p.status?.conditions || []).map((c: any) => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
            message: c.message,
          })),
          containerStatuses,
        };
      });

      return { pods: formattedPods };
    } catch (err: any) {
      throw new Error(
        `Failed to query pods in namespace '${params.namespace}': ${err.body?.message || err.message || err}`
      );
    }
  }

  async getPodEvents(params: PodEventsParams): Promise<unknown> {
    try {
      const eventList = await this.coreApi.listNamespacedEvent({
        namespace: params.namespace,
      });

      let items = eventList.items || [];

      // Filter by target pod or object name if requested
      if (params.podName || params.involvedObjectName) {
        const target = params.podName || params.involvedObjectName;
        items = items.filter((e: any) => e.involvedObject?.name?.includes(target!));
      }

      // Sort: Warnings first, then by lastTimestamp descending
      items.sort((a: any, b: any) => {
        if (a.type === 'Warning' && b.type !== 'Warning') return -1;
        if (b.type === 'Warning' && a.type !== 'Warning') return 1;
        const timeA = new Date(a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp || 0).getTime();
        const timeB = new Date(b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp || 0).getTime();
        return timeB - timeA;
      });

      const formattedEvents = items.slice(0, 20).map((e: any) => ({
        type: e.type,
        reason: e.reason,
        message: e.message,
        count: e.count || 1,
        involvedObject: {
          kind: e.involvedObject?.kind,
          name: e.involvedObject?.name,
        },
        firstTimestamp: e.firstTimestamp,
        lastTimestamp: e.lastTimestamp || e.metadata?.creationTimestamp,
      }));

      return { events: formattedEvents };
    } catch (err: any) {
      throw new Error(
        `Failed to retrieve events in namespace '${params.namespace}': ${err.body?.message || err.message || err}`
      );
    }
  }

  async getContainerLogs(params: ContainerLogsParams): Promise<unknown> {
    try {
      const tailLines = params.tailLines ?? 100;
      const logs = await this.coreApi.readNamespacedPodLog({
        name: params.podName,
        namespace: params.namespace,
        container: params.containerName,
        tailLines,
      });

      return {
        podName: params.podName,
        containerName: params.containerName || 'default',
        tailLines,
        logs: typeof logs === 'string' ? logs : String(logs),
      };
    } catch (err: any) {
      throw new Error(
        `Failed to retrieve logs for pod '${params.podName}' in namespace '${params.namespace}': ${err.body?.message || err.message || err}`
      );
    }
  }

  async getResourceUsage(params: ResourceUsageParams): Promise<unknown> {
    try {
      let rawPods: any[] = [];
      if (params.podName) {
        try {
          const pod = await this.coreApi.readNamespacedPod({
            name: params.podName,
            namespace: params.namespace,
          });
          rawPods = [pod];
        } catch {
          const list = await this.coreApi.listNamespacedPod({ namespace: params.namespace });
          rawPods = (list.items || []).filter((p: any) => p.metadata?.name?.includes(params.podName!));
        }
      } else {
        const list = await this.coreApi.listNamespacedPod({ namespace: params.namespace });
        rawPods = list.items || [];
      }

      const usages = rawPods.map((p: any) => {
        const containers = (p.spec?.containers || []).map((c: any) => ({
          name: c.name,
          requests: c.resources?.requests || {},
          limits: c.resources?.limits || {},
        }));

        return {
          podName: p.metadata?.name,
          namespace: p.metadata?.namespace,
          containers,
        };
      });

      return { usages };
    } catch (err: any) {
      throw new Error(
        `Failed to query resource configuration in namespace '${params.namespace}': ${err.body?.message || err.message || err}`
      );
    }
  }

  async getWorkloadConfig(params: WorkloadConfigParams): Promise<unknown> {
    const kind = params.kind?.toLowerCase();

    const sanitizeEnvVars = (envList?: any[]) => {
      if (!envList || !Array.isArray(envList)) return [];
      return envList.map((e) => {
        const isSensitive = /key|secret|token|password|auth|pwd|credential|api_key/i.test(e.name || '');
        if (e.valueFrom) {
          return { name: e.name, source: Object.keys(e.valueFrom)[0] };
        }
        return {
          name: e.name,
          value: isSensitive ? '[REDACTED]' : e.value,
        };
      });
    };

    const formatContainers = (containers?: any[]) => {
      return (containers || []).map((c: any) => ({
        name: c.name,
        image: c.image,
        imagePullPolicy: c.imagePullPolicy || 'IfNotPresent',
        command: c.command,
        args: c.args,
        resources: {
          requests: c.resources?.requests || {},
          limits: c.resources?.limits || {},
        },
        env: sanitizeEnvVars(c.env),
      }));
    };

    try {
      // 1. Explicit or attempted Job lookup
      if (kind === 'job' || (!kind && (params.name.includes('job') || params.name.includes('migrate')))) {
        try {
          const job = await this.batchApi.readNamespacedJob({
            name: params.name,
            namespace: params.namespace,
          });
          return {
            kind: 'Job',
            name: job.metadata?.name,
            namespace: job.metadata?.namespace,
            ownerReferences: (job.metadata?.ownerReferences || []).map((o: any) => ({
              kind: o.kind,
              name: o.name,
            })),
            completions: job.spec?.completions,
            parallelism: job.spec?.parallelism,
            backoffLimit: job.spec?.backoffLimit,
            active: job.status?.active,
            succeeded: job.status?.succeeded,
            failed: job.status?.failed,
            restartPolicy: job.spec?.template?.spec?.restartPolicy,
            containers: formatContainers(job.spec?.template?.spec?.containers),
            initContainers: formatContainers(job.spec?.template?.spec?.initContainers),
          };
        } catch (err: any) {
          if (kind === 'job') {
            throw new Error(`Job '${params.name}' not found in namespace '${params.namespace}': ${err.body?.message || err.message}`);
          }
        }
      }

      // 2. Explicit or attempted CronJob lookup
      if (kind === 'cronjob') {
        const cron = await this.batchApi.readNamespacedCronJob({
          name: params.name,
          namespace: params.namespace,
        });
        return {
          kind: 'CronJob',
          name: cron.metadata?.name,
          namespace: cron.metadata?.namespace,
          schedule: cron.spec?.schedule,
          suspend: cron.spec?.suspend,
          containers: formatContainers(cron.spec?.jobTemplate?.spec?.template?.spec?.containers),
        };
      }

      // 3. Deployment lookup (default or explicit)
      try {
        const dep = await this.appsApi.readNamespacedDeployment({
          name: params.name,
          namespace: params.namespace,
        });
        return {
          kind: 'Deployment',
          name: dep.metadata?.name,
          namespace: dep.metadata?.namespace,
          replicas: dep.spec?.replicas,
          strategy: dep.spec?.strategy?.type,
          ownerReferences: (dep.metadata?.ownerReferences || []).map((o: any) => ({
            kind: o.kind,
            name: o.name,
          })),
          containers: formatContainers(dep.spec?.template?.spec?.containers),
          initContainers: formatContainers(dep.spec?.template?.spec?.initContainers),
        };
      } catch (err: any) {
        // If kind was not specified, try Job as fallback
        if (!kind) {
          try {
            const job = await this.batchApi.readNamespacedJob({
              name: params.name,
              namespace: params.namespace,
            });
            return {
              kind: 'Job',
              name: job.metadata?.name,
              namespace: job.metadata?.namespace,
              ownerReferences: (job.metadata?.ownerReferences || []).map((o: any) => ({
                kind: o.kind,
                name: o.name,
              })),
              backoffLimit: job.spec?.backoffLimit,
              restartPolicy: job.spec?.template?.spec?.restartPolicy,
              containers: formatContainers(job.spec?.template?.spec?.containers),
            };
          } catch {}
        }
        throw new Error(
          `Workload '${params.name}' (${kind || 'deployment/job'}) not found in namespace '${params.namespace}': ${err.body?.message || err.message}`
        );
      }
    } catch (err: any) {
      throw new Error(`Failed to query workload config '${params.name}' in namespace '${params.namespace}': ${err.message || err}`);
    }
  }
}
