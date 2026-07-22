import { describe, expect, it } from "vitest";
import { runtimeConfigurationIssues } from "./readiness";

function productionEnv(): Record<string, string> {
  return {
    AIQSA_APP_BASE_URL: "https://aiqsa.example.com",
    AIQSA_COOKIE_SECURE: "1",
    AIQSA_AUTH_SESSION_SECRET: "an-installation-session-secret",
    DATABASE_URL: "postgresql://user:password@postgres:5432/aiqsa",
    OPENAI_API_KEY: "openai-key",
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

  it("rejects insecure, test, recovery, database, and storage configuration", () => {
    expect(
      runtimeConfigurationIssues({
        ...productionEnv(),
        AIQSA_APP_BASE_URL: "ftp://aiqsa.example.com",
        AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
        AIQSA_COOKIE_SECURE: "0",
        AIQSA_TEST_MODE: "1",
        AIQSA_AUTH_SESSION_SECRET: "",
        DATABASE_URL: "",
        OPENAI_API_KEY: "",
        S3_BUCKET: ""
      })
    ).toEqual([
      "session_secret",
      "database_url",
      "provider_api_key",
      "app_base_url",
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
        NODE_ENV: "production"
      })
    ).toEqual([]);
  });

  it("rejects a cookie mode inconsistent with the public URL", () => {
    expect(runtimeConfigurationIssues({ ...productionEnv(), AIQSA_COOKIE_SECURE: "0" })).toContain(
      "secure_cookie"
    );
  });
});
