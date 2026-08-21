import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ModelRunSseEvent,
  ModelRunUsage
} from "../../../domain/modelRunEvents";
import { decryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import {
  providerAuthenticationMode,
  ProviderConfigurationError,
  type ProviderConnectionConfiguration
} from "../../providers/providerConfiguration";
import {
  createProviderSafeFetch,
  ProviderSafeFetchError
} from "../../providers/providerSafeFetch";
import { ProviderResponseTooLargeError } from "../../providers/network";
import {
  createProviderRuntimeBinding,
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../providers/runtimeFactory";
import { ProviderStreamSafetyError } from "../../providers/streamSafety";
import type { ProviderRunRequest, ProviderRunResult } from "../../providers/types";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import type { ModelToolCall } from "../../tools/types";

type LockedCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
  testEvidence: unknown;
}>;

export type MemoryLearningProviderEvidence = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  executionSnapshot: unknown;
  providerModelId: string;
}>;

export type MemoryLearningProviderResult = Readonly<{
  providerResponseId: string | null;
  toolCalls: readonly ModelToolCall[] | undefined;
  usage: ModelRunUsage;
}>;

export type MemoryLearningProviderFailureClassification =
  | "UNKNOWN"
  | "REPLAY_SAFE_TRANSIENT"
  | "PERMANENT";

export type MemoryLearningProviderFailure = Readonly<{
  cause: unknown;
  classification: MemoryLearningProviderFailureClassification;
  usage: ModelRunUsage | null;
}>;

type RuntimeClient = Pick<PrismaClient, "$transaction">;

const replaySafeTransientHttpStatuses = new Set([
  408,
  429,
  500,
  502,
  503,
  504
]);

class MemoryLearningHttpStatusError extends Error {
  readonly classification: Exclude<
    MemoryLearningProviderFailureClassification,
    "UNKNOWN"
  >;

