import { describe, expect, it } from "vitest";
import {
  AIQSA_POSTGRES_RUNTIME_OPTIONS_VERSION,
  aiqsaPostgresRuntimeOptions,
  aiqsaPostgresRuntimeUrl
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

describe("AIQSA PostgreSQL runtime URL", () => {
  const base = "postgresql://database.invalid/fixture";
  const encodedJitOff = "-c%20jit%3Doff";

  it.each(["", "?schema=public", "?application_name=aiqsa-worker"])(
    "adds percent-encoded startup options with query %s",
    (query) => {
      const result = aiqsaPostgresRuntimeUrl(`${base}${query}`);
      expect(result).toBe(`${base}${query}${query ? "&" : "?"}options=${encodedJitOff}`);
      expect(new URL(result!).searchParams.get("options")).toBe("-c jit=off");
    }
  );

  it("preserves the bytes and order of unrelated parameters", () => {
    const query = "?schema=public&application_name=aiqsa%2dworker&connection_limit=4&sslmode=require&tag=a+b&tag=%2f";
    expect(aiqsaPostgresRuntimeUrl(`${base}${query}`))
      .toBe(`${base}${query}&options=${encodedJitOff}`);
  });

  it.each(["-c+statement_timeout%3D5000", "-c%20statement_timeout=5000"])(
    "merges operator options decoded from %s",
    (options) => {
      const result = aiqsaPostgresRuntimeUrl(`${base}?schema=public&options=${options}&application_name=aiqsa-worker`);
      expect(result).toBe(`${base}?schema=public&options=-c%20statement_timeout%3D5000%20${encodedJitOff}&application_name=aiqsa-worker`);
      expect(new URL(result!).searchParams.get("options"))
        .toBe("-c statement_timeout=5000 -c jit=off");
    }
  );

  it("appends JIT-off after an operator's JIT-on option", () => {
    const result = aiqsaPostgresRuntimeUrl(`${base}?options=-c%20jit%3Don`);
    expect(new URL(result!).searchParams.get("options")).toBe("-c jit=on -c jit=off");
  });

  it.each(["-c%20jit%3Doff", "+-c+jit=off+", "-c+statement_timeout=5000+-cjit=off"])(
    "leaves existing JIT-off option bytes unchanged: %s",
    (options) => {
      const original = `${base}?options=${options}&schema=public`;
      expect(aiqsaPostgresRuntimeUrl(original)).toBe(original);
    }
  );

  it("handles encoded option keys and duplicate options without losing the effective last value", () => {
    const result = aiqsaPostgresRuntimeUrl(`${base}?%6Fptions=-c+jit=off&options=-c+statement_timeout=5000`);
    expect(result).toBe(`${base}?%6Fptions=-c+jit=off&options=-c%20statement_timeout%3D5000%20${encodedJitOff}`);
  });

  it("preserves a question mark inside an unrelated query key", () => {
    expect(aiqsaPostgresRuntimeUrl(`${base}??options=fixture`))
      .toBe(`${base}??options=fixture&options=${encodedJitOff}`);
  });

  it.each(["?options", "?options="])("fills empty options: %s", (query) => {
    expect(aiqsaPostgresRuntimeUrl(`${base}${query}`)).toBe(`${base}?options=${encodedJitOff}`);
  });

  it.each(["?", "?schema=public&"])("uses the existing query separator: %s", (query) => {
    expect(aiqsaPostgresRuntimeUrl(`${base}${query}`)).toBe(`${base}${query}options=${encodedJitOff}`);
  });

  it("preserves encoded userinfo and path bytes", () => {
    const username = encodeURIComponent("synthetic+user@fixture");
    const password = encodeURIComponent(" /?@:%+=#").replaceAll("%2F", "%2f");
    const original = `postgres://${username}:${password}@database.invalid:5432/db%2fname?schema=public`;
    expect(aiqsaPostgresRuntimeUrl(original)).toBe(`${original}&options=${encodedJitOff}`);
  });

  it("inserts options before a fragment and is idempotent", () => {
    const result = aiqsaPostgresRuntimeUrl(`${base}?schema=public#fixture`);
    expect(result).toBe(`${base}?schema=public&options=${encodedJitOff}#fixture`);
    expect(aiqsaPostgresRuntimeUrl(result)).toBe(result);
  });

  it.each([undefined, ""])("leaves absent configuration for Prisma's lazy validation", (value) => {
    expect(aiqsaPostgresRuntimeUrl(value)).toBe(value);
  });

  it.each([" ", "invalid", "postgresql://[invalid", "https://database.invalid/fixture"])(
    "rejects malformed or non-PostgreSQL configuration without exposing input",
    (value) => {
      expect(() => aiqsaPostgresRuntimeUrl(value)).toThrowError(new Error("postgres_runtime_url_invalid"));
    }
  );
});
