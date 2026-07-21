import { describe, expect, it } from "vitest";
import { productionRuntimeIssues } from "./readiness";

function productionEnv(): Record<string, string> {
  return {
    AIQSA_APP_BASE_URL: "https://aiqsa.example.com",
    AIQSA_COOKIE_SECURE: "1",
    APP_ENV: "production",
    AUTH_SESSION_SECRET: "a-production-session-secret",
    DATABASE_URL: "postgresql://user:password@postgres:5432/aiqsa",
    S3_ACCESS_KEY_ID: "access-key",
    S3_BUCKET: "private-uploads",
    S3_ENDPOINT: "http://minio:9000",
    S3_REGION: "us-east-1",
    S3_SECRET_ACCESS_KEY: "secret-key"
  };
}

describe("productionRuntimeIssues", () => {
  it("accepts the secure database and private storage runtime contract", () => {
    expect(productionRuntimeIssues(productionEnv())).toEqual([]);
  });

  it("rejects insecure, test, recovery, database, and storage configuration", () => {
    expect(
      productionRuntimeIssues({
        ...productionEnv(),
        AIQSA_APP_BASE_URL: "http://aiqsa.example.com",
        AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
        AIQSA_COOKIE_SECURE: "0",
        AIQSA_FAKE_PROVIDER: "1",
        AUTH_SESSION_SECRET: "",
        DATABASE_URL: "",
        S3_BUCKET: ""
      })
    ).toEqual([
      "session_secret",
      "database_url",
      "app_base_url",
      "secure_cookie",
      "bootstrap_login",
      "test_runtime",
      "s3_bucket"
    ]);
  });

  it("keeps local readiness limited to session and database configuration", () => {
    expect(
      productionRuntimeIssues({
        APP_ENV: "local",
        AUTH_SESSION_SECRET: "local-secret",
        DATABASE_URL: "postgresql://local"
      })
    ).toEqual([]);
  });

  it("fails closed when a production Node runtime has a missing or mistyped app environment", () => {
    expect(
      productionRuntimeIssues({
        ...productionEnv(),
        APP_ENV: "stagin",
        NODE_ENV: "production"
      })
    ).toContain("app_env");
  });
});
