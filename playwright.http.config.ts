import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// This origin must also be the configured application origin for CSRF checks.
// Chromium resolves `app` to loopback in the spec while retaining a real
// insecure browser context; the readiness probe uses loopback directly.
const baseURL = "http://app:3000";
const webServer = base.webServer;
if (!webServer || Array.isArray(webServer)) throw new Error("http_test_web_server_missing");

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "**/http.spec.ts",
  use: { ...base.use, baseURL },
  webServer: {
    ...webServer,
    command: "node --import tsx scripts/stateful-test-target.ts && npm run db:generate && npx prisma migrate reset --force --skip-generate --skip-seed && npx prisma db seed && node scripts/runtime-launcher.cjs tests/e2e/support/http-server.cjs",
    env: {
      ...webServer.env,
      AIQSA_APP_BASE_URL: baseURL,
      AIQSA_BIND_ADDRESS: "0.0.0.0",
      NODE_ENV: "development"
    },
    url: "http://127.0.0.1:3000/login"
  }
});
