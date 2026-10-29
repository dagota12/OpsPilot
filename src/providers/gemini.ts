import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  ToolCallRequest,
  TokenUsage,
} from '../core/providers/interface.js';
import type { ToolDefinition } from '../core/tools/types.js';
import type { IncidentReport } from '../core/models/report.js';

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  client?: any; // For test mocking without network or API key
}

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini';
  private client: any;
  private model: string;
  private signatureCache = new Map<string, string>();

  constructor(options: GeminiProviderOptions = {}) {
    try {
      process.loadEnvFile?.();
    } catch {}

    const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    this.model = options.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash';

    if (options.client) {
      this.client = options.client;
    } else {
      if (!apiKey) {
        throw new Error(
          'Gemini API key is required. Please set the GEMINI_API_KEY environment variable or pass apiKey in options.'
        );
      }
      this.client = new GoogleGenAI({ apiKey });
    }
  }

  async chat(options: {
    messages: AIMessage[];
    tools: ToolDefinition[];
    abortSignal?: AbortSignal;
  }): Promise<AIResponse> {
    if (options.abortSignal?.aborted) {
      throw new Error('Chat operation was aborted');
    }

    const { systemInstruction, contents } = this.convertMessages(options.messages);
    const functionDeclarations = this.convertTools(options.tools);

    const config: Record<string, any> = {};

    const systemPromptSuffix = `
When you have collected sufficient evidence and are ready to conclude the investigation, provide your final report as a valid JSON object in a \`\`\`json ... \`\`\` code block matching this schema:
{
  "summary": "Clear summary of the incident",
  "observedFacts": [{ "id": "fact_1", "statement": "Fact description", "evidenceRef": ["tool_name"] }],
  "hypotheses": [{ "id": "hypo_1", "statement": "Hypothesis description", "likelihood": "high"|"medium"|"low", "reasoning": "Explanation" }],
  "recommendations": ["Actionable next steps for the operator"],
  "confidence": "high"|"medium"|"low",
  "uncertaintyNotes": "Optional description of missing or incomplete evidence"
}`;

    const effectiveSystemInstruction = systemInstruction
      ? `${systemInstruction}\n\n${systemPromptSuffix}`
      : systemPromptSuffix;

    config.systemInstruction = {
      parts: [{ text: effectiveSystemInstruction }],
    };

    if (functionDeclarations.length > 0) {
      config.tools = [{ functionDeclarations }];
    }

    const maxRetries = 2;
    let attempt = 0;

    while (true) {
      attempt++;
      try {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents,
          config,
        });

        return this.parseGeminiResponse(response);
      } catch (err: any) {
        if (options.abortSignal?.aborted || err.name === 'AbortError') {
          throw new Error('Chat operation was aborted');
        }

        const message = err.message || String(err);
        const isTransient = message.includes('503') || message.includes('UNAVAILABLE') || message.includes('429');

        if (isTransient && attempt <= maxRetries) {
          const delayMs = attempt * 1500;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        // Format helpful error messages without leaking secret tokens
        if (message.includes('API_KEY_INVALID') || message.includes('401') || message.includes('403')) {
          throw new Error('Gemini API authentication failed. Please verify your GEMINI_API_KEY.');
        }
        if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
          throw new Error('Gemini rate limit exceeded (429). Please retry later or check quota.');
        }

        throw new Error(`Gemini API error: ${message}`);
      }
    }
  }

  private convertMessages(messages: AIMessage[]): {
    systemInstruction?: string;
    contents: Array<{ role: string; parts: any[] }>;
  } {
    let systemInstruction: string | undefined;
    const contents: Array<{ role: string; parts: any[] }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = systemInstruction ? `${systemInstruction}\n${msg.content}` : msg.content;
        continue;
      }

      if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
        
      } else if (msg.role === 'assistant') {
        const parts: any[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            const signature =
              (tc.metadata?.thoughtSignature as string | undefined) ||
              this.signatureCache.get(tc.id) ||
              this.signatureCache.get(tc.name);

            const part: any = {
              functionCall: {
                name: tc.name,
                args: tc.arguments,
              },
            };
            if (signature) {
              part.thoughtSignature = signature;
            }
            parts.push(part);
          }
        }
        contents.push({
          role: 'model',
          parts,
        });
      } else if (msg.role === 'tool') {
        let outputData: unknown;
        try {
          outputData = JSON.parse(msg.content);
        } catch {
          outputData = msg.content;
        }

        const functionResponsePart = {
          functionResponse: {
            name: msg.toolName,
            response: {
              output: outputData,
            },
          },
        };

        // Merge consecutive tool responses into a single user turn so Gemini doesn't reject multiturn ordering
        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === 'user' && lastContent.parts.some((p) => p.functionResponse)) {
          lastContent.parts.push(functionResponsePart);
        } else {
          contents.push({
            role: 'user',
            parts: [functionResponsePart],
          });
        }
      }
    }

    return { systemInstruction, contents };
  }

  private convertTools(tools: ToolDefinition[]): Array<{ name: string; description: string; parameters: any }> {
    return tools.map((tool) => {
      const rawSchema = z.toJSONSchema(tool.parameters) as Record<string, any>;
      const cleanSchema = cleanSchemaForGemini(rawSchema);

      return {
        name: tool.name,
        description: tool.description,
        parameters: cleanSchema,
      };
    });
  }

  private parseGeminiResponse(response: any): AIResponse {
    const candidate = response?.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const toolCalls: ToolCallRequest[] = [];
    let textContent = '';

    for (const part of parts) {
      if (part.text) {
        textContent += part.text;
      }
      if (part.functionCall) {
        const id =
          part.functionCall.id ||
          `call_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

        if (part.thoughtSignature) {
          this.signatureCache.set(id, part.thoughtSignature);
          this.signatureCache.set(part.functionCall.name, part.thoughtSignature);
        }

        toolCalls.push({
          id,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
          metadata: part.thoughtSignature
            ? { thoughtSignature: part.thoughtSignature }
            : undefined,
        });
      }
    }

    // Usage metrics
    const usageMetadata = response?.usageMetadata;
    const usage: TokenUsage | undefined = usageMetadata
      ? {
          promptTokens: usageMetadata.promptTokenCount,
          completionTokens: usageMetadata.candidatesTokenCount,
          totalTokens: usageMetadata.totalTokenCount,
        }
      : undefined;

    // Check if the text contains a structured IncidentReport
    const report = extractReportFromText(textContent);

    return {
      content: textContent.trim() || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      report,
      usage,
    };
  }
}

export function extractReportFromText(text: string): IncidentReport | undefined {
  if (!text) return undefined;

  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidateJson = jsonBlockMatch ? jsonBlockMatch[1] : text;

  try {
    const parsed = JSON.parse(candidateJson || text);
    if (parsed && typeof parsed === 'object' && 'summary' in parsed && Array.isArray(parsed.observedFacts)) {
      return {
        id: parsed.id || `rep_${Date.now()}`,
        summary: String(parsed.summary),
        observedFacts: parsed.observedFacts.map((f: any, idx: number) => ({
          id: f.id || `fact_${idx + 1}`,
          statement: String(f.statement || ''),
          evidenceRef: Array.isArray(f.evidenceRef) ? f.evidenceRef.map(String) : [],
        })),
        hypotheses: Array.isArray(parsed.hypotheses)
          ? parsed.hypotheses.map((h: any, idx: number) => ({
              id: h.id || `hypo_${idx + 1}`,
              statement: String(h.statement || ''),
              likelihood: ['high', 'medium', 'low'].includes(h.likelihood) ? h.likelihood : 'medium',
              reasoning: String(h.reasoning || ''),
            }))
          : [],
        recommendations: Array.isArray(parsed.recommendations)
          ? parsed.recommendations.map((r: any) =>
              typeof r === 'string'
                ? r
                : String(r?.action || r?.description || r?.statement || r?.text || r?.title || JSON.stringify(r))
            )
          : [],
        confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
        uncertaintyNotes: parsed.uncertaintyNotes ? String(parsed.uncertaintyNotes) : undefined,
        diagnosticGaps: Array.isArray(parsed.diagnosticGaps) ? parsed.diagnosticGaps.map(String) : undefined,
        investigationTrace: Array.isArray(parsed.investigationTrace)
          ? parsed.investigationTrace.map((t: any) => ({
              toolName: String(t.toolName || ''),
              success: Boolean(t.success),
              summary: String(t.summary || ''),
            }))
          : undefined,
      };
    }
  } catch {
    // Return undefined if not a JSON report
  }

  return undefined;
}

export function cleanSchemaForGemini(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(cleanSchemaForGemini);
  }

  const allowedFields = new Set([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'properties',
    'required',
    'items',
  ]);

  const cleaned: Record<string, any> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (!allowedFields.has(key)) {
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const cleanedProperties: Record<string, any> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        cleanedProperties[propName] = cleanSchemaForGemini(propSchema);
      }
      cleaned[key] = cleanedProperties;
    } else if (key === 'items') {
      cleaned[key] = cleanSchemaForGemini(value);
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}
