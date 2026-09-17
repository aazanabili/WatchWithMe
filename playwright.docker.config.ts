import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  preserveOutput: 'always',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/docker', open: 'never' }]],
  use: {
    baseURL: process.env.WWM_BASE_URL || 'http://localhost:3000',
    trace: 'off',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium-docker', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--allow-file-access-from-files'] } } }],
});
