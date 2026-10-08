import { defineConfig, devices } from "@playwright/test";

// App-free artifact runtime checks: the real renderer output in a viewer-like
// sandboxed frame, across all three engines. The specs start their own servers.
const outputDir = process.env.AIQSA_PLAYWRIGHT_OUTPUT_DIR?.trim() ||
  "test-results/artifact-runtime";

export default defineConfig({
  forbidOnly: true,
  testDir: "./tests/artifact-runtime",
  outputDir,
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  workers: 1,
  reporter: "list",
  use: {
    trace: "retain-on-failure"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } }
  ]
});
