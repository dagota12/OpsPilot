import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Command } from 'commander';
import { KubeConfig } from '@kubernetes/client-node';
import { InvestigationEngine } from '../core/engine/investigation-engine.js';
import { ToolRegistry } from '../core/tools/registry.js';
import { ToolPolicy } from '../core/policy/policy.js';
import { MockAIProvider } from '../core/providers/mock.js';
import { GeminiProvider } from '../providers/gemini.js';
import {
  MockDiagnosticBackend,
  MOCK_SCENARIOS,
  type ScenarioId,
} from '../diagnostics/mock.js';
import { K8sDiagnosticBackend } from '../diagnostics/k8s.js';
import { createStandardTools } from '../diagnostics/tools.js';
import type { AIProvider } from '../core/providers/interface.js';
import type { DiagnosticBackend } from '../diagnostics/interface.js';
import type { IncidentReport } from '../core/models/report.js';
import type { InvestigationRun } from '../core/models/investigation.js';

interface SessionState {
  backendType: 'k8s' | 'mock';
  context?: string;
  namespace: string;
  scenario?: ScenarioId;
  providerType: 'gemini' | 'mock';
  model: string;
  toolBudget: number;
}

export function registerInteractiveCommand(program: Command): void {
  program
    .command('interactive')
    .alias('i')
    .description('Start interactive AI DevOps incident investigation REPL session')
    .option('-b, --backend <type>', 'Backend type (k8s or mock)')
    .option('-n, --namespace <ns>', 'Kubernetes namespace')
    .option('-c, --context <context>', 'Kubernetes context')
    .option('-p, --provider <provider>', 'AI Provider (gemini or mock)')
    .option('-m, --model <model>', 'Model name')
    .action(async (options) => {
      await runInteractiveSession(options);
    });
}

