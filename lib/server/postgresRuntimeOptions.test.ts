import { describe, expect, it } from "vitest";
import {
  AIQSA_POSTGRES_RUNTIME_OPTIONS_VERSION,
  aiqsaPostgresRuntimeOptions
} from "./postgresRuntimeOptions";

describe("AIQSA PostgreSQL runtime options", () => {
  it("disables JIT for latency-sensitive OLTP connections by default", () => {
    expect(aiqsaPostgresRuntimeOptions(undefined)).toBe("-c jit=off");
    expect(AIQSA_POSTGRES_RUNTIME_OPTIONS_VERSION)
      .toBe("aiqsa-postgres-runtime-options-v1");
  });

  it("preserves operator options and makes the AIQSA JIT setting final", () => {
    expect(aiqsaPostgresRuntimeOptions("-c statement_timeout=5000 -c jit=on"))
      .toBe("-c statement_timeout=5000 -c jit=on -c jit=off");
  });

  it("does not duplicate an existing JIT-off option", () => {
    expect(aiqsaPostgresRuntimeOptions(" -c statement_timeout=5000 -c jit=off "))
      .toBe("-c statement_timeout=5000 -c jit=off");
  });
});
