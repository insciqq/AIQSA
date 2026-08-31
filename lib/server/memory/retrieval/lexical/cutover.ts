import type { PrismaClient } from "@prisma/client";
import { createMemoryOpenSearchClient } from
  "../../../search/opensearch/memoryClient";
import {
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchProjectionFingerprint,
  memoryOpenSearchUserScope
} from "../../../search/opensearch/memoryContract";
import {
  assertMemoryLexicalSearchRequest,
  assertMemoryLexicalSearchResult,
  type MemoryLexicalCandidateProvider,
  type MemoryLexicalFailureCode,
  type MemoryLexicalProviderEvidence,
  type MemoryLexicalSearchRequest,
  type MemoryLexicalSearchResult
} from "./contract";
import type {
  MemoryLexicalBackendConfiguration,
  MemoryLexicalBackendMode
} from "./config";
import { memoryLexicalBackendConfigurationFromEnv } from "./config";
import { createOpenSearchMemoryLexicalCandidateProvider } from
  "./opensearchProvider";
import {
  createPostgresUnicodeMemoryLexicalCandidateProvider,
  type PostgresUnicodeMemoryLexicalLane
} from "./postgresUnicodeProvider";
import { MEMORY_READ_BUDGET_MS } from "../readBudget";

const userScopePattern = /^[a-f0-9]{64}$/u;
const breakerFailureCodes = new Set<MemoryLexicalFailureCode>([
  "memory_lexical_lane_unavailable",
  "memory_opensearch_authentication_failed",
  "memory_opensearch_canonical_guard",
  "memory_opensearch_connection_failed",
  "memory_opensearch_index_incompatible",
  "memory_opensearch_index_missing",
  "memory_opensearch_rate_limited",
  "memory_opensearch_response_invalid",
  "memory_opensearch_response_too_large",
  "memory_opensearch_timeout",
  "memory_opensearch_unavailable"
]);

export function memoryLexicalCanaryBucket(userScope: string): number {
  if (!userScopePattern.test(userScope)) {
    throw new Error("memory_lexical_canary_scope_invalid");
  }
  return Number.parseInt(userScope.slice(0, 12), 16) % 100;
}

export function memoryLexicalOpenSearchSelected(
  configuration: Readonly<{
    backend: MemoryLexicalBackendMode;
    canaryPercent: number;
  }>,
  userScope: string
): boolean {
  if (!Number.isSafeInteger(configuration.canaryPercent) ||
    configuration.canaryPercent < 1 || configuration.canaryPercent > 100) {
    throw new Error("memory_lexical_backend_configuration_invalid");
  }
  if (configuration.backend === "OPENSEARCH") return true;
  if (configuration.backend !== "OPENSEARCH_CANARY") return false;
  return memoryLexicalCanaryBucket(userScope) < configuration.canaryPercent;
}

export type MemoryLexicalCircuitState = "CLOSED" | "HALF_OPEN" | "OPEN";

export type MemoryLexicalCircuitPermit = Readonly<{
  epoch: number;
  kind: "CLOSED" | "HALF_OPEN";
}>;

export type MemoryLexicalCircuitSnapshot = Readonly<{
  consecutiveFailureCount: number;
  state: MemoryLexicalCircuitState;
}>;

export class MemoryLexicalCircuitBreaker {
  #consecutiveFailureCount = 0;
  #epoch = 0;
  #retryAtMs = 0;
  #state: MemoryLexicalCircuitState = "CLOSED";

