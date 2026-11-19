import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

function resolveChromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const knownCandidates = [
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
  ];
  for (const candidate of knownCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const resolvedExecutable = resolveChromiumExecutable();

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.pw\.ts/,
  outputDir: './test-results/playwright-artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: './test-results/playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(resolvedExecutable ? { executablePath: resolvedExecutable } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: 'DISABLE_HMR=true PORT=3000 npm run dev',
    url: 'http://127.0.0.1:3000/api/v1/asr-core/health',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

export const PLAYWRIGHT_SETUP_HINT =
  'If Chromium is missing on this host, run: npx playwright install chromium';
export const PLAYWRIGHT_ISOLATED_OUTPUT_DIR = path.resolve(process.cwd(), 'test-results');
