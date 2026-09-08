import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminCatalog, AdminGroupGrantChange } from "@/lib/contracts/admin";
import { loadAdminGrantableCatalog } from "./adminCatalogQueries";
import type { AdminRepository } from "./adminRepositoryContract";

type UserAccessCommands = Pick<AdminRepository, "setUserCredential" | "setUserGrants">;
type AccessFailure = "user_not_found" | "user_access_stale" | "user_grant_invalid";

class UserAccessRejected extends Error {
  constructor(readonly result: AccessFailure) { super(result); }
}

function staleTransaction(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

async function grantTarget(tx: Prisma.TransactionClient, userId: string, change: AdminGroupGrantChange, catalog: AdminCatalog | null) {
  const provider = change.provider ?? null;
  const providerModelId = change.modelId ?? null;
  const searchStrategy = change.searchStrategy ?? null;
  const where = {
    groupId: null,
    providerConnectionId: providerModelId ? null : provider,
    providerModelId,
    searchStrategy,
    userId
  };
  // Removing exact stored authority must remain possible after its target is
  // disabled or archived. It never grants authority or changes a group row.
  if (!change.enabled) {
    const existing = await tx.accessGrant.findFirst({
      select: { providerModel: { select: { connectionId: true } } },
      where
    });
    if (!existing || (providerModelId && existing.providerModel?.connectionId !== provider)) return null;
    return where;
  }
  if (searchStrategy) {
    if (searchStrategy === "search-disabled" || provider || providerModelId) return null;
    return catalog?.searchStrategies.some(({ strategyId }) => strategyId === searchStrategy) ? where : null;
  }
  if (!provider) return null;
  const available = providerModelId
    ? catalog?.models.some((model) => model.modelId === providerModelId && model.provider === provider)
    : catalog?.providers.some(({ id }) => id === provider);
  return available ? where : null;
}

export function createAdminUserAccessCommands(prisma: PrismaClient): UserAccessCommands {
  return {
    async setUserGrants(input) {
      try {
        return await prisma.$transaction(async (tx) => {
          const user = await tx.user.findUnique({ select: { status: true }, where: { id: input.userId } });
          if (!user) throw new UserAccessRejected("user_not_found");
          if (user.status !== "active" && input.changes.some((change) => change.enabled)) {
            throw new UserAccessRejected("user_grant_invalid");
          }
          const current = await tx.accessGrant.findMany({
            select: { id: true }, where: { groupId: null, userId: input.userId }
          });
          const actualIds = current.map(({ id }) => id).sort();
          const expectedIds = [...new Set(input.expectedGrantIds)].sort();
          if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) throw new UserAccessRejected("user_access_stale");
          const catalog = input.changes.some((change) => change.enabled) ? await loadAdminGrantableCatalog(tx) : null;
          for (const change of input.changes) {
            const where = await grantTarget(tx, input.userId, change, catalog);
            if (!where) throw new UserAccessRejected("user_grant_invalid");
            await tx.accessGrant.deleteMany({ where });
            if (change.enabled) await tx.accessGrant.create({ data: { ...where, enabled: true } });
          }
          return "applied" as const;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof UserAccessRejected) return error.result;
        if (staleTransaction(error)) return "user_access_stale";
        throw error;
      }
    },

    async setUserCredential(input) {
      try {
        return await prisma.$transaction(async (tx) => {
          const user = await tx.user.findUnique({ select: { status: true }, where: { id: input.userId } });
          if (!user) return "user_not_found" as const;
          const where = { connectionId: input.connectionId, userId: input.userId };
          const existing = await tx.providerUserCredentialAssignment.findUnique({
            select: { credentialId: true, updatedAt: true },
            where: { connectionId_userId: where }
          });
          if ((existing?.credentialId ?? null) !== input.expectedCredentialId ||
            (existing?.updatedAt.toISOString() ?? null) !== input.expectedUpdatedAt) return "user_access_stale" as const;
          if (input.credentialId === null) {
            await tx.providerUserCredentialAssignment.deleteMany({ where });
            return "applied" as const;
          }
          if (user.status !== "active") return "user_credential_invalid" as const;
          const credential = await tx.providerCredential.findFirst({
            select: { id: true },
            where: {
              activeVersion: { revokedAt: null },
              activeVersionId: { not: null },
              connection: { activeConfig: { not: Prisma.DbNull }, activeVersion: { gt: 0 }, enabled: true },
              connectionId: input.connectionId,
              enabled: true,
              id: input.credentialId
            }
          });
          if (!credential) return "user_credential_invalid" as const;
          await tx.providerUserCredentialAssignment.upsert({
            create: { ...where, credentialId: credential.id },
            update: { credentialId: credential.id },
            where: { connectionId_userId: where }
          });
          return "applied" as const;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (staleTransaction(error)) return "user_access_stale";
        throw error;
      }
    }
  };
}
