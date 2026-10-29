#!/usr/bin/env node
try {
  process.loadEnvFile?.();
} catch {}

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

