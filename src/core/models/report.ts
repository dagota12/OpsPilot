export interface Fact {
  id: string;
  statement: string;
  evidenceRef: string[];
}

export type Likelihood = 'high' | 'medium' | 'low';
export type Confidence = 'high' | 'medium' | 'low';

export interface Hypothesis {
  id: string;
  statement: string;
  likelihood: Likelihood;
  reasoning: string;
}

export interface IncidentReport {
  id: string;
  summary: string;
  observedFacts: Fact[];
  hypotheses: Hypothesis[];
  recommendations: string[];
  confidence: Confidence;
  uncertaintyNotes?: string;
}

export interface Evidence {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  output: unknown;
  timestamp: number;
}
