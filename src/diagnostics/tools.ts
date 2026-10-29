import { z } from 'zod';
import type { DiagnosticTool, ToolExecutionContext, ToolResult } from '../core/tools/types.js';
import type { DiagnosticBackend } from './interface.js';

export function createStandardTools(backend: DiagnosticBackend): DiagnosticTool[] {
  const getDeploymentStatusTool: DiagnosticTool<{ namespace: string; deploymentName: string }> = {
    definition: {
      name: 'get_deployment_status',
      description: 'Inspect deployment state, replica status, and rollout conditions.',
      parameters: z.object({
        namespace: z.string().min(1, 'Namespace must not be empty'),
        deploymentName: z.string().min(1, 'Deployment name must not be empty'),
      }),
    },
    isReadOnly: true,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const start = Date.now();
      try {
        const data = await backend.getDeploymentStatus(params);
        return { success: true, data, executionTimeMs: Date.now() - start };
      } catch (err: any) {
        return { success: false, error: err.message || String(err), executionTimeMs: Date.now() - start };
      }
    },
  };

  const getPodStatusTool: DiagnosticTool<{ namespace: string; podName?: string; labelSelector?: string }> = {
    definition: {
      name: 'get_pod_status',
      description: 'Inspect pod phase, readiness, restart counts, and container termination states.',
      parameters: z.object({
        namespace: z.string().min(1, 'Namespace must not be empty'),
        podName: z.string().optional(),
        labelSelector: z.string().optional(),
      }),
    },
    isReadOnly: true,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const start = Date.now();
      try {
        const data = await backend.getPodStatus(params);
        return { success: true, data, executionTimeMs: Date.now() - start };
      } catch (err: any) {
        return { success: false, error: err.message || String(err), executionTimeMs: Date.now() - start };
      }
    },
  };

  const getPodEventsTool: DiagnosticTool<{ namespace: string; podName?: string; involvedObjectName?: string }> = {
    definition: {
      name: 'get_pod_events',
      description: 'Retrieve relevant Kubernetes warning and lifecycle events for pods or resources.',
      parameters: z.object({
        namespace: z.string().min(1, 'Namespace must not be empty'),
        podName: z.string().optional(),
        involvedObjectName: z.string().optional(),
      }),
    },
    isReadOnly: true,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const start = Date.now();
      try {
        const data = await backend.getPodEvents(params);
        return { success: true, data, executionTimeMs: Date.now() - start };
      } catch (err: any) {
        return { success: false, error: err.message || String(err), executionTimeMs: Date.now() - start };
      }
    },
  };

  const getContainerLogsTool: DiagnosticTool<{ namespace: string; podName: string; containerName?: string; tailLines?: number }> = {
    definition: {
      name: 'get_container_logs',
      description: 'Retrieve bounded container logs (stdout/stderr) from a target pod.',
      parameters: z.object({
        namespace: z.string().min(1, 'Namespace must not be empty'),
        podName: z.string().min(1, 'Pod name must not be empty'),
        containerName: z.string().optional(),
        tailLines: z.number().int().positive().max(1000).optional().default(100),
      }),
    },
    isReadOnly: true,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const start = Date.now();
      try {
        const data = await backend.getContainerLogs(params);
        return { success: true, data, executionTimeMs: Date.now() - start };
      } catch (err: any) {
        return { success: false, error: err.message || String(err), executionTimeMs: Date.now() - start };
      }
    },
  };

  const getResourceUsageTool: DiagnosticTool<{ namespace: string; podName?: string }> = {
    definition: {
      name: 'get_resource_usage',
      description: 'Retrieve CPU and memory usage statistics and limits for pods in a namespace.',
      parameters: z.object({
        namespace: z.string().min(1, 'Namespace must not be empty'),
        podName: z.string().optional(),
      }),
    },
    isReadOnly: true,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const start = Date.now();
      try {
        const data = await backend.getResourceUsage(params);
        return { success: true, data, executionTimeMs: Date.now() - start };
      } catch (err: any) {
        return { success: false, error: err.message || String(err), executionTimeMs: Date.now() - start };
      }
    },
  };

  const getWorkloadConfigTool: DiagnosticTool<{ namespace: string; name: string; kind?: 'deployment' | 'job' | 'cronjob' | 'statefulset' | 'daemonset' }> = {
    definition: {
      name: 'get_workload_config',
      description: 'Inspect workload specifications (Deployment, Job, CronJob) including container images, pull policies, commands, args, and resource limits.',
      parameters: z.object({
        namespace: z.string().min(1, 'Namespace must not be empty'),
        name: z.string().min(1, 'Workload name must not be empty'),
        kind: z.enum(['deployment', 'job', 'cronjob', 'statefulset', 'daemonset']).optional(),
      }),
    },
    isReadOnly: true,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const start = Date.now();
      try {
        const data = await backend.getWorkloadConfig(params);
        return { success: true, data, executionTimeMs: Date.now() - start };
      } catch (err: any) {
        return { success: false, error: err.message || String(err), executionTimeMs: Date.now() - start };
      }
    },
  };

  const getNodeStatusTool: DiagnosticTool<{ nodeName?: string; namespace?: string }> = {
    definition: {
      name: 'get_node_status',
      description: 'Inspect Kubernetes node readiness, conditions (MemoryPressure, DiskPressure, PIDPressure), taints, and node metadata.',
      parameters: z.object({
        nodeName: z.string().optional(),
        namespace: z.string().optional(),
      }),
    },
    isReadOnly: true,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const start = Date.now();
      try {
        const data = await backend.getNodeStatus(params);
        return { success: true, data, executionTimeMs: Date.now() - start };
      } catch (err: any) {
        return { success: false, error: err.message || String(err), executionTimeMs: Date.now() - start };
      }
    },
  };

  const getNodeEventsTool: DiagnosticTool<{ nodeName?: string; namespace?: string; limit?: number }> = {
    definition: {
      name: 'get_node_events',
      description: 'Retrieve lifecycle and warning events for Kubernetes nodes (reboots, disk/memory pressure, kubelet transitions).',
      parameters: z.object({
        nodeName: z.string().optional(),
        namespace: z.string().optional(),
        limit: z.number().int().positive().max(100).optional().default(30),
      }),
    },
    isReadOnly: true,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const start = Date.now();
      try {
        const data = await backend.getNodeEvents(params);
        return { success: true, data, executionTimeMs: Date.now() - start };
      } catch (err: any) {
        return { success: false, error: err.message || String(err), executionTimeMs: Date.now() - start };
      }
    },
  };

  return [
    getDeploymentStatusTool,
    getPodStatusTool,
    getPodEventsTool,
    getContainerLogsTool,
    getResourceUsageTool,
    getWorkloadConfigTool,
    getNodeStatusTool,
    getNodeEventsTool,
  ];
}
