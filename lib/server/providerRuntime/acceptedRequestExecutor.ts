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
  ProviderRunOptions,
  ProviderRunRequest,
  ProviderRunResult
} from "../providers/types";
import { getSecretEncryptionKey } from "../secrets/envelope";

type LockedCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
  testEvidence: unknown;
}>;

type RuntimeClient = Pick<PrismaClient, "$transaction">;

type AcceptedRequestExecutorOptions = Readonly<{
  createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
  encryptionKey?: () => Buffer;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noAuthEvidence(value: unknown): boolean {
  return isRecord(value) && value.authenticationMode === "none";
}

/** Executes a bounded ordinary answer request against an immutable provider
 * snapshot. The exact credential version is checked again at every network
 * boundary, and no mutable model selection is consulted after admission. */
export function createAcceptedProviderRequestExecutor(
  client: RuntimeClient,
  options: AcceptedRequestExecutorOptions = {}
) {
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;
  return async (
    executionSnapshot: ProviderExecutionSnapshot,
    request: ProviderRunRequest,
    executionOptions: ProviderRunOptions = {}
  ): Promise<ProviderRunResult> => {
    const snapshot = normalizeProviderExecutionSnapshot(executionSnapshot);
    if (
      snapshot.model.adapterKind === "fake" ||
      snapshot.model.modelClass !== "answer" ||
      !snapshot.credentialId ||
      !snapshot.credentialVersionId ||
      request.modelId !== snapshot.model.upstreamModelId ||
      request.provider !== snapshot.providerFamily ||
      request.forceNonStreaming !== true ||
      request.toolMode !== "none" ||
      request.toolChoice !== "none" ||
      request.tools?.length
    ) {
      throw new Error("accepted_provider_request_invalid");
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
    const baseFetch = options.createFetch?.(snapshot.connection) ??
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
    const stream = runtime.adapter.stream(request, executionOptions);
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    return next.value;
  };
}
