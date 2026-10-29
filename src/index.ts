#!/usr/bin/env node
try {
  process.loadEnvFile?.();
} catch {}

if (typeof (process.versions as any).bun !== 'undefined') {
  console.warn(
    '\x1b[33m[OpsPilot Notice]\x1b[0m You are running with the Bun runtime.\n' +
    'Local Kubernetes clusters (Kind/Minikube) require mTLS client certificate support.\n' +
    'Run with Node.js via tsx: \x1b[36mnpx tsx src/index.ts\x1b[0m or \x1b[36mbun start\x1b[0m\n'
  );
}

import { Command } from 'commander';
import { registerInvestigateCommand } from './cli/investigate.js';
import { registerInteractiveCommand, runInteractiveSession } from './cli/interactive.js';

const program = new Command();

program
  .name('opspilot')
  .description('Local-first AI DevOps incident investigation CLI')
  .version('0.1.0');

registerInvestigateCommand(program);
registerInteractiveCommand(program);

// If no subcommands or arguments provided, launch interactive REPL mode by default
if (process.argv.length <= 2) {
  runInteractiveSession().catch((err) => {
    console.error('Fatal interactive session error:', err);
    process.exit(1);
  });
} else {
  program.parse(process.argv);
}

