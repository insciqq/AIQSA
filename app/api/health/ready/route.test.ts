// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkS3Readiness: vi.fn(),
  queryRaw: vi.fn()
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw
  }
}));

vi.mock("@/lib/server/health/readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/health/readiness")>();

  return {
    ...actual,
    checkS3Readiness: mocks.checkS3Readiness
  };
});

import { GET } from "./route";

const ENCRYPTION_KEY = Buffer.alloc(32, 0x2a).toString("base64");
const INVALID_KEY_CANARY = "invalid-encryption-key-canary!";

function stubProductionEnvironment(encryptionKey: string): void {
  const values = {
    AIQSA_APP_BASE_URL: "https://aiqsa.example.com",
    AIQSA_AUTH_SESSION_SECRET: "an-installation-session-secret",
    AIQSA_BIND_ADDRESS: "127.0.0.1",
    AIQSA_BOOTSTRAP_LOGIN_ENABLED: "",
    AIQSA_COOKIE_SECURE: "1",
    AIQSA_ENCRYPTION_KEY: encryptionKey,
    AIQSA_TEST_MODE: "",
    AIQSA_TRUSTED_PROXY_COUNT: "1",
    AIQSA_TRUST_PROXY_HEADERS: "1",
    DATABASE_URL: "postgresql://user:password@postgres:5432/aiqsa",
    PLAYWRIGHT_TEST_AUTH: "",
    S3_ACCESS_KEY_ID: "access-key",
    S3_BUCKET: "private-uploads",
    S3_ENDPOINT: "http://minio:9000",
    S3_REGION: "us-east-1",
    S3_SECRET_ACCESS_KEY: "secret-key"
  };

  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
}

beforeEach(() => {
  mocks.checkS3Readiness.mockResolvedValue(undefined);
  mocks.queryRaw.mockResolvedValue([{ result: 1 }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("/api/health/ready", () => {
  it("returns not-ready without dependency I/O for an invalid encryption key", async () => {
    stubProductionEnvironment(INVALID_KEY_CANARY);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({ status: "not_ready" });
    expect(JSON.stringify(body)).not.toContain(INVALID_KEY_CANARY);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.checkS3Readiness).not.toHaveBeenCalled();
  });

  it("checks dependencies and returns ready for a valid production configuration", async () => {
    stubProductionEnvironment(ENCRYPTION_KEY);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.checkS3Readiness).toHaveBeenCalledOnce();
  });
});
