import { defineConfig } from '@playwright/test';

const baseURL = process.env.UI_TEST_BASE_URL ?? 'http://127.0.0.1:6006';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.pw.ts', fullyParallel: true, workers: 2,
  timeout: 45000, expect: { timeout: 15000 },
  use: { baseURL, channel: 'chrome', headless: true, locale: 'pt-BR', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list'], ['json', { outputFile: '../../output/design-system/playwright-results.json' }]],
  webServer: { command: 'bun run storybook --ci', url: baseURL, reuseExistingServer: true, timeout: 120000 },
});
