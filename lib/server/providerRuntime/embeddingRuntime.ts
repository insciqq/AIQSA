import type { PrismaClient } from "@prisma/client";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import {
  createOpenAICompatibleEmbeddingAdapter,
  type EmbeddingAdapter
} from "../providers/embeddings";
import {
  providerAuthenticationMode,
  type ProviderConnectionConfiguration,
  type ProviderModelConfiguration
} from "../providers/providerConfiguration";
import { createProviderSafeFetch } from "../providers/providerSafeFetch";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import {
  loadEmbeddingProviderRole,
  loadProjectEmbeddingProviderRole,
  type AdmissionPrisma,
  type EmbeddingProviderAdmissionRole,
  ProviderAdmissionError
} from "./admission";

export type EmbeddingRuntimeBinding = Readonly<{
  adapter: EmbeddingAdapter;
  configuration: ProviderModelConfiguration;
  connectionId: string;
  connectionVersion: number;
  credentialId: string;
  credentialSource: "default" | "group" | "user";
  credentialVersionId: string;
  executionSnapshot: ProviderExecutionSnapshot;
  modelVersion: number;
  provider: string;
  providerModelId: string;
}>;

export type EmbeddingRuntimeStore = AdmissionPrisma & Pick<
  PrismaClient,
  "providerCredentialVersion"
>;

export type AcceptedEmbeddingRuntimeStore = Pick<PrismaClient, "providerCredentialVersion">;

export type AcceptedEmbeddingRuntimeEvidence = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  executionSnapshot: unknown;
  providerModelId: string;
}>;

export type AcceptedEmbeddingRuntimeBinding = Readonly<{
  adapter: EmbeddingAdapter;
  configuration: ProviderModelConfiguration;
  executionSnapshot: ProviderExecutionSnapshot;
  provider: string;
  providerModelId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noAuthEvidence(value: unknown): boolean {
  return isRecord(value) && value.authenticationMode === "none";
}

export function createPrismaEmbeddingRuntime(
  prisma: EmbeddingRuntimeStore,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
) {
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;

  const resolveAdmission = async (
    admitted: EmbeddingProviderAdmissionRole
  ): Promise<EmbeddingRuntimeBinding> => {
    const credential = admitted.authority;
    const connection = admitted.snapshot.connection;
    const configuration = admitted.configuration;

    const assertCredentialVersion = async (expectNoAuth: boolean): Promise<string | null> => {
      const version = await prisma.providerCredentialVersion.findFirst({
        select: { credentialId: true, id: true, revokedAt: true, secretEnvelope: true, testEvidence: true },
        where: { credentialId: credential.credentialId, id: credential.credentialVersionId }
      });
      if (
        !version || version.revokedAt ||
        version.credentialId !== credential.credentialId ||
        version.id !== credential.credentialVersionId ||
        expectNoAuth !== noAuthEvidence(version.testEvidence) ||
        expectNoAuth !== (version.secretEnvelope === null)
      ) throw new ProviderAdmissionError("credential_revoked");
      return version.secretEnvelope === null
        ? null
        : decryptProviderCredentialSecret({
            credentialId: version.credentialId,
            envelope: version.secretEnvelope,
            key: encryptionKey(),
            valueId: version.id
          });
    };
    const baseFetch = options.createFetch?.(connection) ?? createProviderSafeFetch({ configuration: connection });
    const authenticationMode = providerAuthenticationMode(connection);
    const fetchFn: typeof fetch = authenticationMode === "none"
      ? async (request, init) => {
          await assertCredentialVersion(true);
          return baseFetch(request, init);
        }
      : baseFetch;
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection,
      model: configuration,
      network: { fetchFn },
      secret: authenticationMode === "none"
        ? null
        : () => assertCredentialVersion(false).then((secret) => {
            if (secret === null) throw new ProviderAdmissionError("credential_revoked");
            return secret;
          })
    });
    return {
      adapter,
      configuration,
      connectionId: credential.connectionId,
      connectionVersion: credential.connectionVersion,
      credentialId: credential.credentialId,
      credentialSource: admitted.credentialSource,
      credentialVersionId: credential.credentialVersionId,
      executionSnapshot: admitted.snapshot,
      modelVersion: credential.modelVersion,
      provider: admitted.provider,
      providerModelId: credential.providerModelId
    };
  };

  return {
    async resolveForUser(input: Readonly<{
      providerModelId: string;
      userId: string;
    }>): Promise<EmbeddingRuntimeBinding> {
      return resolveAdmission(await loadEmbeddingProviderRole(prisma, input));
    },
    async resolveForProject(input: Readonly<{ providerModelId: string }>): Promise<EmbeddingRuntimeBinding> {
      return resolveAdmission(await loadProjectEmbeddingProviderRole(prisma, input));
    }
  };
}

