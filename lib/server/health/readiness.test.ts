import { describe, expect, it } from "vitest";
import { runtimeConfigurationIssues } from "./readiness";

const ENCRYPTION_KEY = Buffer.alloc(32, 0x2a).toString("base64");

function productionEnv(): Record<string, string> {
  return {
    AIQSA_APP_BASE_URL: "https://aiqsa.example.com",
    AIQSA_BIND_ADDRESS: "127.0.0.1",
    AIQSA_COOKIE_SECURE: "1",
    AIQSA_AUTH_SESSION_SECRET: "an-installation-session-secret",
    AIQSA_ENCRYPTION_KEY: ENCRYPTION_KEY,
    AIQSA_TRUST_PROXY_HEADERS: "1",
    AIQSA_TRUSTED_PROXY_COUNT: "1",
    DATABASE_URL: "postgresql://user:password@postgres:5432/aiqsa",
    S3_ACCESS_KEY_ID: "access-key",
    S3_BUCKET: "private-uploads",
    S3_ENDPOINT: "http://minio:9000",
    S3_REGION: "us-east-1",
    S3_SECRET_ACCESS_KEY: "secret-key"
  };
}

describe("runtimeConfigurationIssues", () => {
  it("accepts the secure database and private storage runtime contract", () => {
    expect(runtimeConfigurationIssues(productionEnv())).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["malformed", "not-base64!"],
    ["non-canonical", `${ENCRYPTION_KEY.slice(0, -2)}r=`],
    ["wrong length", Buffer.alloc(31, 0x2a).toString("base64")]
  ])("reports one value-free encryption issue for a %s key", (_label, encryptionKey) => {
    const issues = runtimeConfigurationIssues({
      ...productionEnv(),
      AIQSA_ENCRYPTION_KEY: encryptionKey
    });

    expect(issues).toEqual(["encryption_key"]);
    if (encryptionKey?.trim()) {
      expect(JSON.stringify(issues)).not.toContain(encryptionKey.trim());
    }
  });

  it("rejects insecure, test, recovery, database, and storage configuration", () => {
    expect(
      runtimeConfigurationIssues({
        ...productionEnv(),
        AIQSA_APP_BASE_URL: "ftp://aiqsa.example.com",
        AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
        AIQSA_COOKIE_SECURE: "0",
        AIQSA_TEST_MODE: "1",
        AIQSA_TRUST_PROXY_HEADERS: "",
        AIQSA_TRUSTED_PROXY_COUNT: "",
        AIQSA_AUTH_SESSION_SECRET: "",
        DATABASE_URL: "",
        S3_BUCKET: ""
      })
    ).toEqual([
      "session_secret",
      "database_url",
      "app_base_url",
      "trusted_proxy",
      "bootstrap_login",
      "test_runtime",
      "s3_bucket"
    ]);
  });

  it("accepts a compiled runtime on loopback HTTP without a domain", () => {
    expect(
      runtimeConfigurationIssues({
        ...productionEnv(),
        AIQSA_APP_BASE_URL: "http://localhost:3000",
        AIQSA_COOKIE_SECURE: "",
        AIQSA_TRUST_PROXY_HEADERS: "",
        AIQSA_TRUSTED_PROXY_COUNT: "",
        NODE_ENV: "production"
      })
    ).toEqual([]);
  });

  it("rejects a cookie mode inconsistent with the public URL", () => {
    expect(runtimeConfigurationIssues({ ...productionEnv(), AIQSA_COOKIE_SECURE: "0" })).toContain(
      "secure_cookie"
    );
  });

  it("rejects a public origin without an exact trusted-proxy configuration", () => {
    expect(
      runtimeConfigurationIssues({
        ...productionEnv(),
        AIQSA_TRUST_PROXY_HEADERS: "",
        AIQSA_TRUSTED_PROXY_COUNT: ""
      })
    ).toContain("trusted_proxy");
    expect(
      runtimeConfigurationIssues({
        ...productionEnv(),
        AIQSA_TRUSTED_PROXY_COUNT: "99"
      })
    ).toContain("trusted_proxy");
    expect(
      runtimeConfigurationIssues({
        ...productionEnv(),
        AIQSA_BIND_ADDRESS: "0.0.0.0"
      })
    ).toContain("trusted_proxy");
  });
});
