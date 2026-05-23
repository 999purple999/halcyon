// HALCYON - Playwright e2e config.
// Requires HTTPS self-signed (i due server gia' generano cert.pem condiviso).
// I server devono essere LIVE prima di lanciare i test: usiamo webServer NO
// (i server vivono in background nostri); ignoreHTTPSErrors=true per il cert
// self-signed; permissions audio + microfono per la pipeline WebRTC.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // i test toccano la stessa stanza P2P -> seriali
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'tests/_artifacts/report', open: 'never' }]],
  outputDir: 'tests/_artifacts/output',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'https://localhost:8443',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Audio fake routing per i peer (no microfono fisico richiesto)
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    contextOptions: {
      permissions: ['microphone'],
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