/** Resolve an already accepted embedding snapshot without rejoining mutable
 * catalog/RBAC state. The exact credential version is still checked before
 * every external request so emergency revocation remains authoritative. */
export function createAcceptedEmbeddingRuntime(
  prisma: AcceptedEmbeddingRuntimeStore,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
) {
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;

  return {
    async resolve(
      evidence: AcceptedEmbeddingRuntimeEvidence
    ): Promise<AcceptedEmbeddingRuntimeBinding> {
      const snapshot = normalizeProviderExecutionSnapshot(evidence.executionSnapshot);
      if (
        snapshot.connectionId !== evidence.connectionId ||
        snapshot.providerModelId !== evidence.providerModelId ||
        snapshot.credentialId !== evidence.credentialId ||
        snapshot.credentialVersionId !== evidence.credentialVersionId ||
        snapshot.model.adapterKind === "fake" ||
        snapshot.model.modelClass !== "embedding" ||
        !snapshot.model.embedding
      ) {
        throw new ProviderAdmissionError("model_not_available");
      }
      const configuration = snapshot.model;
      const authenticationMode = providerAuthenticationMode(snapshot.connection);

      const assertCredentialVersion = async (expectNoAuth: boolean): Promise<string | null> => {
        const version = await prisma.providerCredentialVersion.findFirst({
          select: {
            credentialId: true,
            id: true,
            revokedAt: true,
            secretEnvelope: true,
            testEvidence: true
          },
          where: {
            credentialId: evidence.credentialId,
            id: evidence.credentialVersionId
          }
        });
        if (
          !version || version.revokedAt ||
          version.credentialId !== evidence.credentialId ||
          version.id !== evidence.credentialVersionId ||
          expectNoAuth !== noAuthEvidence(version.testEvidence) ||
          expectNoAuth !== (version.secretEnvelope === null)
        ) {
          throw new ProviderAdmissionError("credential_revoked");
        }
        return version.secretEnvelope === null
          ? null
          : decryptProviderCredentialSecret({
              credentialId: version.credentialId,
              envelope: version.secretEnvelope,
              key: encryptionKey(),
              valueId: version.id
            });
      };

      const baseFetch = options.createFetch?.(snapshot.connection) ?? createProviderSafeFetch({
        configuration: snapshot.connection
      });
      const fetchFn: typeof fetch = authenticationMode === "none"
        ? async (request, init) => {
            await assertCredentialVersion(true);
            return baseFetch(request, init);
          }
        : baseFetch;
      const adapter = createOpenAICompatibleEmbeddingAdapter({
        connection: snapshot.connection,
        model: configuration,
        network: { fetchFn },
        secret: authenticationMode === "none"
          ? null
          : () => assertCredentialVersion(false).then((secret) => {
              if (secret === null) throw new ProviderAdmissionError("credential_revoked");
              return secret;
            })
      });
      return {
        adapter,
        configuration,
        executionSnapshot: snapshot,
        provider: snapshot.providerFamily,
        providerModelId: evidence.providerModelId
      };
    }
  };
}