export async function runInteractiveSession(initialOptions: {
  backend?: string;
  namespace?: string;
  context?: string;
  provider?: string;
  model?: string;
} = {}): Promise<void> {
  console.clear();
  p.intro(pc.bgCyan(pc.black(' OpsPilot · Interactive DevOps Incident Investigator ')));

  // 1. Detect / Setup Backend
  let backendType: 'k8s' | 'mock' =
    initialOptions.backend === 'k8s' || initialOptions.backend === 'mock'
      ? (initialOptions.backend as 'k8s' | 'mock')
      : 'k8s';

  let availableContexts: string[] = [];
  let defaultContext: string | undefined;

  try {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    availableContexts = kc.getContexts().map((c) => c.name);
    defaultContext = kc.getCurrentContext() || undefined;
  } catch {
    // Kubeconfig unavailable
  }

  if (!initialOptions.backend) {
    const backendChoice = await p.select({
      message: 'Select diagnostic backend:',
      options: [
        {
          value: 'k8s',
          label: 'Live Kubernetes Cluster',
          hint: defaultContext ? `Current context: ${defaultContext}` : 'Uses local ~/.kube/config',
        },
        {
          value: 'mock',
          label: 'Mock Diagnostic Scenarios',
          hint: 'Offline deterministic crashloop/OOM scenarios',
        },
      ],
      initialValue: defaultContext ? 'k8s' : 'mock',
    });

    if (p.isCancel(backendChoice)) {
      p.cancel('Session cancelled.');
      process.exit(0);
    }
    backendType = backendChoice as 'k8s' | 'mock';
  }

  let selectedContext: string | undefined = initialOptions.context || defaultContext;
  let selectedScenario: ScenarioId | undefined;
  let selectedNamespace: string = initialOptions.namespace || 'default';

  if (backendType === 'k8s') {
    if (!initialOptions.context && availableContexts.length > 1) {
      const contextChoice = await p.select({
        message: 'Select Kubernetes Context:',
        options: availableContexts.map((ctx) => ({
          value: ctx,
          label: ctx,
          hint: ctx === defaultContext ? 'active' : undefined,
        })),
        initialValue: defaultContext,
      });

      if (p.isCancel(contextChoice)) {
        p.cancel('Session cancelled.');
        process.exit(0);
      }
      selectedContext = contextChoice as string;
    }

    if (!initialOptions.namespace) {
      const nsChoice = await p.select({
        message: 'Select target namespace:',
        options: [
          { value: 'zcinema', label: 'zcinema', hint: 'Application workload namespace' },
          { value: 'default', label: 'default', hint: 'Default cluster namespace' },
          { value: 'custom', label: 'Enter custom namespace...', hint: 'Specify manually' },
        ],
        initialValue: 'zcinema',
      });

      if (p.isCancel(nsChoice)) {
        p.cancel('Session cancelled.');
        process.exit(0);
      }

      if (nsChoice === 'custom') {
        const customNs = await p.text({
          message: 'Enter namespace name:',
          placeholder: 'my-app',
          validate: (value) => (!value ? 'Namespace is required' : undefined),
        });
        if (p.isCancel(customNs)) {
          p.cancel('Session cancelled.');
          process.exit(0);
        }
        selectedNamespace = customNs as string;
      } else {
        selectedNamespace = nsChoice as string;
      }
    }
  } else {
    // Mock backend
    if (!initialOptions.namespace) {
      const scenarioChoice = await p.select({
        message: 'Select mock scenario to investigate:',
        options: [
          {
            value: 'crashloop-missing-env',
            label: 'CrashLoopBackOff (Missing Env)',
            hint: 'auth-service restarts due to missing JWT_SECRET_KEY',
          },
          {
            value: 'oom-killed',
            label: 'OOMKilled Container',
            hint: 'image-processor exceeds 512Mi memory limit (Exit 137)',
          },
          {
            value: 'failed-readiness-probe',
            label: 'Failed Readiness Probe',
            hint: 'payment-gateway readiness HTTP 500 failure',
          },
        ],
        initialValue: 'crashloop-missing-env',
      });

      if (p.isCancel(scenarioChoice)) {
        p.cancel('Session cancelled.');
        process.exit(0);
      }
      selectedScenario = scenarioChoice as ScenarioId;
    }
  }

  // 2. Select AI Provider
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
  let providerType: 'gemini' | 'mock' =
    initialOptions.provider === 'mock' || !hasGeminiKey ? 'mock' : 'gemini';

  if (!initialOptions.provider) {
    const providerChoice = await p.select({
      message: 'Select AI Provider:',
      options: [
        {
          value: 'gemini',
          label: 'Google Gemini',
          hint: hasGeminiKey ? 'API key detected' : 'Requires GEMINI_API_KEY',
        },
        {
          value: 'mock',
          label: 'Deterministic Mock Provider',
          hint: 'No API key needed, offline rules',
        },
      ],
      initialValue: hasGeminiKey ? 'gemini' : 'mock',
    });

    if (p.isCancel(providerChoice)) {
      p.cancel('Session cancelled.');
      process.exit(0);
    }
    providerType = providerChoice as 'gemini' | 'mock';
  }

  if (providerType === 'gemini' && !process.env.GEMINI_API_KEY) {
    const apiKeyInput = await p.text({
      message: 'Enter your GEMINI_API_KEY (from Google AI Studio):',
      validate: (v) => (!v ? 'API key cannot be empty' : undefined),
    });
    if (p.isCancel(apiKeyInput)) {
      p.cancel('Session cancelled.');
      process.exit(0);
    }
    process.env.GEMINI_API_KEY = apiKeyInput as string;
  }

  let selectedModel = initialOptions.model || 'gemini-3.5-flash-lite';
  if (providerType === 'gemini' && !initialOptions.model) {
    const modelChoice = await p.select({
      message: 'Select Gemini model:',
      options: [
        {
          value: 'gemini-3.5-flash-lite',
          label: 'gemini-3.5-flash-lite (Recommended)',
          hint: 'Fastest (~900ms), light quota usage',
        },
        {
          value: 'gemini-3.5-flash',
          label: 'gemini-3.5-flash',
          hint: 'Balanced intelligence and speed',
        },
        {
          value: 'gemini-3.8-flash',
          label: 'gemini-3.8-flash',
          hint: 'Deep thinking model (slower)',
        },
      ],
      initialValue: 'gemini-3.5-flash-lite',
    });

    if (p.isCancel(modelChoice)) {
      p.cancel('Session cancelled.');
      process.exit(0);
    }
    selectedModel = modelChoice as string;
  }

  const session: SessionState = {
    backendType,
    context: selectedContext,
    namespace: selectedNamespace,
    scenario: selectedScenario,
    providerType,
    model: selectedModel,
    toolBudget: 10,
  };

  printSessionHeader(session);

  // 3. REPL Prompt Loop
  while (true) {
    const userInput = await p.text({
      message: pc.cyan('What would you like to investigate?'),
      placeholder: 'e.g. Check pod health, why is zcinema-db restarting? (or /help, exit)',
      validate: (val) => (!val?.trim() ? 'Please enter a question or command' : undefined),
    });

    if (p.isCancel(userInput) || userInput.trim() === 'exit' || userInput.trim() === 'quit') {
      p.outro(pc.green('OpsPilot session concluded. Cluster systems monitored! 🚀'));
      break;
    }

    const trimmed = userInput.trim();

    // Check slash commands
    if (trimmed.startsWith('/')) {
      const handled = handleSlashCommand(trimmed, session);
      if (handled === 'exit') {
        p.outro(pc.green('OpsPilot session concluded. Cluster systems monitored! 🚀'));
        break;
      }
      continue;
    }

    // Execute investigation
    await executeInteractiveInvestigation(trimmed, session);
  }
}

