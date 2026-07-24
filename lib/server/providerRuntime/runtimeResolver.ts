import { Prisma, type PrismaClient } from "@prisma/client";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import {
  createProviderRuntimeBinding,
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot,
  type ProviderRuntimeBinding
} from "../providers/runtimeFactory";

export type ProviderRunBindingRole = "answer" | "search";

export type StoredProviderRunBinding = Readonly<{
  connectionId: string | null;
  credentialId: string | null;
  credentialVersionId: string | null;
  executionSnapshot: unknown;
  providerModelId: string | null;
}>;

export type LockedProviderCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
}>;

export type ProviderRuntimeStore = Readonly<{
  loadBinding(runId: string, role: ProviderRunBindingRole): Promise<StoredProviderRunBinding | null>;
  withLockedCredential<Value>(
    credentialId: string,
    credentialVersionId: string,
    consume: (version: LockedProviderCredentialVersion) => Value
  ): Promise<Value | null>;
}>;

export type ProviderRuntimeResolver = Readonly<{
  resolve(runId: string, role: ProviderRunBindingRole): Promise<ProviderRuntimeBinding>;
}>;

function assertBindingLineage(
  binding: StoredProviderRunBinding,
  snapshot: ProviderExecutionSnapshot
): void {
  if (
    binding.connectionId !== snapshot.connectionId ||
    binding.providerModelId !== snapshot.providerModelId ||
    binding.credentialId !== snapshot.credentialId ||
    binding.credentialVersionId !== snapshot.credentialVersionId
  ) {
    throw new Error("provider_run_binding_invalid");
  }
}

export function createProviderRuntimeResolver(input: Readonly<{
  allowFake: boolean;
  createFetch(snapshot: ProviderExecutionSnapshot): typeof fetch;
  encryptionKey?: () => Buffer;
  store: ProviderRuntimeStore;
}>): ProviderRuntimeResolver {
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;

  return {
    async resolve(runId, role) {
      const binding = await input.store.loadBinding(runId, role);
      if (!binding) {
        throw new Error("provider_run_binding_not_found");
      }
      const snapshot = normalizeProviderExecutionSnapshot(binding.executionSnapshot);
      assertBindingLineage(binding, snapshot);

      if (snapshot.model.adapterKind === "fake") {
        return createProviderRuntimeBinding({
          options: { allowFake: input.allowFake },
          secret: null,
          snapshot
        });
      }

      if (!snapshot.credentialId || !snapshot.credentialVersionId) {
        throw new Error("provider_run_binding_invalid");
      }
      const credentialId = snapshot.credentialId;
      const credentialVersionId = snapshot.credentialVersionId;

      const secret = async () => {
        const value = await input.store.withLockedCredential(
          credentialId,
          credentialVersionId,
          (version) => {
            if (
              version.id !== credentialVersionId ||
              version.credentialId !== credentialId ||
              version.revokedAt ||
              !version.secretEnvelope
            ) {
              throw new Error("credential_revoked");
            }

            return decryptProviderCredentialSecret({
              credentialId: version.credentialId,
              envelope: version.secretEnvelope,
              key: encryptionKey(),
              valueId: version.id
            });
          }
        );
        if (!value) {
          throw new Error("credential_revoked");
        }
        return value;
      };

      return createProviderRuntimeBinding({
        options: {
          allowFake: input.allowFake,
          fetchFn: input.createFetch(snapshot)
        },
        secret,
        snapshot
      });
    }
  };
}

type RuntimePrisma = Pick<PrismaClient, "$transaction" | "providerRunBinding">;

export function createPrismaProviderRuntimeStore(
  prisma: RuntimePrisma
): ProviderRuntimeStore {
  return {
    async loadBinding(runId, role) {
      return prisma.providerRunBinding.findUnique({
        select: {
          connectionId: true,
          credentialId: true,
          credentialVersionId: true,
          executionSnapshot: true,
          providerModelId: true
        },
        where: {
          modelRunId_role: {
            modelRunId: runId,
            role
          }
        }
      });
    },
    withLockedCredential(credentialId, credentialVersionId, consume) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedProviderCredentialVersion[]>(Prisma.sql`
          SELECT "credentialId", "id", "revokedAt", "secretEnvelope"
          FROM "ProviderCredentialVersion"
          WHERE "credentialId" = ${credentialId}
            AND "id" = ${credentialVersionId}
          FOR SHARE
        `);
        const version = rows[0];
        return version ? consume(version) : null;
      });
    }
  };
}
