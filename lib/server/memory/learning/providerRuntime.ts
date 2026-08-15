import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ModelRunSseEvent,
  ModelRunUsage
} from "../../../domain/modelRunEvents";
import { decryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import {
  providerAuthenticationMode,
  type ProviderConnectionConfiguration
} from "../../providers/providerConfiguration";
import { createProviderSafeFetch } from "../../providers/providerSafeFetch";
import {
  createProviderRuntimeBinding,
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../providers/runtimeFactory";
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

type RuntimeClient = Pick<PrismaClient, "$transaction">;

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

async function collectProviderResult(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>,
  callError: (usage: ModelRunUsage | null, cause: unknown) => Error
): Promise<ProviderRunResult> {
  let lastUsage: ModelRunUsage | null = null;
  try {
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === "usage") lastUsage = next.value.data;
      next = await stream.next();
    }
    return next.value;
  } catch (error) {
    throw callError(lastUsage, error);
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
    callError(usage: ModelRunUsage | null, cause: unknown): Error;
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
    const fetchFn: typeof fetch = authenticationMode === "none"
      ? async (fetchRequest, init) => {
          await lockCredential(true);
          return baseFetch(fetchRequest, init);
        }
      : baseFetch;
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
