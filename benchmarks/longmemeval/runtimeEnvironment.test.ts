import { afterEach, describe, expect, it, vi } from "vitest";

const { loadEnv } = vi.hoisted(() => ({ loadEnv: vi.fn() }));
vi.mock("@next/env", () => ({ loadEnvConfig: loadEnv }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });

describe("benchmark database authority before singleton imports", () => {
  it("rejects missing authority without loading installation environment", async () => {
    vi.stubEnv("AIQSA_MEMORY_BENCHMARK_ACK", "");
    await expect(import("./runtimeEnvironment")).rejects.toThrow("authority_required");
    expect(loadEnv).not.toHaveBeenCalled();
  });
  it("rejects a production target before configuration loading", async () => {
    vi.stubEnv("AIQSA_MEMORY_BENCHMARK_ACK", "DISPOSABLE_PAID_LONGMEMEVAL");
    vi.stubEnv("AIQSA_MEMORY_BENCHMARK_DATABASE_URL", "postgresql://operator:invalid@127.0.0.1:5432/production?schema=public");
    await expect(import("./runtimeEnvironment")).rejects.toThrow("not_isolated");
    expect(loadEnv).not.toHaveBeenCalled();
  });
  it("binds globals to the guarded database and caps the benchmark pool", async () => {
    vi.stubEnv("AIQSA_MEMORY_BENCHMARK_ACK", "DISPOSABLE_PAID_LONGMEMEVAL");
    vi.stubEnv("AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT", "55437");
    vi.stubEnv("AIQSA_MEMORY_BENCHMARK_DATABASE_URL", "postgresql://aiqsa_benchmark:aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/aiqsa_memory_benchmark?schema=public");
    vi.stubEnv("DATABASE_URL", "installation-must-not-be-used");
    const { runtimeDatabaseUrl } = await import("./runtimeEnvironment");
    expect(process.env.DATABASE_URL).toBe(runtimeDatabaseUrl);
    expect(new URL(runtimeDatabaseUrl).searchParams.get("connection_limit")).toBe("4");
    expect(loadEnv).toHaveBeenCalledOnce();
  });
});