  constructor(
    private readonly configuration: Readonly<{
      cooldownMs: number;
      failureThreshold: number;
    }>,
    private readonly clock: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(configuration.cooldownMs) ||
      configuration.cooldownMs < 1_000 || configuration.cooldownMs > 300_000 ||
      !Number.isSafeInteger(configuration.failureThreshold) ||
      configuration.failureThreshold < 1 ||
      configuration.failureThreshold > 20) {
      throw new Error("memory_lexical_circuit_configuration_invalid");
    }
  }

  acquire(): MemoryLexicalCircuitPermit | null {
    const now = this.#now();
    if (this.#state === "CLOSED") {
      return Object.freeze({ epoch: this.#epoch, kind: "CLOSED" });
    }
    if (this.#state === "HALF_OPEN" || now < this.#retryAtMs) return null;
    this.#state = "HALF_OPEN";
    return Object.freeze({ epoch: this.#epoch, kind: "HALF_OPEN" });
  }

  failure(permit: MemoryLexicalCircuitPermit): void {
    this.#assertPermit(permit);
    if (permit.epoch !== this.#epoch) return;
    if (permit.kind === "HALF_OPEN" && this.#state === "HALF_OPEN") {
      this.#open();
      return;
    }
    if (permit.kind !== "CLOSED" || this.#state !== "CLOSED") return;
    this.#consecutiveFailureCount += 1;
    if (this.#consecutiveFailureCount >= this.configuration.failureThreshold) {
      this.#open();
    }
  }

  release(permit: MemoryLexicalCircuitPermit): void {
    this.#assertPermit(permit);
    if (permit.epoch === this.#epoch && permit.kind === "HALF_OPEN" &&
      this.#state === "HALF_OPEN") {
      this.#open();
    }
  }

  rejectCurrentAttempt(): void {
    const permit = this.acquire();
    if (permit) this.failure(permit);
  }

  snapshot(): MemoryLexicalCircuitSnapshot {
    return Object.freeze({
      consecutiveFailureCount: this.#consecutiveFailureCount,
      state: this.#state
    });
  }

  success(permit: MemoryLexicalCircuitPermit): void {
    this.#assertPermit(permit);
    if (permit.epoch !== this.#epoch) return;
    if (permit.kind === "HALF_OPEN" && this.#state === "HALF_OPEN") {
      this.#epoch += 1;
      this.#state = "CLOSED";
      this.#retryAtMs = 0;
      this.#consecutiveFailureCount = 0;
      return;
    }
    if (permit.kind === "CLOSED" && this.#state === "CLOSED") {
      this.#consecutiveFailureCount = 0;
    }
  }

  #assertPermit(permit: MemoryLexicalCircuitPermit): void {
    if (!permit || !Number.isSafeInteger(permit.epoch) || permit.epoch < 0 ||
      (permit.kind !== "CLOSED" && permit.kind !== "HALF_OPEN")) {
      throw new Error("memory_lexical_circuit_permit_invalid");
    }
  }

  #now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("memory_lexical_circuit_clock_invalid");
    }
    return now;
  }

  #open(): void {
    this.#epoch += 1;
    this.#state = "OPEN";
    this.#retryAtMs = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.#now() + this.configuration.cooldownMs
    );
  }
}

function breakerFailure(code: MemoryLexicalFailureCode): boolean {
  return breakerFailureCodes.has(code);
}

function requestContractFailure(error: unknown): boolean {
  return error instanceof Error &&
    error.message === "memory_lexical_search_request_invalid";
}

type RoutedMemoryLexicalCandidateProviderInput = Readonly<{
  breaker: MemoryLexicalCircuitBreaker;
  configuration: Pick<
    MemoryLexicalBackendConfiguration,
    "backend" | "canaryPercent"
  >;
  openSearch: MemoryLexicalCandidateProvider;
  postgres: MemoryLexicalCandidateProvider;
  userScopeForUser?: (userId: string) => string;
}>;

export class RoutedMemoryLexicalCandidateProvider implements
MemoryLexicalCandidateProvider {
  readonly backend = "ROUTED" as const;

  constructor(private readonly input: RoutedMemoryLexicalCandidateProviderInput) {
    if (input.openSearch.backend !== "OPENSEARCH" ||
      input.postgres.backend !== "POSTGRES" ||
      (input.configuration.backend !== "OPENSEARCH" &&
        input.configuration.backend !== "OPENSEARCH_CANARY") ||
      (input.configuration.backend === "OPENSEARCH_CANARY" &&
        !input.userScopeForUser)) {
      throw new Error("memory_lexical_cutover_configuration_invalid");
    }
  }

  async prepare(request: MemoryLexicalSearchRequest): Promise<void> {
    assertMemoryLexicalSearchRequest(request);
    if (!this.#selected(request.userId)) return;
    await this.input.openSearch.prepare?.(request);
  }

  async search(request: MemoryLexicalSearchRequest): Promise<MemoryLexicalSearchResult> {
    assertMemoryLexicalSearchRequest(request);
    if (!this.#selected(request.userId)) {
      const postgres = await this.input.postgres.search(request);
      assertMemoryLexicalSearchResult(request, postgres, "POSTGRES");
      return postgres;
    }
    const startedAt = Date.now();
    const permit = this.input.breaker.acquire();
    if (!permit) {
      return this.#fallback(
        request,
        "memory_opensearch_circuit_open",
        null,
        startedAt
      );
    }

    let primary: MemoryLexicalSearchResult;
    try {
      primary = await this.input.openSearch.search(request);
      assertMemoryLexicalSearchResult(request, primary, "OPENSEARCH");
    } catch (error) {
      if (requestContractFailure(error)) {
        this.input.breaker.release(permit);
        throw error;
      }
      this.input.breaker.failure(permit);
      return this.#fallback(
        request,
        "memory_opensearch_response_invalid",
        null,
        startedAt
      );
    }
    if (primary.evidence.failureCode === null) {
      this.input.breaker.success(permit);
      return primary;
    }
    if (breakerFailure(primary.evidence.failureCode)) {
      this.input.breaker.failure(permit);
    } else {
      this.input.breaker.release(permit);
    }
    return this.#fallback(
      request,
      primary.evidence.failureCode,
      primary.evidence,
      startedAt
    );
  }

  async fallbackAfterCanonicalGuard(
    request: MemoryLexicalSearchRequest,
    primary: MemoryLexicalProviderEvidence
  ): Promise<MemoryLexicalSearchResult> {
    assertMemoryLexicalSearchRequest(request);
    if (primary.backend !== "OPENSEARCH" || primary.failureCode !== null ||
      primary.requestedLimit !== request.finalLimit) {
      throw new Error("memory_lexical_canonical_guard_invalid");
    }
    this.input.breaker.rejectCurrentAttempt();
    return this.#fallback(
      request,
      "memory_opensearch_canonical_guard",
      primary,
      Date.now()
    );
  }

  #selected(userId: string): boolean {
    if (this.input.configuration.backend === "OPENSEARCH") return true;
    const userScope = this.input.userScopeForUser!(userId);
    return memoryLexicalOpenSearchSelected(this.input.configuration, userScope);
  }

  async #fallback(
    request: MemoryLexicalSearchRequest,
    failureCode: MemoryLexicalFailureCode,
    primary: MemoryLexicalProviderEvidence | null,
    startedAt: number
  ): Promise<MemoryLexicalSearchResult> {
    const fallbackRequest = Object.freeze({
      ...request,
      deadlineAtMs: Date.now() + MEMORY_READ_BUDGET_MS.LEXICAL_CANDIDATE
    });
    const fallback = await this.input.postgres.search(fallbackRequest);
    assertMemoryLexicalSearchResult(fallbackRequest, fallback, "POSTGRES");
    const result = Object.freeze({
      candidates: fallback.candidates,
      evidence: Object.freeze({
        ...fallback.evidence,
        durationMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
        failureCode: fallback.evidence.failureCode ?? failureCode,
        fallbackUsed: true,
        opaqueId: primary?.opaqueId ?? null,
        projectionCaughtUp: primary?.projectionCaughtUp ?? null,
        projectionEventLag: primary?.projectionEventLag ?? null,
        projectionRevisionLag: primary?.projectionRevisionLag ?? null,
        projectionVisibleAgeMs: primary?.projectionVisibleAgeMs ?? null,
        timedOut: fallback.evidence.timedOut || primary?.timedOut === true ||
          failureCode === "memory_opensearch_timeout"
      })
    });
    assertMemoryLexicalSearchResult(request, result, "POSTGRES");
    return result;
  }
}

