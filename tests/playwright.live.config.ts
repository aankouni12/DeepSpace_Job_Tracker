import { defineConfig } from '@playwright/test'
import { chromiumLaunchOptions } from 'deepspace/testing'

/**
 * Post-deploy checks against the live app. No local server: these test the
 * production bundle that `deepspace deploy` uploaded.
 *
 *   npx playwright test --config tests/playwright.live.config.ts
 *
 * Files are *.live.ts so the normal suite (*.spec.ts) never picks them up.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.live.ts',
  timeout: 60_000,
  retries: 0,
  outputDir: '../.deepspace/test-results-live',
  use: {
    baseURL: 'https://applytrack.app.space',
    headless: true,
    launchOptions: chromiumLaunchOptions(),
  },
})