function handleSlashCommand(commandStr: string, session: SessionState): 'handled' | 'exit' {
  const [cmd, ...args] = commandStr.split(' ');
  if (!cmd) return 'handled';

  switch (cmd.toLowerCase()) {
    case '/exit':
    case '/quit':
      return 'exit';

    case '/help':
      p.note(
        `Available Commands:
  ${pc.bold('/ns <name>')}       Change active target namespace (e.g. /ns zcinema)
  ${pc.bold('/model <name>')}    Switch Gemini model (e.g. /model gemini-3.5-flash-lite)
  ${pc.bold('/context <name>')}  Switch Kubernetes cluster context
  ${pc.bold('/status')}          Display current active session settings
  ${pc.bold('/clear')}           Clear the terminal screen
  ${pc.bold('/exit')}            Exit the interactive session`,
        'Interactive REPL Commands'
      );
      return 'handled';

    case '/ns':
      if (args[0]) {
        session.namespace = args[0];
        p.log.success(pc.green(`Target namespace switched to: ${pc.bold(session.namespace)}`));
      } else {
        p.log.warn('Usage: /ns <namespace_name>');
      }
      return 'handled';

    case '/model':
      if (args[0]) {
        session.model = args[0];
        p.log.success(pc.green(`Model switched to: ${pc.bold(session.model)}`));
      } else {
        p.log.warn('Usage: /model <model_name>');
      }
      return 'handled';

    case '/context':
      if (args[0]) {
        session.context = args[0];
        p.log.success(pc.green(`Kubernetes context switched to: ${pc.bold(session.context)}`));
      } else {
        p.log.warn('Usage: /context <context_name>');
      }
      return 'handled';

    case '/status':
      printSessionHeader(session);
      return 'handled';

    case '/clear':
      console.clear();
      printSessionHeader(session);
      return 'handled';

    default:
      p.log.error(`Unknown command: ${cmd}. Type ${pc.bold('/help')} for available commands.`);
      return 'handled';
  }
}

function printSessionHeader(session: SessionState): void {
  const backendDesc =
    session.backendType === 'k8s'
      ? `Live K8s (${session.context || 'default context'}) · Namespace: ${pc.cyan(session.namespace)}`
      : `Mock Scenario (${session.scenario})`;

  const providerDesc =
    session.providerType === 'gemini'
      ? `Gemini (${pc.yellow(session.model)})`
      : 'Mock Provider';

  p.note(
    `Backend:  ${backendDesc}\nProvider: ${providerDesc}\nBudget:   ${session.toolBudget} diagnostic tool calls\nCommands: Type ${pc.bold('/help')} for options, ${pc.bold('exit')} to quit`,
    'Active Session Environment'
  );
}

