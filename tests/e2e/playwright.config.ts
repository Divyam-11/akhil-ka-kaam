import '../fixtures/env.js';
import { defineConfig, devices } from '@playwright/test';

const API_PORT = Number(process.env.API_PORT ?? 3001);

// The stack under test: API, email worker (BullMQ), outbox dispatcher and the Vite dashboard.
// Infrastructure (PostgreSQL, Redis, Elasticsearch) must already be running: `pnpm infra:up`.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]],
  outputDir: '../../test-results',
  use: {
    baseURL: 'http://localhost:5173',
    // Optional: point at a locally installed Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE) when the
    // bundled browser for this Playwright version is not installed.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // API, email worker and outbox dispatcher. Readiness is the API health endpoint.
      command: 'node tests/e2e/run-stack.mjs',
      cwd: '../..',
      url: `http://localhost:${API_PORT}/health/live`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: { API_PORT: String(API_PORT) },
    },
    {
      command: 'pnpm --filter @reachinbox/web dev --port 5173 --strictPort',
      cwd: '../..',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
