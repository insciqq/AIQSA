import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  KnowledgeBaseCreateInput,
  KnowledgeBaseUpdateInput,
  KnowledgeEmbeddingDeployment
} from "../../contracts/knowledge";
import { canAccessModel } from "../auth/entitlements";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { prisma } from "../prisma";
import { normalizeProviderModelConfiguration } from "../providers/providerConfiguration";
import {
  KNOWLEDGE_CHUNKING_PROFILE_VERSION,
  createKnowledgeVectorSpacePin,
  type KnowledgeVectorSpacePin
} from "./indexProfile";

export type KnowledgeBasePublicationRow = Readonly<{
  groupId: string | null;
  groupName: string | null;
  id: string;
  scope: "group" | "installation";
  updatedAt: Date;
}>;

export type KnowledgeBaseAccessEntry = Readonly<{
  activeGeneration: Readonly<{
    chunkingProfileVersion: number;
    embeddingDeployment: Omit<KnowledgeEmbeddingDeployment, "indexSupported">;
    id: string;
    indexedContentRevision: number;
    vectorSpaceFingerprint: string;
  }>;
  archived: boolean;
  contentRevision: number;
  description: string;
  id: string;
  installationScope: boolean;
  memberGroupNames: string[];
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  published: boolean;
  updatedAt: Date;
  version: number;
}>;

export type KnowledgeBaseDetailData = KnowledgeBaseAccessEntry & Readonly<{
  documentCount: number;
  publications: KnowledgeBasePublicationRow[] | null;
}>;

export type KnowledgeBaseCreateResult =
  | Readonly<{ id: string; kind: "ok" }>
  | Readonly<{ kind: "embedding_dimension_not_supported" }>
  | Readonly<{ kind: "embedding_not_available" }>;

export type KnowledgeBaseWriteResult =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "version_conflict" }>;

export type KnowledgeBasePublishResult =
  | Readonly<{ kind: "archived" }>
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "ok"; publication: KnowledgeBasePublicationRow }>;

export type KnowledgeBaseRevokeResult =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "ok" }>;

export type KnowledgeEmbeddingDeploymentResolution = Readonly<{
  public: KnowledgeEmbeddingDeployment;
  pin: KnowledgeVectorSpacePin;
}>;

const baseInclude = {
  _count: { select: { documents: true } },
  activeIndexGeneration: {
    include: {
      embeddingProviderModel: {
        include: { connection: { select: { displayName: true } } }
      }
    }
  },
  owner: { select: { displayName: true } },
  publications: {
    include: { group: { select: { archivedAt: true, name: true } } }
  }
} satisfies Prisma.KnowledgeBaseInclude;

type BaseRecord = Prisma.KnowledgeBaseGetPayload<{ include: typeof baseInclude }>;

function publicationRow(record: BaseRecord["publications"][number]): KnowledgeBasePublicationRow {
  return {
    groupId: record.groupId,
    groupName: record.group?.name ?? null,
    id: record.id,
    scope: record.scope,
    updatedAt: record.updatedAt
  };
}

function accessEntry(
  record: BaseRecord,
  userId: string,
  memberGroupIds: ReadonlySet<string>
): KnowledgeBaseAccessEntry {
  const generation = record.activeIndexGeneration;
  if (!generation) throw new Error("knowledge_base_active_generation_missing");
  const owned = record.ownerUserId === userId;
  const accessiblePublications = record.publications.filter(
    (publication) => publication.scope === "installation" || (
      publication.groupId !== null &&
      publication.group?.archivedAt === null &&
      memberGroupIds.has(publication.groupId)
    )
  );
  return {
    activeGeneration: {
      chunkingProfileVersion: generation.chunkingProfileVersion,
      embeddingDeployment: {
        connectionDisplayName: generation.embeddingProviderModel.connection.displayName,
        id: generation.embeddingProviderModelId,
        modelDisplayName: generation.embeddingProviderModel.displayName,
        provider: generation.embeddingProviderModel.provider,
        targetDimension: generation.targetDimension
      },
      id: generation.id,
      indexedContentRevision: generation.indexedContentRevision,
      vectorSpaceFingerprint: generation.vectorSpaceFingerprint.trim()
    },
    archived: record.archivedAt !== null,
    contentRevision: record.contentRevision,
    description: record.description,
    id: record.id,
    installationScope: accessiblePublications.some(
      (publication) => publication.scope === "installation"
    ),
    memberGroupNames: accessiblePublications
      .filter((publication) => publication.scope === "group")
      .map((publication) => publication.group?.name ?? "")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
    name: record.name,
    owned,
    ownerDisplayName: record.owner.displayName,
    published: record.publications.length > 0,
    updatedAt: record.updatedAt,
    version: record.version
  };
}

