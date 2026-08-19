import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  KnowledgeBaseCreateInput,
  KnowledgeBaseUpdateInput,
  KnowledgeReadiness
} from "../../contracts/knowledge";
import { prisma } from "../prisma";
import { revokeOwnedProjectResourcePublication } from "../projects/prismaRepository";
import { resolveActiveKnowledgeProfile } from "./knowledgeProfile";
import { knowledgeTrashPurgeScheduledAt } from "./lifecyclePolicy";
import { knowledgeSupportReference } from "./supportReference";

export type KnowledgeBasePublicationRow = Readonly<{
  groupId: string | null;
  groupName: string | null;
  id: string;
  scope: "group" | "installation" | "project";
  updatedAt: Date;
}>;

export type KnowledgeBaseAccessEntry = Readonly<{
  archived: boolean;
  deletionPending: boolean;
  description: string;
  sourceCount: number;
  id: string;
  installationScope: boolean;
  memberGroupNames: string[];
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  purgeScheduledAt: Date | null;
  readiness: KnowledgeReadiness;
  trashed: boolean;
  trashedAt: Date | null;
  updatedAt: Date;
  version: number;
}>;

export type KnowledgeBaseDetailData = KnowledgeBaseAccessEntry & Readonly<{
  publications: KnowledgeBasePublicationRow[] | null;
}>;

export type KnowledgeBaseCreateResult =
  | Readonly<{ id: string; kind: "ok" }>
  | Readonly<{ kind: "profile_unavailable" }>;

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

const baseInclude = {
  activeIndexGeneration: { select: { id: true, profileRevisionId: true } },
  sourceMemberships: {
    select: {
      source: {
        select: {
          currentVersion: {
            select: {
              artifacts: {
                select: { errorCode: true, id: true, profileRevisionId: true, state: true }
              },
              id: true
            }
          },
          id: true,
          pendingVersion: {
            select: {
              artifacts: {
                select: { errorCode: true, id: true, profileRevisionId: true, state: true }
              },
              id: true
            }
          }
        }
      }
    },
    where: {
      removedAt: null,
      source: { deletionRequestedAt: null, trashedAt: null }
    }
  },
  owner: { select: { displayName: true } },
  publications: {
    include: { group: { select: { archivedAt: true, name: true } } }
  },
  projectBindings: { select: { createdAt: true, id: true } }
} satisfies Prisma.KnowledgeBaseInclude;

type BaseRecord = Prisma.KnowledgeBaseGetPayload<{ include: typeof baseInclude }>;

