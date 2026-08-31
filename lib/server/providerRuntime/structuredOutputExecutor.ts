import { Prisma, type PrismaClient } from "@prisma/client";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import {
  providerAuthenticationMode,
  type ProviderConnectionConfiguration
} from "../providers/providerConfiguration";
import { createProviderSafeFetch } from "../providers/providerSafeFetch";
import {
  createProviderRuntimeBinding,
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../providers/runtimeFactory";
import type {
  ProviderStructuredOutputOptions,
  ProviderStructuredOutputRequest
} from "../providers/structuredOutput";
import { supportsStructuredOutputAdapter } from "../providers/structuredOutput";
import { getSecretEncryptionKey } from "../secrets/envelope";
import type { ProviderAdmissionRole } from "./admission";

type LockedCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
  testEvidence: unknown;
}>;

type RuntimeClient = Pick<PrismaClient, "$transaction">;

type AcceptedStructuredOutputExecutorOptions = Readonly<{
  createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
  encryptionKey?: () => Buffer;
}>;

type AcceptedStructuredOutputSnapshotBinding = Readonly<{
  authenticationMode: ReturnType<typeof providerAuthenticationMode>;
  lockCredential(expectNoAuth: boolean): Promise<string | null>;
  snapshot: ProviderExecutionSnapshot;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noAuthEvidence(value: unknown): boolean {
  return isRecord(value) && value.authenticationMode === "none";
}

function createAcceptedStructuredOutputSnapshotBinding(
  client: RuntimeClient,
  executionSnapshot: ProviderExecutionSnapshot,
  options: AcceptedStructuredOutputExecutorOptions
): AcceptedStructuredOutputSnapshotBinding {
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;
  const snapshot = normalizeProviderExecutionSnapshot(executionSnapshot);
  if (
    snapshot.model.adapterKind === "fake" ||
    !supportsStructuredOutputAdapter(snapshot.model.adapterKind) ||
    snapshot.model.modelClass !== "answer" ||
    !snapshot.credentialId ||
    !snapshot.credentialVersionId
  ) {
    throw new Error("structured_output_not_supported");
  }
  const credentialId = snapshot.credentialId;
  const credentialVersionId = snapshot.credentialVersionId;
  const authenticationMode = providerAuthenticationMode(snapshot.connection);
  const lockCredential = async (expectNoAuth: boolean): Promise<string | null> =>
    client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedCredentialVersion[]>(Prisma.sql`
        SELECT "credentialId", "id", "revokedAt", "secretEnvelope", "testEvidence"
        FROM "ProviderCredentialVersion"
        WHERE "credentialId" = ${credentialId}
          AND "id" = ${credentialVersionId}
        FOR SHARE
      `);
      const version = rows[0];
      if (
        !version || version.revokedAt ||
        version.credentialId !== credentialId ||
        version.id !== credentialVersionId ||
        expectNoAuth !== noAuthEvidence(version.testEvidence) ||
        expectNoAuth !== (version.secretEnvelope === null)
      ) throw new Error("credential_revoked");
      return version.secretEnvelope === null
        ? null
        : decryptProviderCredentialSecret({
            credentialId,
            envelope: version.secretEnvelope,
            key: encryptionKey(),
            valueId: credentialVersionId
          });
    });
  return Object.freeze({ authenticationMode, lockCredential, snapshot });
}

/** Verifies that an accepted immutable snapshot still resolves to the exact
 * non-revoked credential version and that its envelope is decryptable in this
 * runtime. No provider adapter or network transport is invoked. */
export async function assertAcceptedStructuredOutputSnapshotExecutable(
  client: RuntimeClient,
  executionSnapshot: ProviderExecutionSnapshot,
  options: AcceptedStructuredOutputExecutorOptions = {}
): Promise<void> {
  const binding = createAcceptedStructuredOutputSnapshotBinding(
    client,
    executionSnapshot,
    options
  );
  await binding.lockCredential(binding.authenticationMode === "none");
}

/** Executes one bounded strict-schema request from an immutable execution
 * snapshot already accepted by the owning authority. This form is used by
 * durable Memory bindings so no synthetic mutable-version authority is
 * manufactured after admission. */
export function createAcceptedStructuredOutputSnapshotExecutor(
  client: RuntimeClient,
  options: AcceptedStructuredOutputExecutorOptions = {}
) {
  return async (
    executionSnapshot: ProviderExecutionSnapshot,
    request: ProviderStructuredOutputRequest,
    executionOptions: ProviderStructuredOutputOptions = {}
  ): Promise<Record<string, unknown>> => {
    const binding = createAcceptedStructuredOutputSnapshotBinding(
      client,
      executionSnapshot,
      options
    );
    const baseFetch = options.createFetch?.(binding.snapshot.connection) ??
      createProviderSafeFetch({ configuration: binding.snapshot.connection });
    const fetchFn: typeof fetch = binding.authenticationMode === "none"
      ? async (fetchRequest, init) => {
          await binding.lockCredential(true);
          return baseFetch(fetchRequest, init);
        }
      : baseFetch;
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: binding.authenticationMode === "none"
        ? null
        : async () => {
            const secret = await binding.lockCredential(false);
            if (secret === null) throw new Error("credential_revoked");
            return secret;
          },
      snapshot: binding.snapshot
    });
    if (!runtime.structuredOutputAdapter) {
      throw new Error("structured_output_not_supported");
    }
    return runtime.structuredOutputAdapter.execute(request, executionOptions);
  };
}

/** Executes one bounded strict-schema request against an already admitted
 * exact provider/model/credential tuple. The credential is re-checked at the
 * network boundary and no raw provider response leaves the adapter. */
export function createAcceptedStructuredOutputExecutor(
  client: RuntimeClient,
  options: AcceptedStructuredOutputExecutorOptions = {}
) {
  const executeSnapshot = createAcceptedStructuredOutputSnapshotExecutor(
    client,
    options
  );
  return async (
    role: ProviderAdmissionRole,
    request: ProviderStructuredOutputRequest,
    executionOptions: ProviderStructuredOutputOptions = {}
  ): Promise<Record<string, unknown>> => {
    const snapshot = normalizeProviderExecutionSnapshot(role.snapshot);
    const authority = role.authority;
    if (
      role.modelConfiguration.capabilities.structuredOutput !== true ||
      !supportsStructuredOutputAdapter(role.modelConfiguration.adapterKind) ||
      snapshot.model.adapterKind !== role.modelConfiguration.adapterKind ||
      !authority ||
      authority.connectionId !== snapshot.connectionId ||
      authority.providerModelId !== snapshot.providerModelId ||
      authority.credentialId !== snapshot.credentialId ||
      authority.credentialVersionId !== snapshot.credentialVersionId
    ) {
      throw new Error("structured_output_not_supported");
    }
    return executeSnapshot(snapshot, request, executionOptions);
  };
}
