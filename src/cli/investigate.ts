import { Command } from 'commander';
import { InvestigationEngine } from '../core/engine/investigation-engine.js';
import { ToolRegistry } from '../core/tools/registry.js';
import { ToolPolicy } from '../core/policy/policy.js';
import { MockAIProvider } from '../core/providers/mock.js';
import { GeminiProvider } from '../providers/gemini.js';
import type { AIProvider } from '../core/providers/interface.js';
import { MockDiagnosticBackend, MOCK_SCENARIOS } from '../diagnostics/mock.js';
import { createStandardTools } from '../diagnostics/tools.js';

export function registerInvestigateCommand(program: Command): void {
  program
    .command('investigate')
    .description('Investigate an infrastructure incident using diagnostic evidence')
    .argument('<prompt>', 'Incident description (e.g. "Why is auth-service restarting?")')
    .option('-n, --namespace <namespace>', 'Target Kubernetes namespace', 'default')
    .option('-p, --provider <provider>', 'AI provider to use (mock | gemini)', 'mock')
    .option('-m, --model <model>', 'Gemini model name (e.g. gemini-2.5-flash)', 'gemini-2.5-flash')
    .option(
      '-s, --scenario <scenario>',
      'Mock incident scenario (crashloop-missing-env | oom-killed | failed-readiness-probe)',
      'crashloop-missing-env'
    )
    .option('--max-tools <count>', 'Maximum tool-call budget', '10')
    .action(async (prompt: string, options: { namespace: string; scenario: string; maxTools: string; provider: string; model: string }) => {
      const scenarioKey = options.scenario as keyof typeof MOCK_SCENARIOS;
      if (!MOCK_SCENARIOS[scenarioKey]) {
        console.error(`Error: Unknown scenario '${options.scenario}'. Available: ${Object.keys(MOCK_SCENARIOS).join(', ')}`);
        process.exit(1);
      }

      console.log(`\n======================================================`);
      console.log(`  OpsPilot Incident Investigation`);
      console.log(`======================================================`);
      console.log(`Prompt:       "${prompt}"`);
      console.log(`Provider:     ${options.provider}`);
      if (options.provider === 'gemini') {
        console.log(`Model:        ${options.model}`);
      }
      console.log(`Namespace:    ${options.namespace}`);
      console.log(`Scenario:     ${scenarioKey}`);
      console.log(`Tool Budget:  ${options.maxTools}`);
      console.log(`------------------------------------------------------\n`);

      const registry = new ToolRegistry();
      const backend = new MockDiagnosticBackend(scenarioKey);
      const tools = createStandardTools(backend);
      for (const t of tools) {
        registry.register(t);
      }

      const policy = new ToolPolicy(registry);

      let provider: AIProvider;
      if (options.provider === 'gemini') {
        try {
          provider = new GeminiProvider({ model: options.model });
        } catch (err: any) {
          console.error(`Configuration Error: ${err.message}`);
          process.exit(1);
        }
      } else {
        provider = new MockAIProvider({ scenarioId: scenarioKey });
      }

      const engine = new InvestigationEngine({ provider, registry, policy });

      console.log(`[1/3] Initializing diagnostic tools & policy guards...`);
      console.log(`[2/3] Agent actively investigating...`);

      const run = await engine.investigate(prompt, {
        allowedNamespaces: [options.namespace, 'staging', 'production'],
        maxToolCalls: parseInt(options.maxTools, 10),
      });

      console.log(`\n[3/3] Investigation finished. Status: ${run.status}`);

      // Print audit events
      console.log(`\n--- Tool Execution Audit Log ---`);
      for (const audit of run.auditLog) {
        if (audit.type === 'TOOL_REQUEST') {
          console.log(`  -> REQUEST: ${audit.details['name']}(${JSON.stringify(audit.details['arguments'])})`);
        } else if (audit.type === 'TOOL_RESULT') {
          console.log(`  <- RESULT:  ${audit.details['name']} (success: ${audit.details['success']})`);
        } else if (audit.type === 'POLICY_DENIAL') {
          console.log(`  !! DENIED:  ${audit.details['name']} - ${audit.details['message']}`);
        }
      }

      // Print final report
      if (run.report) {
        console.log(`\n======================================================`);
        console.log(`  INCIDENT REPORT`);
        console.log(`======================================================`);
        console.log(`\nSUMMARY:`);
        console.log(`  ${run.report.summary}\n`);

        console.log(`OBSERVED FACTS:`);
        for (const fact of run.report.observedFacts) {
          console.log(`  • ${fact.statement}`);
          console.log(`    [Evidence: ${fact.evidenceRef.join(', ')}]`);
        }

        console.log(`\nHYPOTHESES:`);
        for (const hypo of run.report.hypotheses) {
          console.log(`  • [${hypo.likelihood.toUpperCase()}] ${hypo.statement}`);
          console.log(`    Reasoning: ${hypo.reasoning}`);
        }

        console.log(`\nRECOMMENDED ACTIONS:`);
        run.report.recommendations.forEach((rec, idx) => {
          console.log(`  ${idx + 1}. ${rec}`);
        });

        console.log(`\nCONFIDENCE: ${run.report.confidence.toUpperCase()}`);
        console.log(`======================================================\n`);
      } else {
        console.log(`\nNo incident report produced. Termination reason: ${run.terminationReason}\n`);
      }
    });
}
