import type { DiagnosticTool, ToolDefinition } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, DiagnosticTool>();

  register(tool: DiagnosticTool): void {
    if (!tool.isReadOnly) {
      throw new Error(`Cannot register tool '${tool.definition.name}': OpsPilot only permits read-only tools.`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): DiagnosticTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): DiagnosticTool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }
}