export type MemoryLexicalCanonicalGuardFallbackProvider =
  MemoryLexicalCandidateProvider & Readonly<{
    backend: "ROUTED";
    fallbackAfterCanonicalGuard(
      request: MemoryLexicalSearchRequest,
      primary: MemoryLexicalProviderEvidence
    ): Promise<MemoryLexicalSearchResult>;
  }>;

export function supportsMemoryLexicalCanonicalGuardFallback(
  provider: MemoryLexicalCandidateProvider
): provider is MemoryLexicalCanonicalGuardFallbackProvider {
  return provider.backend === "ROUTED" &&
    "fallbackAfterCanonicalGuard" in provider &&
    typeof provider.fallbackAfterCanonicalGuard === "function";
}

export type MemoryLexicalCutoverRuntime = Readonly<{
  circuitBreaker: MemoryLexicalCircuitBreaker | null;
  configuration: MemoryLexicalBackendConfiguration;
  providerForLane(
    lane: PostgresUnicodeMemoryLexicalLane
  ): MemoryLexicalCandidateProvider;
}>;

export function createMemoryLexicalCutoverRuntime(input: Readonly<{
  client: PrismaClient;
  configuration: MemoryLexicalBackendConfiguration;
  openSearchUserScope?: (userId: string) => string;
  openSearchProviderForLane?: (
    lane: PostgresUnicodeMemoryLexicalLane
  ) => MemoryLexicalCandidateProvider;
  postgresProviderForLane?: (
    lane: PostgresUnicodeMemoryLexicalLane
  ) => MemoryLexicalCandidateProvider;
}>): MemoryLexicalCutoverRuntime {
  const postgresProviders = new Map<
    PostgresUnicodeMemoryLexicalLane,
    MemoryLexicalCandidateProvider
  >();
  const postgresProviderForLane = input.postgresProviderForLane ?? ((lane) => {
    const current = postgresProviders.get(lane);
    if (current) return current;
    const created = createPostgresUnicodeMemoryLexicalCandidateProvider(
      input.client,
      lane
    );
    postgresProviders.set(lane, created);
    return created;
  });
  if (input.configuration.backend === "POSTGRES" ||
    input.configuration.backend === "SHADOW") {
    return Object.freeze({
      circuitBreaker: null,
      configuration: input.configuration,
      providerForLane: postgresProviderForLane
    });
  }
  if (!input.openSearchProviderForLane || !input.openSearchUserScope) {
    throw new Error("memory_lexical_cutover_configuration_invalid");
  }
  const breaker = new MemoryLexicalCircuitBreaker({
    cooldownMs: input.configuration.circuitBreakerCooldownMs,
    failureThreshold: input.configuration.circuitBreakerFailureThreshold
  });
  const routedProviders = new Map<
    PostgresUnicodeMemoryLexicalLane,
    MemoryLexicalCandidateProvider
  >();
  return Object.freeze({
    circuitBreaker: breaker,
    configuration: input.configuration,
    providerForLane(lane) {
      const current = routedProviders.get(lane);
      if (current) return current;
      const created = new RoutedMemoryLexicalCandidateProvider({
        breaker,
        configuration: input.configuration,
        openSearch: input.openSearchProviderForLane!(lane),
        postgres: postgresProviderForLane(lane),
        userScopeForUser: input.openSearchUserScope
      });
      routedProviders.set(lane, created);
      return created;
    }
  });
}

