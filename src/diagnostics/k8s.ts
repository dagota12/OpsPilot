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
  NodeStatusParams,
  NodeEventsParams,
  ServiceStatusParams,
  EndpointsStatusParams,
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

  async getNodeStatus(params: NodeStatusParams): Promise<unknown> {
    try {
      let rawNodes: any[] = [];
      if (params.nodeName) {
        try {
          const node = await this.coreApi.readNode({ name: params.nodeName });
          rawNodes = [node];
        } catch {
          const list = await this.coreApi.listNode({});
          rawNodes = (list.items || []).filter((n: any) => n.metadata?.name?.includes(params.nodeName!));
        }
      } else {
        const list = await this.coreApi.listNode({});
        rawNodes = list.items || [];
      }

      const nodes = rawNodes.map((n: any) => {
        const conditions = (n.status?.conditions || []).map((c: any) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
          lastTransitionTime: c.lastTransitionTime,
        }));

        const isReady = conditions.find((c: any) => c.type === 'Ready')?.status === 'True';

        // Extract roles from labels (e.g. node-role.kubernetes.io/control-plane)
        const labels = n.metadata?.labels || {};
        const roles = Object.keys(labels)
          .filter((k) => k.startsWith('node-role.kubernetes.io/'))
          .map((k) => k.replace('node-role.kubernetes.io/', ''));

        return {
          name: n.metadata?.name,
          ready: isReady,
          roles: roles.length > 0 ? roles : ['worker'],
          conditions,
          taints: (n.spec?.taints || []).map((t: any) => ({
            key: t.key,
            value: t.value,
            effect: t.effect,
          })),
          addresses: (n.status?.addresses || []).map((a: any) => ({
            type: a.type,
            address: a.address,
          })),
          nodeInfo: {
            kubeletVersion: n.status?.nodeInfo?.kubeletVersion,
            osImage: n.status?.nodeInfo?.osImage,
            containerRuntimeVersion: n.status?.nodeInfo?.containerRuntimeVersion,
            kernelVersion: n.status?.nodeInfo?.kernelVersion,
            architecture: n.status?.nodeInfo?.architecture,
            bootID: n.status?.nodeInfo?.bootID,
          },
          capacity: n.status?.capacity,
          allocatable: n.status?.allocatable,
        };
      });

      return { nodes };
    } catch (err: any) {
      throw new Error(`Failed to query node status: ${err.body?.message || err.message || err}`);
    }
  }

  async getNodeEvents(params: NodeEventsParams): Promise<unknown> {
    try {
      let rawEvents: any[] = [];
      try {
        const eventList = await this.coreApi.listEventForAllNamespaces({
          fieldSelector: 'involvedObject.kind=Node',
        });
        rawEvents = eventList.items || [];
      } catch {
        // Fallback to cluster default namespace if all-namespaces list is restricted
        try {
          const defaultList = await this.coreApi.listNamespacedEvent({ namespace: 'default' });
          rawEvents = (defaultList.items || []).filter((e: any) => e.involvedObject?.kind === 'Node');
        } catch {
          rawEvents = [];
        }
      }

      if (params.nodeName) {
        rawEvents = rawEvents.filter(
          (e: any) =>
            e.involvedObject?.name === params.nodeName ||
            e.involvedObject?.name?.includes(params.nodeName!)
        );
      }

      // Sort warnings ahead of normal, then newest timestamp
      rawEvents.sort((a: any, b: any) => {
        if (a.type === 'Warning' && b.type !== 'Warning') return -1;
        if (b.type === 'Warning' && a.type !== 'Warning') return 1;
        const timeA = new Date(a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp || 0).getTime();
        const timeB = new Date(b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp || 0).getTime();
        return timeB - timeA;
      });

      const limit = params.limit ?? 30;
      const formattedEvents = rawEvents.slice(0, limit).map((e: any) => ({
        type: e.type,
        reason: e.reason,
        message: e.message,
        count: e.count || 1,
        firstTimestamp: e.firstTimestamp,
        lastTimestamp: e.lastTimestamp || e.eventTime,
        involvedObject: {
          kind: e.involvedObject?.kind,
          name: e.involvedObject?.name,
        },
      }));

      return {
        nodeName: params.nodeName,
        totalEventsCount: rawEvents.length,
        events: formattedEvents,
        retentionNote:
          'Kubernetes API events are retained for 1 hour by default. Older historical events may have expired. If confirming historical node interruptions or reboots is required, inspect host systemd journal logs (e.g. journalctl -u kubelet).',
      };
    } catch (err: any) {
      throw new Error(`Failed to query node events: ${err.body?.message || err.message || err}`);
    }
  }

  async getServiceStatus(params: ServiceStatusParams): Promise<unknown> {
    try {
      let rawServices: any[] = [];
      if (params.serviceName) {
        try {
          const svc = await this.coreApi.readNamespacedService({
            name: params.serviceName,
            namespace: params.namespace,
          });
          rawServices = [svc];
        } catch {
          const list = await this.coreApi.listNamespacedService({
            namespace: params.namespace,
          });
          rawServices = (list.items || []).filter((s: any) =>
            s.metadata?.name?.includes(params.serviceName!)
          );
        }
      } else {
        const list = await this.coreApi.listNamespacedService({
          namespace: params.namespace,
        });
        rawServices = list.items || [];
      }

      if (rawServices.length === 0) {
        throw new Error(
          params.serviceName
            ? `Service '${params.serviceName}' not found in namespace '${params.namespace}'`
            : `No services found in namespace '${params.namespace}'`
        );
      }

      const services = rawServices.map((s: any) => ({
        name: s.metadata?.name,
        namespace: s.metadata?.namespace,
        type: s.spec?.type || 'ClusterIP',
        clusterIP: s.spec?.clusterIP,
        externalIPs: s.spec?.externalIPs,
        selector: s.spec?.selector || {},
        ports: (s.spec?.ports || []).map((p: any) => ({
          name: p.name,
          port: p.port,
          targetPort: p.targetPort,
          protocol: p.protocol || 'TCP',
          nodePort: p.nodePort,
        })),
        sessionAffinity: s.spec?.sessionAffinity,
        creationTimestamp: s.metadata?.creationTimestamp,
      }));

      return {
        namespace: params.namespace,
        totalServices: services.length,
        services,
      };
    } catch (err: any) {
      throw new Error(`Failed to query service status: ${err.body?.message || err.message || err}`);
    }
  }

  async getEndpointsStatus(params: EndpointsStatusParams): Promise<unknown> {
    try {
      let rawEndpoints: any[] = [];
      if (params.serviceName) {
        try {
          const ep = await this.coreApi.readNamespacedEndpoints({
            name: params.serviceName,
            namespace: params.namespace,
          });
          rawEndpoints = [ep];
        } catch {
          const list = await this.coreApi.listNamespacedEndpoints({
            namespace: params.namespace,
          });
          rawEndpoints = (list.items || []).filter((e: any) =>
            e.metadata?.name?.includes(params.serviceName!)
          );
        }
      } else {
        const list = await this.coreApi.listNamespacedEndpoints({
          namespace: params.namespace,
        });
        rawEndpoints = list.items || [];
      }

      if (rawEndpoints.length === 0) {
        throw new Error(
          params.serviceName
            ? `Endpoints for service '${params.serviceName}' not found in namespace '${params.namespace}'`
            : `No endpoints found in namespace '${params.namespace}'`
        );
      }

      const endpoints = rawEndpoints.map((ep: any) => {
        const subsets = ep.subsets || [];
        let readyCount = 0;
        let notReadyCount = 0;

        const formattedSubsets = subsets.map((sub: any) => {
          const readyAddresses = (sub.addresses || []).map((a: any) => {
            readyCount++;
            return {
              ip: a.ip,
              targetPodName: a.targetRef?.name,
              nodeName: a.nodeName,
            };
          });

          const notReadyAddresses = (sub.notReadyAddresses || []).map((a: any) => {
            notReadyCount++;
            return {
              ip: a.ip,
              targetPodName: a.targetRef?.name,
              nodeName: a.nodeName,
            };
          });

          const ports = (sub.ports || []).map((p: any) => ({
            name: p.name,
            port: p.port,
            protocol: p.protocol || 'TCP',
          }));

          return { readyAddresses, notReadyAddresses, ports };
        });

        let warning: string | undefined;
        if (readyCount === 0) {
          if (notReadyCount > 0) {
            warning = `Service '${ep.metadata?.name}' has ${notReadyCount} backend pod(s), but ALL are in NotReady state. Check pod readiness probes and container logs.`;
          } else {
            warning = `Service '${ep.metadata?.name}' has 0 endpoints! No pods match the service's selector or no matching pods are running.`;
          }
        }

        return {
          serviceName: ep.metadata?.name,
          namespace: ep.metadata?.namespace,
          hasEndpoints: readyCount > 0 || notReadyCount > 0,
          readyEndpointsCount: readyCount,
          notReadyEndpointsCount: notReadyCount,
          warning,
          subsets: formattedSubsets,
        };
      });

      return {
        namespace: params.namespace,
        endpoints,
      };
    } catch (err: any) {
      throw new Error(`Failed to query endpoints status: ${err.body?.message || err.message || err}`);
    }
  }
}