async function activeMemberGroupIds(
  client: Pick<PrismaClient, "userGroup">,
  userId: string
): Promise<string[]> {
  const memberships = await client.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId }
  });
  return memberships.map((membership) => membership.groupId);
}

export async function resolveKnowledgeEmbeddingDeployments(
  client: Pick<PrismaClient, "accessGrant" | "providerModel" | "userGroup">,
  userId: string
): Promise<KnowledgeEmbeddingDeploymentResolution[]> {
  const [entitlements, models] = await Promise.all([
    loadEntitlementsForUser(userId, client),
    client.providerModel.findMany({
      include: { connection: { select: { displayName: true } } },
      orderBy: [
        { connection: { displayName: "asc" } },
        { displayName: "asc" },
        { id: "asc" }
      ],
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        connection: {
          activeConfig: { not: Prisma.DbNull },
          activeVersion: { gt: 0 },
          enabled: true
        },
        enabled: true,
        modelClass: "embedding"
      }
    })
  ]);
  const resolved: KnowledgeEmbeddingDeploymentResolution[] = [];
  for (const model of models) {
    if (!canAccessModel(entitlements, model.connectionId, model.id) || model.activeConfig === null) {
      continue;
    }
    try {
      const configuration = normalizeProviderModelConfiguration(model.activeConfig);
      const pin = createKnowledgeVectorSpacePin({ configuration, deploymentId: model.id });
      if (!pin) continue;
      resolved.push({
        pin,
        public: {
          connectionDisplayName: model.connection.displayName,
          id: model.id,
          indexSupported: pin.indexSupported,
          modelDisplayName: model.displayName,
          provider: model.provider,
          targetDimension: pin.targetDimension
        }
      });
    } catch {
      // A malformed persisted active configuration is unavailable, not client data.
    }
  }
  return resolved;
}

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export function createPrismaKnowledgeRepository(client: PrismaClient = prisma) {
  async function memberGroups(userId: string): Promise<Set<string>> {
    return new Set(await activeMemberGroupIds(client, userId));
  }

  const repository = {
    async create(userId: string, input: KnowledgeBaseCreateInput): Promise<KnowledgeBaseCreateResult> {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await client.$transaction(async (tx) => {
            const deployment = (await resolveKnowledgeEmbeddingDeployments(tx, userId)).find(
              (candidate) => candidate.public.id === input.embeddingDeploymentId
            );
            if (!deployment) return { kind: "embedding_not_available" } as const;
            if (!deployment.pin.indexSupported) {
              return { kind: "embedding_dimension_not_supported" } as const;
            }
            const base = await tx.knowledgeBase.create({
              data: {
                description: input.description,
                name: input.name,
                ownerUserId: userId
              },
              select: { id: true }
            });
            const now = new Date();
            const generation = await tx.knowledgeIndexGeneration.create({
              data: {
                activatedAt: now,
                chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
                embeddingConfiguration: deployment.pin.configuration as unknown as Prisma.InputJsonValue,
                embeddingProviderModelId: deployment.public.id,
                indexedContentRevision: 0,
                knowledgeBaseId: base.id,
                readyAt: now,
                status: "active",
                targetDimension: deployment.pin.targetDimension,
                vectorSpaceFingerprint: deployment.pin.fingerprint
              },
              select: { id: true }
            });
            await tx.knowledgeBase.update({
              data: { activeIndexGenerationId: generation.id },
              where: { id: base.id }
            });
            return { id: base.id, kind: "ok" } as const;
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
          if (attempt < 2 && isSerializationConflict(error)) continue;
          throw error;
        }
      }
      throw new Error("knowledge_base_create_retry_exhausted");
    },

    async getDetail(userId: string, knowledgeBaseId: string): Promise<KnowledgeBaseDetailData | null> {
      const groups = await memberGroups(userId);
      const record = await client.knowledgeBase.findFirst({
        include: baseInclude,
        where: {
          id: knowledgeBaseId,
          OR: [
            { ownerUserId: userId },
            {
              archivedAt: null,
              publications: {
                some: {
                  OR: [
                    { scope: "installation" },
                    ...(groups.size > 0
                      ? [{ groupId: { in: [...groups] }, group: { archivedAt: null }, scope: "group" as const }]
                      : [])
                  ]
                }
              }
            }
          ]
        }
      });
      if (!record) return null;
      const entry = accessEntry(record, userId, groups);
      return {
        ...entry,
        documentCount: record._count.documents,
        publications: entry.owned
          ? record.publications.map(publicationRow).sort((left, right) =>
              left.scope.localeCompare(right.scope) ||
              (left.groupName ?? "").localeCompare(right.groupName ?? "")
            )
          : null
      };
    },

    async listEmbeddingDeployments(userId: string): Promise<KnowledgeEmbeddingDeployment[]> {
      return (await resolveKnowledgeEmbeddingDeployments(client, userId)).map((deployment) => deployment.public);
    },

    async listForUser(userId: string): Promise<KnowledgeBaseAccessEntry[]> {
      const groups = await memberGroups(userId);
      const records = await client.knowledgeBase.findMany({
        include: baseInclude,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        where: {
          OR: [
            { ownerUserId: userId },
            {
              archivedAt: null,
              publications: {
                some: {
                  OR: [
                    { scope: "installation" },
                    ...(groups.size > 0
                      ? [{ groupId: { in: [...groups] }, group: { archivedAt: null }, scope: "group" as const }]
                      : [])
                  ]
                }
              }
            }
          ]
        }
      });
      return records.map((record) => accessEntry(record, userId, groups));
    },

    async listPublishableGroups(userId: string): Promise<Array<{ id: string; name: string }>> {
      const memberships = await client.userGroup.findMany({
        orderBy: { group: { name: "asc" } },
        select: { group: { select: { id: true, name: true } } },
        where: { group: { archivedAt: null }, userId }
      });
      return memberships.map((membership) => membership.group);
    },

    async listVisibleDocumentVersions(
      knowledgeBaseId: string,
      contentRevision: number
    ): Promise<Array<{ documentId: string; id: string; versionNumber: number }>> {
      if (!Number.isSafeInteger(contentRevision) || contentRevision < 1) return [];
      return client.knowledgeDocumentVersion.findMany({
        orderBy: [{ documentId: "asc" }, { versionNumber: "asc" }],
        select: { documentId: true, id: true, versionNumber: true },
        where: {
          knowledgeBaseId,
          visibleFromRevision: { lte: contentRevision },
          OR: [
            { visibleUntilRevision: null },
            { visibleUntilRevision: { gt: contentRevision } }
          ]
        }
      });
    },

    async publish(input: Readonly<{
      actorIsAdmin: boolean;
      groupId: string | null;
      knowledgeBaseId: string;
      scope: "group" | "installation";
      userId: string;
    }>): Promise<KnowledgeBasePublishResult> {
      return client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ archivedAt: Date | null; ownerUserId: string }>>`
          SELECT "ownerUserId", "archivedAt"
          FROM "KnowledgeBase"
          WHERE "id" = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const base = locked[0];
        if (!base || base.ownerUserId !== input.userId) return { kind: "not_found" };
        if (base.archivedAt) return { kind: "archived" };

        if (input.scope === "installation") {
          if (!input.actorIsAdmin || input.groupId !== null) return { kind: "forbidden" };
        } else {
          if (!input.groupId) return { kind: "forbidden" };
          const memberships = await tx.$queryRaw<Array<{ groupId: string }>>`
            SELECT membership."groupId"
            FROM "UserGroup" AS membership
            INNER JOIN "Group" AS member_group
              ON member_group."id" = membership."groupId"
            WHERE membership."userId" = ${input.userId}
              AND membership."groupId" = ${input.groupId}
              AND member_group."archivedAt" IS NULL
            FOR SHARE OF membership, member_group
          `;
          if (!memberships[0]) return { kind: "forbidden" };
        }

        const existing = await tx.knowledgeBasePublication.findFirst({
          where: input.scope === "installation"
            ? { knowledgeBaseId: input.knowledgeBaseId, scope: "installation" }
            : {
                groupId: input.groupId,
                knowledgeBaseId: input.knowledgeBaseId,
                scope: "group"
              }
        });
        const publication = existing
          ? await tx.knowledgeBasePublication.update({
              data: { publishedByUserId: input.userId },
              include: { group: { select: { name: true } } },
              where: { id: existing.id }
            })
          : await tx.knowledgeBasePublication.create({
              data: {
                groupId: input.groupId,
                knowledgeBaseId: input.knowledgeBaseId,
                publishedByUserId: input.userId,
                scope: input.scope
              },
              include: { group: { select: { name: true } } }
            });
        return {
          kind: "ok",
          publication: {
            groupId: publication.groupId,
            groupName: publication.group?.name ?? null,
            id: publication.id,
            scope: publication.scope,
            updatedAt: publication.updatedAt
          }
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async revokePublication(input: Readonly<{
      actorIsAdmin: boolean;
      knowledgeBaseId: string;
      publicationId: string;
      userId: string;
    }>): Promise<KnowledgeBaseRevokeResult> {
      return client.$transaction(async (tx) => {
        const publication = await tx.knowledgeBasePublication.findFirst({
          include: { knowledgeBase: { select: { ownerUserId: true } } },
          where: { id: input.publicationId, knowledgeBaseId: input.knowledgeBaseId }
        });
        if (
          !publication ||
          (!input.actorIsAdmin && publication.knowledgeBase.ownerUserId !== input.userId)
        ) {
          return { kind: "not_found" };
        }
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "KnowledgeBase"
          WHERE "id" = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const deleted = await tx.knowledgeBasePublication.deleteMany({
          where: { id: publication.id, knowledgeBaseId: input.knowledgeBaseId }
        });
        return deleted.count === 1 ? { kind: "ok" } : { kind: "not_found" };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async update(
      userId: string,
      knowledgeBaseId: string,
      input: KnowledgeBaseUpdateInput
    ): Promise<KnowledgeBaseWriteResult> {
      const data: Prisma.KnowledgeBaseUpdateManyMutationInput = {
        ...(input.archived === undefined
          ? {}
          : { archivedAt: input.archived ? new Date() : null }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.name === undefined ? {} : { name: input.name }),
        version: { increment: 1 }
      };
      const updated = await client.knowledgeBase.updateMany({
        data,
        where: {
          id: knowledgeBaseId,
          ownerUserId: userId,
          version: input.expectedVersion
        }
      });
      if (updated.count === 1) return { kind: "ok" };
      const exists = await client.knowledgeBase.count({
        where: { id: knowledgeBaseId, ownerUserId: userId }
      });
      return exists ? { kind: "version_conflict" } : { kind: "not_found" };
    }
  };

  return repository;
}

export type PrismaKnowledgeRepository = ReturnType<typeof createPrismaKnowledgeRepository>;
