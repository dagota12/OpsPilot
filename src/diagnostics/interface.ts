export interface DeploymentStatusParams {
  namespace: string;
  deploymentName: string;
}

export interface PodStatusParams {
  namespace: string;
  podName?: string;
  labelSelector?: string;
}

export interface PodEventsParams {
  namespace: string;
  podName?: string;
  involvedObjectName?: string;
}

export interface ContainerLogsParams {
  namespace: string;
  podName: string;
  containerName?: string;
  tailLines?: number;
}

export interface ResourceUsageParams {
  namespace: string;
  podName?: string;
}

export interface WorkloadConfigParams {
  namespace: string;
  name: string;
  kind?: 'deployment' | 'job' | 'cronjob' | 'statefulset' | 'daemonset';
}

export interface NodeStatusParams {
  nodeName?: string;
  namespace?: string;
}

export interface NodeEventsParams {
  nodeName?: string;
  namespace?: string;
  limit?: number;
}

export interface ServiceStatusParams {
  namespace: string;
  serviceName?: string;
}

export interface EndpointsStatusParams {
  namespace: string;
  serviceName?: string;
}

export interface DiagnosticBackend {
  getDeploymentStatus(params: DeploymentStatusParams): Promise<unknown>;
  getPodStatus(params: PodStatusParams): Promise<unknown>;
  getPodEvents(params: PodEventsParams): Promise<unknown>;
  getContainerLogs(params: ContainerLogsParams): Promise<unknown>;
  getResourceUsage(params: ResourceUsageParams): Promise<unknown>;
  getWorkloadConfig(params: WorkloadConfigParams): Promise<unknown>;
  getNodeStatus(params: NodeStatusParams): Promise<unknown>;
  getNodeEvents(params: NodeEventsParams): Promise<unknown>;
  getServiceStatus(params: ServiceStatusParams): Promise<unknown>;
  getEndpointsStatus(params: EndpointsStatusParams): Promise<unknown>;
}

