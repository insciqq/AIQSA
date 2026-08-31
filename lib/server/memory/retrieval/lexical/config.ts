export type MemoryLexicalBackendMode =
  | "OPENSEARCH"
  | "OPENSEARCH_CANARY"
  | "POSTGRES"
  | "SHADOW";

export type MemoryLexicalBackendConfiguration = Readonly<{
  backend: MemoryLexicalBackendMode;
  canaryPercent: number;
  circuitBreakerCooldownMs: number;
  circuitBreakerFailureThreshold: number;
  maximumConcurrency: number;
  timeoutMs: number;
}>;

export type MemoryLexicalShadowConfiguration = Pick<
  MemoryLexicalBackendConfiguration,
  "backend" | "maximumConcurrency" | "timeoutMs"
>;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("memory_lexical_backend_configuration_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("memory_lexical_backend_configuration_invalid");
  }
  return parsed;
}

export function memoryLexicalBackendConfigurationFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): MemoryLexicalBackendConfiguration {
  const backend = env.AIQSA_MEMORY_LEXICAL_BACKEND?.trim() || "POSTGRES";
  if (backend !== "POSTGRES" && backend !== "SHADOW" &&
    backend !== "OPENSEARCH_CANARY" && backend !== "OPENSEARCH") {
    throw new Error("memory_lexical_backend_configuration_invalid");
  }
  return Object.freeze({
    backend,
    canaryPercent: boundedInteger(
      env.AIQSA_MEMORY_OPENSEARCH_CANARY_PERCENT,
      1,
      1,
      100
    ),
    circuitBreakerCooldownMs: boundedInteger(
      env.AIQSA_MEMORY_OPENSEARCH_CIRCUIT_COOLDOWN_MS,
      30_000,
      1_000,
      300_000
    ),
    circuitBreakerFailureThreshold: boundedInteger(
      env.AIQSA_MEMORY_OPENSEARCH_CIRCUIT_FAILURE_THRESHOLD,
      5,
      1,
      20
    ),
    maximumConcurrency: boundedInteger(
      env.AIQSA_MEMORY_OPENSEARCH_SHADOW_MAX_CONCURRENCY,
      2,
      1,
      16
    ),
    timeoutMs: boundedInteger(
      env.AIQSA_MEMORY_OPENSEARCH_SHADOW_TIMEOUT_MS,
      1_200,
      250,
      5_000
    )
  });
}
