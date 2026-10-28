import { spawnSync } from 'node:child_process';

const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const provider = hasGeminiKey ? 'gemini' : 'mock';

console.log(`--- Running OpsPilot Demo: Scenario 1 (Provider: ${provider}) ---`);
if (!hasGeminiKey) {
  console.log(`(Note: GEMINI_API_KEY not detected in environment. Using deterministic mock provider.)\n`);
}

spawnSync(
  'npx',
  [
    'tsx',
    'src/index.ts',
    'investigate',
    'Why is auth-service restarting in default?',
    '--scenario',
    'crashloop-missing-env',
    '--provider',
    provider,
  ],
  {
    stdio: 'inherit',
  }
);