  constructor(readonly status: number) {
    super("memory_learning_provider_http_failure");
    this.name = "MemoryLearningHttpStatusError";
    this.classification = replaySafeTransientHttpStatuses.has(status)
      ? "REPLAY_SAFE_TRANSIENT"
      : "PERMANENT";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noAuthEvidence(value: unknown): boolean {
  return isRecord(value) && value.authenticationMode === "none";
}

function boundedProviderResponseId(value: string | undefined): string | null {
  return value && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/u.test(value)
    ? value
    : null;
}

function classifyProviderFailure(
  cause: unknown,
  observedEvent: boolean
): MemoryLearningProviderFailureClassification {
  // Once the adapter has yielded anything, dispatch happened and a retry can
  // no longer prove that it will not duplicate provider work.
  if (observedEvent) return "UNKNOWN";

  // The accepted-learning fetch fence observes the status before any adapter
  // parses it. This gives every provider the same typed, body-free decision.
  if (cause instanceof MemoryLearningHttpStatusError) {
    return cause.classification;
  }

  if (cause instanceof ProviderSafeFetchError) {
    // DNS resolution happens before the pinned request is dispatched.
    if (cause.code === "provider_http_dns_failed") {
      return "REPLAY_SAFE_TRANSIENT";
    }
    // A generic request failure may occur after bytes reached the provider.
    if (cause.code === "provider_http_request_failed") return "UNKNOWN";
    return "PERMANENT";
  }

  if (
    cause instanceof ProviderConfigurationError ||
    cause instanceof ProviderResponseTooLargeError ||
    cause instanceof ProviderStreamSafetyError
  ) {
    return "PERMANENT";
  }

  // Timeouts, aborts, untyped adapter errors, and network failures are
  // deliberately ambiguous. Never infer replay safety from an error string.
  return "UNKNOWN";
}

async function collectProviderResult(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>,
  callError: (
    usage: ModelRunUsage | null,
    cause: unknown,
    classification: MemoryLearningProviderFailureClassification
  ) => Error
): Promise<ProviderRunResult> {
  let lastUsage: ModelRunUsage | null = null;
  let observedEvent = false;
  try {
    let next = await stream.next();
    while (!next.done) {
      observedEvent = true;
      if (next.value.type === "usage") lastUsage = next.value.data;
      next = await stream.next();
    }
    return next.value;
  } catch (error) {
    throw callError(
      lastUsage,
      error,
      classifyProviderFailure(error, observedEvent)
    );
  }
}

/**
 * Owns the credential fence and provider invocation shared only by Memory
 * extraction, consolidation, and verification. Prompts and persistence stay
 * with their domain-specific callers.
 */
export function createAcceptedMemoryLearningProvider<
  Evidence extends MemoryLearningProviderEvidence,
  Request
>(
  client: RuntimeClient,
  input: Readonly<{
    buildRequest(snapshot: ProviderExecutionSnapshot, request: Request): ProviderRunRequest;
    callError(
      usage: ModelRunUsage | null,
      cause: unknown,
      classification: MemoryLearningProviderFailureClassification
    ): Error;
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
    invalidRuntimeError: string;
    validate?(
      evidence: Evidence,
      snapshot: ProviderExecutionSnapshot,
      request: Request
    ): boolean;
  }>
): (
  evidence: Evidence,
  request: Request,
  signal: AbortSignal
) => Promise<MemoryLearningProviderResult> {
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;

  return async (evidence, request, signal) => {
    const snapshot = normalizeProviderExecutionSnapshot(evidence.executionSnapshot);
    if (
      snapshot.connectionId !== evidence.connectionId ||
      snapshot.providerModelId !== evidence.providerModelId ||
      snapshot.credentialId !== evidence.credentialId ||
      snapshot.credentialVersionId !== evidence.credentialVersionId ||
      snapshot.model.adapterKind === "fake" ||
      snapshot.model.modelClass !== "answer" ||
      snapshot.model.capabilities.toolCalling !== true ||
      input.validate?.(evidence, snapshot, request) === false
    ) {
      throw new Error(input.invalidRuntimeError);
    }

    const authenticationMode = providerAuthenticationMode(snapshot.connection);
    const lockCredential = async (expectNoAuth: boolean): Promise<string | null> =>
      client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedCredentialVersion[]>(Prisma.sql`
          SELECT "credentialId", "id", "revokedAt", "secretEnvelope", "testEvidence"
          FROM "ProviderCredentialVersion"
          WHERE "credentialId" = ${evidence.credentialId}
            AND "id" = ${evidence.credentialVersionId}
          FOR SHARE
        `);
        const version = rows[0];
        if (
          !version || version.revokedAt ||
          version.credentialId !== evidence.credentialId ||
          version.id !== evidence.credentialVersionId ||
          expectNoAuth !== noAuthEvidence(version.testEvidence) ||
          expectNoAuth !== (version.secretEnvelope === null)
        ) {
          throw new Error("credential_revoked");
        }
        return version.secretEnvelope === null
          ? null
          : decryptProviderCredentialSecret({
              credentialId: version.credentialId,
              envelope: version.secretEnvelope,
              key: encryptionKey(),
              valueId: version.id
            });
      });
    const baseFetch = input.createFetch?.(snapshot.connection) ??
      createProviderSafeFetch({ configuration: snapshot.connection });
    let observedSuccessfulHttpResponse = false;
    const statusCheckedFetch: typeof fetch = async (fetchRequest, init) => {
      const response = await baseFetch(fetchRequest, init);
      if (response.ok) {
        observedSuccessfulHttpResponse = true;
        return response;
      }
      // A provider lifecycle may intentionally retry a follow-up poll. Once
      // the initial request succeeded, leave later statuses to that lifecycle;
      // collectProviderResult will still treat any escaped error as UNKNOWN
      // because the adapter has already emitted dispatch evidence.
      if (observedSuccessfulHttpResponse) return response;
      try {
        await response.body?.cancel();
      } catch {
        // The body is never inspected; cancellation is best-effort cleanup.
      }
      throw new MemoryLearningHttpStatusError(response.status);
    };
    const fetchFn: typeof fetch = authenticationMode === "none"
      ? async (fetchRequest, init) => {
          await lockCredential(true);
          return statusCheckedFetch(fetchRequest, init);
        }
      : statusCheckedFetch;
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: authenticationMode === "none"
        ? null
        : async () => {
            const secret = await lockCredential(false);
            if (secret === null) throw new Error("credential_revoked");
            return secret;
          },
      snapshot
    });
    if (!runtime.toolBridge?.supportsToolCalling({
      modelId: snapshot.model.upstreamModelId,
      provider: snapshot.providerFamily
    })) {
      throw new Error(input.invalidRuntimeError);
    }
    const result = await collectProviderResult(
      runtime.adapter.stream(input.buildRequest(snapshot, request), { signal }),
      input.callError
    );
    return {
      providerResponseId: boundedProviderResponseId(result.providerResponseId),
      toolCalls: result.toolCalls,
      usage: result.usage
    };
  };
}