async function executeInteractiveInvestigation(
  prompt: string,
  session: SessionState
): Promise<void> {
  const s = p.spinner();
  s.start(pc.dim('Initializing diagnostic tools & policy guards...'));

  try {
    // 1. Build Backend
    let backend: DiagnosticBackend;
    if (session.backendType === 'k8s') {
      backend = new K8sDiagnosticBackend({
        context: session.context,
      });
    } else {
      backend = new MockDiagnosticBackend(session.scenario || 'crashloop-missing-env');
    }

    // 2. Build Tools & Registry
    const tools = createStandardTools(backend);
    const registry = new ToolRegistry();
    tools.forEach((t) => registry.register(t));

    // 3. Build Provider
    let provider: AIProvider;
    if (session.providerType === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        s.stop(pc.red('Missing GEMINI_API_KEY'));
        return;
      }
      provider = new GeminiProvider({
        apiKey,
        model: session.model,
      });
    } else {
      provider = new MockAIProvider({ scenarioId: session.scenario || 'crashloop-missing-env' });
    }

    // 4. Policy & Engine
    const policy = new ToolPolicy(registry);
    const engine = new InvestigationEngine({ provider, registry, policy });

    // Track tool actions for live feedback
    const toolExecutions: Array<{ name: string; args: any; success?: boolean }> = [];

    const run: InvestigationRun = await engine.investigate(prompt, {
      maxToolCalls: session.toolBudget,
      targetNamespace: session.namespace,
      allowedNamespaces: session.backendType === 'k8s' ? undefined : ['default'],
      onProgress: (entry) => {
        if (entry.type === 'TOOL_REQUEST') {
          const name = String(entry.details['name'] || 'tool');
          const args = entry.details['arguments'] || {};
          toolExecutions.push({ name, args });
          const argSummary = Object.keys(args).length > 0 ? JSON.stringify(args) : '';
          s.message(
            pc.cyan(`Agent executing: ${pc.bold(name)} ${pc.dim(argSummary.substring(0, 50))}`)
          );
        } else if (entry.type === 'TOOL_RESULT') {
          const name = String(entry.details['name'] || 'tool');
          const success = Boolean(entry.details['success']);
          s.message(
            success
              ? pc.green(`✓ Tool completed: ${name}`)
              : pc.yellow(`! Tool returned error: ${name}`)
          );
        } else if (entry.type === 'POLICY_DENIAL') {
          s.message(pc.red(`✗ Policy denial: ${entry.details['message']}`));
        }
      },
    });

    s.stop(
      run.status === 'COMPLETED'
        ? pc.green(`Investigation concluded (${run.toolCallCount} tool calls executed)`)
        : pc.yellow(`Investigation finished with status: ${run.status}`)
    );

    // 5. Render Structured Report
    if (run.report) {
      renderIncidentReport(run.report, toolExecutions);
    } else {
      p.log.warn(
        pc.yellow(`No incident report generated. Reason: ${run.terminationReason || 'Unknown'}`)
      );
    }
  } catch (err: any) {
    s.stop(pc.red(`Investigation failed: ${err.message || String(err)}`));
  }
}

function renderIncidentReport(
  report: IncidentReport,
  tools: Array<{ name: string; args: any; success?: boolean }>
): void {
  console.log('\n' + pc.bold(pc.cyan('─'.repeat(60))));
  console.log(pc.bold(pc.bgBlue(pc.white(' INCIDENT REPORT '))));
  console.log(pc.bold(pc.cyan('─'.repeat(60))));

  // Summary
  console.log(`\n${pc.bold('SUMMARY:')}`);
  console.log(`  ${report.summary}\n`);

  // Observed Facts
  if (report.observedFacts.length > 0) {
    console.log(pc.bold('OBSERVED FACTS:'));
    for (const fact of report.observedFacts) {
      console.log(`  ${pc.green('•')} ${fact.statement}`);
      if (fact.evidenceRef.length > 0) {
        console.log(`    ${pc.dim(`[Evidence: ${fact.evidenceRef.join(', ')}]`)}`);
      }
    }
    console.log();
  }

  // Hypotheses
  if (report.hypotheses.length > 0) {
    console.log(pc.bold('HYPOTHESES:'));
    for (const hypo of report.hypotheses) {
      const color =
        hypo.likelihood === 'high' ? pc.red : hypo.likelihood === 'medium' ? pc.yellow : pc.blue;
      console.log(`  ${color(`[${hypo.likelihood.toUpperCase()}]`)} ${hypo.statement}`);
      console.log(`    ${pc.dim('Reasoning:')} ${hypo.reasoning}`);
    }
    console.log();
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    console.log(pc.bold('RECOMMENDED ACTIONS:'));
    report.recommendations.forEach((rec: string, idx: number) => {
      const recText = typeof rec === 'object' ? JSON.stringify(rec) : rec;
      console.log(`  ${pc.cyan(`${idx + 1}.`)} ${recText}`);
    });
    console.log();
  }

  // Confidence
  const confColor =
    report.confidence === 'high' ? pc.green : report.confidence === 'medium' ? pc.yellow : pc.red;
  console.log(`${pc.bold('CONFIDENCE:')} ${confColor(report.confidence.toUpperCase())}`);

  if (report.uncertaintyNotes) {
    console.log(`${pc.bold('NOTES:')} ${pc.dim(report.uncertaintyNotes)}`);
  }

  console.log(pc.bold(pc.cyan('─'.repeat(60))) + '\n');
}