function readiness(record: BaseRecord): KnowledgeReadiness {
  const profileRevisionId = record.activeIndexGeneration?.profileRevisionId ?? null;
  const sourceStates = record.sourceMemberships.map(({ source }) => {
    const currentArtifact = source.currentVersion?.artifacts.find((artifact) =>
      artifact.profileRevisionId === profileRevisionId);
    if (currentArtifact?.state === "ready") {
      return { issue: null, state: "ready" as const };
    }
    if (currentArtifact?.state === "failed") {
      return {
        issue: `${source.id}:${source.currentVersion?.id ?? "missing"}:${
          currentArtifact.errorCode ?? "processing_failed"}`,
        state: "needs_attention" as const
      };
    }
    if (source.currentVersion) return { issue: null, state: "processing" as const };

    const pendingArtifact = source.pendingVersion?.artifacts.find((artifact) =>
      artifact.profileRevisionId === profileRevisionId);
    if (pendingArtifact?.state === "failed") {
      return {
        issue: `${source.id}:${source.pendingVersion?.id ?? "missing"}:${
          pendingArtifact.errorCode ?? "processing_failed"}`,
        state: "needs_attention" as const
      };
    }
    if (source.pendingVersion) return { issue: null, state: "processing" as const };
    return {
      issue: `${source.id}:missing-version`,
      state: "needs_attention" as const
    };
  });
  const readySources = sourceStates.filter(({ state }) => state === "ready").length;
  const processingSources = sourceStates.filter(({ state }) => state === "processing").length;
  const attentionStates = sourceStates.filter(({ state }) => state === "needs_attention");
  const attentionSources = attentionStates.length;
  const totalSources = sourceStates.length;
  const state: KnowledgeReadiness["state"] = record.trashedAt !== null
    ? "trashed"
    : record.archivedAt !== null
      ? "archived"
    : totalSources === 0
      ? "empty"
      : attentionSources > 0
        ? "needs_attention"
        : processingSources > 0
          ? "processing"
          : "ready";
  const issueParts = attentionStates.map(({ issue }) => issue ?? "processing_failed").sort();
  return {
    attentionSources,
    processingSources,
    readySources,
    state,
    supportReference: state === "needs_attention"
      ? knowledgeSupportReference("base", record.id, ...issueParts)
      : null,
    totalSources
  };
}

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
  const currentReadiness = readiness(record);
  return {
    archived: record.archivedAt !== null,
    deletionPending: record.deletionRequestedAt !== null,
    description: record.description,
    sourceCount: currentReadiness.totalSources,
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
    purgeScheduledAt: knowledgeTrashPurgeScheduledAt(record.trashedAt),
    readiness: currentReadiness,
    trashed: record.trashedAt !== null,
    trashedAt: record.trashedAt,
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
            const resolved = await resolveActiveKnowledgeProfile(tx, userId);
            if (resolved.kind !== "ok") return { kind: "profile_unavailable" } as const;
            const profile = resolved.profile;
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
                chunkingProfileVersion: profile.chunkingProfileVersion,
                embeddingConfiguration: profile.embeddingConfiguration as Prisma.InputJsonValue,
                embeddingProviderModelId: profile.embeddingProviderModelId,
                indexedContentRevision: 0,
                knowledgeBaseId: base.id,
                profileRevisionId: profile.revisionId,
                readyAt: now,
                status: "active",
                targetDimension: profile.pin.targetDimension,
                vectorSpaceFingerprint: profile.pin.fingerprint
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
          activeIndexGenerationId: { not: null },
          id: knowledgeBaseId,
          OR: [
            { ownerUserId: userId },
            {
              archivedAt: null,
              deletionRequestedAt: null,
              publications: {
                some: {
                  OR: [
                    { scope: "installation" },
                    ...(groups.size > 0
                      ? [{ groupId: { in: [...groups] }, group: { archivedAt: null }, scope: "group" as const }]
                      : [])
                  ]
                }
              },
              trashedAt: null
            }
          ]
        }
      });
      if (!record) return null;
      const entry = accessEntry(record, userId, groups);
      return {
        ...entry,
        publications: entry.owned
          ? [
              ...record.publications.map(publicationRow),
              ...record.projectBindings.map((binding) => ({
                groupId: null,
                groupName: null,
                id: `project:${binding.id}`,
                scope: "project" as const,
                updatedAt: binding.createdAt
              }))
            ].sort((left, right) =>
              left.scope.localeCompare(right.scope) ||
              (left.groupName ?? "").localeCompare(right.groupName ?? "")
            )
          : null
      };
    },

    async canCreate(userId: string): Promise<boolean> {
      return (await resolveActiveKnowledgeProfile(client, userId)).kind === "ok";
    },

    async listForUser(userId: string): Promise<KnowledgeBaseAccessEntry[]> {
      const groups = await memberGroups(userId);
      const records = await client.knowledgeBase.findMany({
        include: baseInclude,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        where: {
          activeIndexGenerationId: { not: null },
          OR: [
            { ownerUserId: userId },
            {
              archivedAt: null,
              deletionRequestedAt: null,
              publications: {
                some: {
                  OR: [
                    { scope: "installation" },
                    ...(groups.size > 0
                      ? [{ groupId: { in: [...groups] }, group: { archivedAt: null }, scope: "group" as const }]
                      : [])
                  ]
                }
              },
              trashedAt: null
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

    async publish(input: Readonly<{
      actorIsAdmin: boolean;
      groupId: string | null;
      knowledgeBaseId: string;
      scope: "group" | "installation";
      userId: string;
    }>): Promise<KnowledgeBasePublishResult> {
      return client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{
          archivedAt: Date | null;
          deletionRequestedAt: Date | null;
          ownerUserId: string;
          trashedAt: Date | null;
        }>>`
          SELECT "ownerUserId", "archivedAt", "trashedAt", "deletionRequestedAt"
          FROM "KnowledgeBase"
          WHERE "id" = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const base = locked[0];
        if (!base || base.ownerUserId !== input.userId) return { kind: "not_found" };
        if (base.archivedAt || base.trashedAt || base.deletionRequestedAt) {
          return { kind: "archived" };
        }

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
      if (input.publicationId.startsWith("project:")) {
        const bindingId = input.publicationId.slice("project:".length);
        if (!bindingId) return { kind: "not_found" };
        return await revokeOwnedProjectResourcePublication(client, {
          bindingId,
          resourceId: input.knowledgeBaseId,
          type: "knowledge",
          userId: input.userId
        }) ? { kind: "ok" } : { kind: "not_found" };
      }
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
          deletionRequestedAt: null,
          trashedAt: null,
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
