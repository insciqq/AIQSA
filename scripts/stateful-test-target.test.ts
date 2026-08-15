import { describe, expect, it } from "vitest";
import { assertDisposableStatefulTestTarget } from "./stateful-test-target";

const disposableEnvironment = {
  AIQSA_STATEFUL_TEST_TARGET: "DISPOSABLE",
  AIQSA_TEST_MODE: "1",
  DATABASE_URL:
    "postgresql://aiqsa:aiqsa-dev-password@postgres:5432/aiqsa?schema=public",
  NODE_ENV: "development"
} as const;

const unsafeDatabaseUrls = [
  "postgresql://aiqsa:secret@database.example:5432/aiqsa?schema=public",
  "postgresql://operator:secret@postgres:5432/aiqsa?schema=public",
  "postgresql://aiqsa:secret@postgres:5432/production?schema=public",
  "postgresql://aiqsa:secret@postgres:5432/aiqsa?schema=private",
  "postgresql://aiqsa@postgres:5432/aiqsa?schema=public"
] as const;

describe("stateful test target guard", () => {
  it("accepts only the acknowledged disposable development database", () => {
    expect(() =>
      assertDisposableStatefulTestTarget(disposableEnvironment)
    ).not.toThrow();

    expect(() =>
      assertDisposableStatefulTestTarget({
        ...disposableEnvironment,
        DATABASE_URL:
          "postgresql://aiqsa:rotated-public-dev-password@postgres:5432/aiqsa?schema=public"
      })
    ).not.toThrow();
  });

  it.each([
    [{ ...disposableEnvironment, AIQSA_STATEFUL_TEST_TARGET: undefined }],
    [{ ...disposableEnvironment, AIQSA_TEST_MODE: undefined }],
    [{ ...disposableEnvironment, NODE_ENV: "production" }]
  ])("rejects an unsafe environment %#", (environment) => {
    expect(() => assertDisposableStatefulTestTarget(environment)).toThrow(
      /^stateful_test_.*docker-compose\.dev\.yml/u
    );
  });

  it.each(unsafeDatabaseUrls)("rejects unsafe database URL %s", (DATABASE_URL) => {
    expect(() => assertDisposableStatefulTestTarget({
      ...disposableEnvironment,
      DATABASE_URL
    })).toThrow(/^stateful_test_database_.*docker-compose\.dev\.yml/u);
  });
});
