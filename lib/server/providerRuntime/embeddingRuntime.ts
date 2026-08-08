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
import {
  loadEmbeddingProviderRole,
  type AdmissionPrisma,
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

  return {
    async resolveForUser(input: Readonly<{
      providerModelId: string;
      userId: string;
    }>): Promise<EmbeddingRuntimeBinding> {
      const admitted = await loadEmbeddingProviderRole(prisma, input);
      const credential = admitted.authority;
      const connection = admitted.snapshot.connection;
      const configuration = admitted.configuration;

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
            credentialId: credential.credentialId,
            id: credential.credentialVersionId
          }
        });
        if (
          !version ||
          version.revokedAt ||
          version.credentialId !== credential.credentialId ||
          version.id !== credential.credentialVersionId ||
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

      const baseFetch = options.createFetch?.(connection) ?? createProviderSafeFetch({
        configuration: connection
      });
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
    }
  };
}
