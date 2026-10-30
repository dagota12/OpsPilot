import { describe, it, expect, beforeEach } from 'vitest';
import { InvestigationEngine } from '../src/core/engine/investigation-engine.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { ToolPolicy } from '../src/core/policy/policy.js';
import { MockAIProvider } from '../src/core/providers/mock.js';
import { MockDiagnosticBackend } from '../src/diagnostics/mock.js';
import { createStandardTools } from '../src/diagnostics/tools.js';

describe('User Intent & Conversational Handling', () => {
  let registry: ToolRegistry;
  let policy: ToolPolicy;
  let backend: MockDiagnosticBackend;
  let provider: MockAIProvider;

  beforeEach(() => {
    registry = new ToolRegistry();
    backend = new MockDiagnosticBackend('crashloop-missing-env');
    const tools = createStandardTools(backend);
    for (const tool of tools) {
      registry.register(tool);
    }
    policy = new ToolPolicy(registry);
    provider = new MockAIProvider({ scenarioId: 'crashloop-missing-env' });
  });

  it('handles greetings conversationally without executing tools or fabricating an incident report', async () => {
    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('hi');

    expect(run.status).toBe('COMPLETED');
    expect(run.toolCallCount).toBe(0);
    expect(run.evidence.length).toBe(0);
    expect(run.report).toBeUndefined(); // MUST NOT invent an incident report for "hi"!
    expect(run.conversationalResponse).toBeDefined();
    expect(run.conversationalResponse).toContain("I'm OpsPilot");
  });

  it('answers conceptual questions directly without executing tools or creating an incident report', async () => {
    provider.setScriptedResponses([
      {
        content: 'Exit code 255 in Kubernetes generally indicates that a container process exited with an error or was stopped unexpectedly by the runtime (such as an unhandled exception or node-level termination).',
      },
    ]);

    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('what does exit code 255 mean?');

    expect(run.status).toBe('COMPLETED');
    expect(run.toolCallCount).toBe(0);
    expect(run.evidence.length).toBe(0);
    expect(run.report).toBeUndefined(); // MUST NOT produce an incident report!
    expect(run.conversationalResponse).toContain('Exit code 255');
  });

  it('runs tools and produces an incident report when the user asks an investigation prompt', async () => {
    const engine = new InvestigationEngine({ provider, registry, policy });
    const run = await engine.investigate('Why is auth-service restarting?');

    expect(run.status).toBe('COMPLETED');
    expect(run.toolCallCount).toBeGreaterThan(0);
    expect(run.evidence.length).toBeGreaterThan(0);
    expect(run.report).toBeDefined();
    expect(run.conversationalResponse).toBeUndefined();
    expect(run.report?.summary).toContain('JWT_SECRET_KEY');
  });
});
