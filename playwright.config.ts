import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.CHRONICLE_E2E_PORT || 4179);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `CHRONICLE_E2E_PORT=${port} node tests/e2e/static-server.mjs`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
  projects: [
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
      },
    },
  ],
});
