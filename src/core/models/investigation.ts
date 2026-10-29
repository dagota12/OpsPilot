import type { IncidentReport, Evidence } from './report.js';

export type InvestigationStatus =
  | 'IDLE'
  | 'INVESTIGATING'
  | 'COMPLETED'
  | 'BUDGET_EXHAUSTED'
  | 'TIMEOUT'
  | 'POLICY_DENIAL'
  | 'FAILED'
  | 'CANCELLED';

export interface AuditEntry {
  timestamp: number;
  type: 'TOOL_REQUEST' | 'TOOL_RESULT' | 'POLICY_DENIAL' | 'ERROR' | 'STATUS_CHANGE';
  details: Record<string, unknown>;
}

export interface InvestigationRun {
  id: string;
  prompt: string;
  namespace?: string;
  status: InvestigationStatus;
  startedAt: number;
  completedAt?: number;
  terminationReason?: string;
  toolCallCount: number;
  evidence: Evidence[];
  report?: IncidentReport;
  auditLog: AuditEntry[];
}

export interface InvestigationOptions {
  maxToolCalls?: number;
  maxDurationMs?: number;
  targetNamespace?: string;
  allowedNamespaces?: string[];
  maxOutputSizeBytes?: number;
  perToolTimeoutMs?: number;
  onProgress?: (event: AuditEntry) => void;
}
