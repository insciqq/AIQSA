import { describe, expect, it } from "vitest";
import { assertDisposableStatefulTestTarget } from "./stateful-test-target";

const disposableEnvironment = {
  AIQSA_STATEFUL_TEST_TARGET: "DISPOSABLE",
  AIQSA_TEST_MODE: "1",
  DATABASE_URL:
    "postgresql://aiqsa:aiqsa-dev-password@postgres:5432/aiqsa?schema=public",
  NODE_ENV: "development"
} as const;

describe("stateful test target guard", () => {
  it("accepts only the acknowledged disposable development database", () => {
    expect(() =>
      assertDisposableStatefulTestTarget(disposableEnvironment)
    ).not.toThrow();
  });

  it.each([
    [{ ...disposableEnvironment, AIQSA_STATEFUL_TEST_TARGET: undefined }],
    [{ ...disposableEnvironment, AIQSA_TEST_MODE: undefined }],
    [{ ...disposableEnvironment, NODE_ENV: "production" }],
    [{
      ...disposableEnvironment,
      DATABASE_URL: "postgresql://aiqsa:secret@database.example/aiqsa"
    }]
  ])("rejects an unsafe environment %#", (environment) => {
    expect(() => assertDisposableStatefulTestTarget(environment)).toThrow(
      /^stateful_test_/u
    );
  });
});
