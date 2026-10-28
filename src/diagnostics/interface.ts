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

export interface DiagnosticBackend {
  getDeploymentStatus(params: DeploymentStatusParams): Promise<unknown>;
  getPodStatus(params: PodStatusParams): Promise<unknown>;
  getPodEvents(params: PodEventsParams): Promise<unknown>;
  getContainerLogs(params: ContainerLogsParams): Promise<unknown>;
  getResourceUsage(params: ResourceUsageParams): Promise<unknown>;
}
