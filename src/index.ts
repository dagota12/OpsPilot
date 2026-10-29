#!/usr/bin/env node
try {
  process.loadEnvFile?.();
} catch {}

import { Command } from 'commander';
import { registerInvestigateCommand } from './cli/investigate.js';

const program = new Command();

program
  .name('opspilot')
  .description('Local-first AI DevOps incident investigation CLI')
  .version('0.1.0');

registerInvestigateCommand(program);

program.parse(process.argv);
