import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveProviderCredential } from "../../domain/providerCredentialResolution";
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "../auth/fullAccessGroup";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import {
  createOpenAICompatibleEmbeddingAdapter,
  type EmbeddingAdapter
} from "../providers/embeddings";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  providerAuthenticationMode,
  type ProviderModelConfiguration
} from "../providers/providerConfiguration";
import { createProviderSafeFetch } from "../providers/providerSafeFetch";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../providers/runtimeFactory";
import { ProviderAdmissionError } from "./admission";

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

export type EmbeddingRuntimeStore = Pick<
  PrismaClient,
  | "accessGrant"
  | "providerCredentialVersion"
  | "providerGroupCredentialAssignment"
  | "providerModel"
  | "providerModelCredentialCheck"
  | "providerUserCredentialAssignment"
  | "user"
  | "userGroup"
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
    createFetch?: (configuration: ReturnType<typeof normalizeProviderConnectionConfiguration>) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
) {
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;

  return {
    async resolveForUser(input: Readonly<{
      providerModelId: string;
      userId: string;
    }>): Promise<EmbeddingRuntimeBinding> {
      const [user, memberships, model] = await Promise.all([
        prisma.user.findFirst({
          select: { id: true },
          where: { id: input.userId, status: "active" }
        }),
        prisma.userGroup.findMany({
          select: { group: { select: { systemRole: true } }, groupId: true },
          where: { group: { archivedAt: null }, userId: input.userId }
        }),
        prisma.providerModel.findFirst({
          include: {
            connection: {
              include: {
                credentials: {
                  include: {
                    activeVersion: {
                      select: { id: true, revokedAt: true }
                    }
                  }
                }
              }
            }
          },
          where: {
            activeConfig: { not: Prisma.DbNull },
            activeVersion: { gt: 0 },
            connection: {
              activeConfig: { not: Prisma.DbNull },
              activeVersion: { gt: 0 },
              enabled: true
            },
            enabled: true,
            id: input.providerModelId,
            modelClass: "embedding"
          }
        })
      ]);
      if (!user) throw new ProviderAdmissionError("user_not_available");
      if (!model) throw new ProviderAdmissionError("model_not_available");

      const groupIds = memberships.map(({ groupId }) => groupId);
      const fullAccess = memberships.some(
        ({ group }) => group.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
      );
      if (!fullAccess) {
        const grantCount = await prisma.accessGrant.count({
          where: {
            AND: [{
              OR: [
                { providerModelId: model.id },
                { providerConnectionId: model.connectionId }
              ]
            }],
            enabled: true,
            OR: [
              { userId: input.userId },
              ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])
            ]
          }
        });
        if (grantCount === 0) throw new ProviderAdmissionError("model_not_available");
      }

      const connection = normalizeProviderConnectionConfiguration(model.connection.activeConfig);
      const configuration = normalizeProviderModelConfiguration(model.activeConfig);
      if (
        configuration.modelClass !== "embedding" ||
        !configuration.embedding ||
        configuration.embedding.providerFamily !== model.connection.family
      ) {
        throw new ProviderAdmissionError("model_not_available");
      }

      const [assignments, directAssignment] = await Promise.all([
        prisma.providerGroupCredentialAssignment.findMany({
          select: { credentialId: true, groupId: true },
          where: { connectionId: model.connectionId, groupId: { in: groupIds } }
        }),
        prisma.providerUserCredentialAssignment.findUnique({
          select: { credentialId: true },
          where: {
            connectionId_userId: {
              connectionId: model.connectionId,
              userId: input.userId
            }
          }
        })
      ]);
      const credential = resolveProviderCredential({
        assignments,
        credentials: model.connection.credentials.map((candidate) => ({
          activeVersion: candidate.activeVersion
            ? {
                id: candidate.activeVersion.id,
                revoked: candidate.activeVersion.revokedAt !== null
              }
            : null,
          enabled: candidate.enabled,
          id: candidate.id
        })),
        defaultCredentialId: model.connection.defaultCredentialId,
        directAssignmentCredentialId: directAssignment?.credentialId ?? null,
        memberships: groupIds.map((groupId) => ({ archived: false, groupId })),
        policy: model.connection.unassignedPolicy
      });
      if (!credential.ok) throw new ProviderAdmissionError(credential.code);

      const check = await prisma.providerModelCredentialCheck.findFirst({
        select: { id: true },
        where: {
          connectionId: model.connectionId,
          connectionVersion: model.connection.activeVersion,
          credentialId: credential.credentialId,
          credentialVersionId: credential.credentialVersionId,
          modelVersion: model.activeVersion,
          providerModelId: model.id,
          status: "available"
        }
      });
      if (!check) throw new ProviderAdmissionError("model_not_available");

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
      const executionSnapshot = normalizeProviderExecutionSnapshot({
        connection,
        connectionDisplayName: model.connection.displayName,
        connectionId: model.connectionId,
        credentialId: credential.credentialId,
        credentialVersionId: credential.credentialVersionId,
        model: configuration,
        modelDisplayName: model.displayName,
        providerFamily: model.connection.family,
        providerModelId: model.id,
        version: 1
      });

      return {
        adapter,
        configuration,
        connectionId: model.connectionId,
        connectionVersion: model.connection.activeVersion,
        credentialId: credential.credentialId,
        credentialSource: credential.source,
        credentialVersionId: credential.credentialVersionId,
        executionSnapshot,
        modelVersion: model.activeVersion,
        provider: model.provider,
        providerModelId: model.id
      };
    }
  };
}
