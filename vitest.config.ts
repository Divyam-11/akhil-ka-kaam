import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/fixtures/env.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['tests/fixtures/env.ts'],
          globalSetup: ['tests/fixtures/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          environment: 'node',
        },
      },
    ],
  },
});