const defaultCutoverRuntimes = new WeakMap<object, Map<
  string,
  MemoryLexicalCutoverRuntime
>>();

export function defaultMemoryLexicalCutoverRuntime(
  client: PrismaClient,
  env: NodeJS.ProcessEnv = process.env
): MemoryLexicalCutoverRuntime {
  const configuration = memoryLexicalBackendConfigurationFromEnv(env);
  let cacheKey = JSON.stringify(configuration);
  const openSearchConfiguration = configuration.backend === "OPENSEARCH" ||
    configuration.backend === "OPENSEARCH_CANARY"
    ? memoryOpenSearchConfigurationFromEnv(env)
    : null;
  if (openSearchConfiguration) {
    cacheKey += `:${memoryOpenSearchProjectionFingerprint(openSearchConfiguration)}`;
  }
  const byConfiguration = defaultCutoverRuntimes.get(client) ?? new Map();
  const current = byConfiguration.get(cacheKey);
  if (current) return current;
  let openSearchProviderForLane: ((
    lane: PostgresUnicodeMemoryLexicalLane
  ) => MemoryLexicalCandidateProvider) | undefined;
  let openSearchUserScope: ((userId: string) => string) | undefined;
  if (openSearchConfiguration) {
    const openSearchClient = createMemoryOpenSearchClient(env);
    const providers = new Map<
      PostgresUnicodeMemoryLexicalLane,
      MemoryLexicalCandidateProvider
    >();
    openSearchProviderForLane = (lane) => {
      const current = providers.get(lane);
      if (current) return current;
      const created = createOpenSearchMemoryLexicalCandidateProvider(
        client,
        lane,
        env,
        openSearchClient
      );
      providers.set(lane, created);
      return created;
    };
    openSearchUserScope = (userId) => memoryOpenSearchUserScope(
      userId,
      openSearchConfiguration
    );
  }
  const created = createMemoryLexicalCutoverRuntime({
    client,
    configuration,
    openSearchProviderForLane,
    openSearchUserScope
  });
  byConfiguration.set(cacheKey, created);
  defaultCutoverRuntimes.set(client, byConfiguration);
  return created;
}
