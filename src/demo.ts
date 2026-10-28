import { spawnSync } from 'node:child_process';

console.log('--- Running OpsPilot Demo: Scenario 1 (CrashLoopBackOff) ---');
spawnSync('npx', ['tsx', 'src/index.ts', 'investigate', 'Why is auth-service restarting in default?', '--scenario', 'crashloop-missing-env'], {
  stdio: 'inherit',
});
