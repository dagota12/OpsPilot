import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { GeminiProvider, extractReportFromText, cleanSchemaForGemini } from '../src/providers/gemini.js';
import type { ToolDefinition } from '../src/core/tools/types.js';

describe('GeminiProvider Adapter', () => {
  const dummyTool: ToolDefinition = {
    name: 'get_pod_status',
    description: 'Get pod status',
    parameters: z.object({
      namespace: z.string(),
      podName: z.string().optional(),
    }),
  };

  it('sanitizes tool schema recursively removing exclusiveMinimum, default, and unhandled keywords', () => {
    const rawSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        namespace: { type: 'string', minLength: 1 },
        tailLines: { default: 100, type: 'integer', exclusiveMinimum: 0, maximum: 1000 },
      },
      required: ['namespace'],
      additionalProperties: false,
    };

    const cleaned = cleanSchemaForGemini(rawSchema);

    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.additionalProperties).toBeUndefined();
    expect(cleaned.properties.tailLines.exclusiveMinimum).toBeUndefined();
    expect(cleaned.properties.tailLines.maximum).toBeUndefined();
    expect(cleaned.properties.tailLines.default).toBeUndefined();
    expect(cleaned.properties.tailLines.type).toBe('integer');
    expect(cleaned.properties.namespace.minLength).toBeUndefined();
    expect(cleaned.properties.namespace.type).toBe('string');
  });

  it('throws a helpful configuration error if no API key is provided', () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    expect(() => new GeminiProvider({})).toThrow('Gemini API key is required');

    process.env = originalEnv;
  });

  it('translates functionCall from Gemini response into normalized ToolCallRequest', async () => {
    const mockGenerateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'get_pod_status',
                  args: { namespace: 'default', podName: 'auth-service' },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 45,
        totalTokenCount: 165,
      },
    });

    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    };

    const provider = new GeminiProvider({ client: mockClient });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Why is auth-service down?' }],
      tools: [dummyTool],
    });

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls?.length).toBe(1);
    expect(response.toolCalls?.[0]?.name).toBe('get_pod_status');
    expect(response.toolCalls?.[0]?.arguments).toEqual({
      namespace: 'default',
      podName: 'auth-service',
    });
    expect(response.usage?.totalTokens).toBe(165);
  });

  it('correctly converts consecutive tool messages into merged functionResponse parts', async () => {
    let capturedContents: any[] = [];

    const mockClient = {
      models: {
        generateContent: vi.fn().mockImplementation((req: any) => {
          capturedContents = req.contents;
          return Promise.resolve({
            candidates: [
              {
                content: {
                  parts: [{ text: 'Investigation complete' }],
                },
              },
            ],
          });
        }),
      },
    };

    const provider = new GeminiProvider({ client: mockClient });

    await provider.chat({
      messages: [
        { role: 'user', content: 'Investigate' },
        {
          role: 'assistant',
          toolCalls: [
            { id: 'c1', name: 'tool_a', arguments: { namespace: 'default' } },
            { id: 'c2', name: 'tool_b', arguments: { namespace: 'default' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', toolName: 'tool_a', content: '{"status":"ok"}' },
        { role: 'tool', toolCallId: 'c2', toolName: 'tool_b', content: '{"status":"ok2"}' },
      ],
      tools: [],
    });

    // Content turns must alternate and not produce consecutive user turns
    expect(capturedContents.length).toBe(3); // [user prompt, model tool call, user function responses]
    expect(capturedContents[0]?.role).toBe('user');
    expect(capturedContents[1]?.role).toBe('model');
    expect(capturedContents[2]?.role).toBe('user');
    // Consecutive tool messages should be merged into parts of the single user turn
    expect(capturedContents[2]?.parts.length).toBe(2);
    expect(capturedContents[2]?.parts[0]?.functionResponse?.name).toBe('tool_a');
    expect(capturedContents[2]?.parts[1]?.functionResponse?.name).toBe('tool_b');
  });

  it('extracts structured IncidentReport from final markdown JSON block', async () => {
    const reportJson = {
      summary: 'Pod crashed due to missing secret',
      observedFacts: [
        { id: 'fact_1', statement: 'Pod is CrashLoopBackOff', evidenceRef: ['c1'] },
      ],
      hypotheses: [
        { id: 'hypo_1', statement: 'JWT_SECRET is missing', likelihood: 'high', reasoning: 'Env is empty' },
      ],
      recommendations: ['Create the secret'],
      confidence: 'high',
    };

    const mockClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: `Here is the final incident report:\n\`\`\`json\n${JSON.stringify(reportJson, null, 2)}\n\`\`\``,
                  },
                ],
              },
            },
          ],
        }),
      },
    };

    const provider = new GeminiProvider({ client: mockClient });
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Finalize report' }],
      tools: [],
    });

    expect(response.report).toBeDefined();
    expect(response.report?.summary).toBe('Pod crashed due to missing secret');
    expect(response.report?.observedFacts[0]?.evidenceRef).toEqual(['c1']);
    expect(response.report?.confidence).toBe('high');
  });

  it('translates 401/403 API errors to clear authentication messages', async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn().mockRejectedValue(new Error('API_KEY_INVALID: 401 Unauthorized')),
      },
    };

    const provider = new GeminiProvider({ client: mockClient });

    await expect(
      provider.chat({
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
      })
    ).rejects.toThrow('Gemini API authentication failed. Please verify your GEMINI_API_KEY.');
  });

  it('translates 429 quota exhaustion to rate limit error', async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn().mockRejectedValue(new Error('RESOURCE_EXHAUSTED: 429')),
      },
    };

    const provider = new GeminiProvider({ client: mockClient });

    await expect(
      provider.chat({
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
      })
    ).rejects.toThrow('Gemini rate limit exceeded (429)');
  });

  it('aborts cleanly when abortSignal is triggered', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const mockClient = {
      models: {
        generateContent: vi.fn(),
      },
    };

    const provider = new GeminiProvider({ client: mockClient });

    await expect(
      provider.chat({
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
        abortSignal: abortController.signal,
      })
    ).rejects.toThrow('Chat operation was aborted');
  });

  it('runs an end-to-end multi-step investigation through InvestigationEngine using GeminiProvider', async () => {
    const { InvestigationEngine } = await import('../src/core/engine/investigation-engine.js');
    const { ToolRegistry } = await import('../src/core/tools/registry.js');
    const { ToolPolicy } = await import('../src/core/policy/policy.js');
    const { MockDiagnosticBackend } = await import('../src/diagnostics/mock.js');
    const { createStandardTools } = await import('../src/diagnostics/tools.js');

    const registry = new ToolRegistry();
    const backend = new MockDiagnosticBackend('crashloop-missing-env');
    const tools = createStandardTools(backend);
    for (const t of tools) registry.register(t);
    const policy = new ToolPolicy(registry);

    let step = 0;
    const mockClient = {
      models: {
        generateContent: vi.fn().mockImplementation(() => {
          step++;
          if (step === 1) {
            return Promise.resolve({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          id: 'gemini_call_1',
                          name: 'get_pod_status',
                          args: { namespace: 'default', podName: 'auth-service' },
                        },
                      },
                    ],
                  },
                },
              ],
            });
          }
          if (step === 2) {
            return Promise.resolve({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          id: 'gemini_call_2',
                          name: 'get_container_logs',
                          args: { namespace: 'default', podName: 'auth-service-789f68cb-abcde' },
                        },
                      },
                    ],
                  },
                },
              ],
            });
          }
          // Final report
          return Promise.resolve({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: `Investigation complete:
\`\`\`json
{
  "summary": "auth-service crashed because JWT_SECRET_KEY is undefined",
  "observedFacts": [
    { "id": "f1", "statement": "Pod is in CrashLoopBackOff", "evidenceRef": ["gemini_call_1"] },
    { "id": "f2", "statement": "Logs show FATAL missing JWT_SECRET_KEY", "evidenceRef": ["gemini_call_2"] }
  ],
  "hypotheses": [
    { "id": "h1", "statement": "Secret not mounted", "likelihood": "high", "reasoning": "Missing env var" }
  ],
  "recommendations": ["Add JWT_SECRET_KEY to secret"],
  "confidence": "high"
}
\`\`\``,
                    },
                  ],
                },
              },
            ],
          });
        }),
      },
    };

    const provider = new GeminiProvider({ client: mockClient });
    const engine = new InvestigationEngine({ provider, registry, policy });

    const run = await engine.investigate('Why is auth-service restarting?');

    expect(run.status).toBe('COMPLETED');
    expect(run.toolCallCount).toBe(2);
    expect(run.evidence.length).toBe(2);
    expect(run.report).toBeDefined();
    expect(run.report?.summary).toContain('JWT_SECRET_KEY');
    expect(run.report?.observedFacts[0]?.evidenceRef).toEqual(['gemini_call_1']);
    expect(run.report?.observedFacts[1]?.evidenceRef).toEqual(['gemini_call_2']);
    expect(run.report?.confidence).toBe('high');
  });
});
