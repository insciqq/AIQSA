import { describe, expect, it } from "vitest";
import { memoryLexicalBackendConfigurationFromEnv } from "./config";

describe("Memory lexical backend configuration", () => {
  it("keeps PostgreSQL authoritative by default", () => {
    expect(memoryLexicalBackendConfigurationFromEnv({})).toEqual({
      backend: "POSTGRES",
      canaryPercent: 1,
      circuitBreakerCooldownMs: 30_000,
      circuitBreakerFailureThreshold: 5,
      maximumConcurrency: 2,
      timeoutMs: 1_200
    });
  });

  it("accepts every bounded rollout mode and its operator controls", () => {
    expect(memoryLexicalBackendConfigurationFromEnv({
      AIQSA_MEMORY_LEXICAL_BACKEND: "SHADOW",
      AIQSA_MEMORY_OPENSEARCH_CANARY_PERCENT: "25",
      AIQSA_MEMORY_OPENSEARCH_CIRCUIT_COOLDOWN_MS: "45000",
      AIQSA_MEMORY_OPENSEARCH_CIRCUIT_FAILURE_THRESHOLD: "3",
      AIQSA_MEMORY_OPENSEARCH_SHADOW_MAX_CONCURRENCY: "4",
      AIQSA_MEMORY_OPENSEARCH_SHADOW_TIMEOUT_MS: "900"
    })).toEqual({
      backend: "SHADOW",
      canaryPercent: 25,
      circuitBreakerCooldownMs: 45_000,
      circuitBreakerFailureThreshold: 3,
      maximumConcurrency: 4,
      timeoutMs: 900
    });
    for (const backend of [
      "POSTGRES",
      "SHADOW",
      "OPENSEARCH_CANARY",
      "OPENSEARCH"
    ]) {
      expect(memoryLexicalBackendConfigurationFromEnv({
        AIQSA_MEMORY_LEXICAL_BACKEND: backend
      }).backend).toBe(backend);
    }
  });

  it("fails closed on unknown modes or out-of-range rollout controls", () => {
    const invalid = [
      { AIQSA_MEMORY_LEXICAL_BACKEND: "shadow" },
      { AIQSA_MEMORY_LEXICAL_BACKEND: "ELASTICSEARCH" },
      { AIQSA_MEMORY_OPENSEARCH_CANARY_PERCENT: "0" },
      { AIQSA_MEMORY_OPENSEARCH_CANARY_PERCENT: "101" },
      { AIQSA_MEMORY_OPENSEARCH_CIRCUIT_FAILURE_THRESHOLD: "0" },
      { AIQSA_MEMORY_OPENSEARCH_CIRCUIT_FAILURE_THRESHOLD: "21" },
      { AIQSA_MEMORY_OPENSEARCH_CIRCUIT_COOLDOWN_MS: "999" },
      { AIQSA_MEMORY_OPENSEARCH_CIRCUIT_COOLDOWN_MS: "300001" },
      { AIQSA_MEMORY_OPENSEARCH_SHADOW_MAX_CONCURRENCY: "0" }
    ];
    for (const env of invalid) {
      expect(() => memoryLexicalBackendConfigurationFromEnv(env)).toThrow(
        "memory_lexical_backend_configuration_invalid"
      );
    }
  });
});
