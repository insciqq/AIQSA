import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3000";
const fakeProviderTokenDelayMs = process.env.AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS?.trim() || "150";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results/playwright",
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  workers: 1,
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  webServer: {
    command:
      "npm run db:generate && npx prisma migrate reset --force --skip-generate --skip-seed && npx prisma db seed && npm run dev",
    env: {
      AIQSA_APP_BASE_URL: baseURL,
      AIQSA_AUTH_SESSION_SECRET: "aiqsa-playwright-session-secret-00000000000000000000000000000000",
      AIQSA_BOOTSTRAP_AUTH_TOKEN: "",
      AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256: "",
      AIQSA_BOOTSTRAP_LOGIN_ENABLED: "",
      AIQSA_BOOTSTRAP_USER_ID: "00000000-0000-4000-8000-000000000001",
      AIQSA_COOKIE_SECURE: "0",
      AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS: fakeProviderTokenDelayMs,
      AIQSA_TEST_MODE: "1",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENROUTER_API_KEY: "",
      OPENROUTER_BASE_URL: "",
      PLAYWRIGHT_TEST_AUTH: "1",
      S3_ENDPOINT: "http://minio:9000"
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: {
          width: 1440,
          height: 900
        }
      }
    }
  ]
});
