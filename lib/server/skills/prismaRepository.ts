import { Prisma, type PrismaClient } from "@prisma/client";
import type { SkillDraft } from "../../contracts/skills";
import type {
  SkillRunMaterialization,
  SkillRunResolver
} from "./runMaterialization";

export type SkillRevisionRow = {
  createdAt: Date;
  description: string;
  id: string;
  instructions: string;
  name: string;
  revisionNumber: number;
  skillId: string;
};

export type SkillAccessEntry = {
  archived: boolean;
  id: string;
  installationScope: boolean;
  memberGroupNames: string[];
  owned: boolean;
  ownerDisplayName: string;
  revision: SkillRevisionRow;
  updatedAt: Date;
  version: number;
};

export type SkillWriteResult =
  | { kind: "ok"; skillId: string }
  | { kind: "archived" | "not_found" | "version_conflict" };

export type SkillPublicationResult =
  | { id: string; kind: "ok" }
  | { kind: "forbidden" | "invalid" | "not_found" };

function revisionRow(revision: {
  createdAt: Date;
  description: string;
  id: string;
  instructions: string;
  name: string;
  revisionNumber: number;
  skillId: string;
}): SkillRevisionRow {
  return { ...revision };
}

export function createPrismaSkillRepository(client: PrismaClient) {
  async function listForUser(userId: string): Promise<SkillAccessEntry[]> {
    const definitions = await client.skillDefinition.findMany({
      include: {
        currentRevision: true,
        owner: { select: { displayName: true } },
        publications: {
          include: {
            group: { select: { name: true } },
            revision: true
          },
          where: {
            OR: [
              { scope: "installation" },
              {
                group: {
                  archivedAt: null,
                  users: { some: { userId } }
                },
                scope: "group"
              }
            ]
          }
        }
      },
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
                  {
                    group: {
                      archivedAt: null,
                      users: { some: { userId } }
                    },
                    scope: "group"
                  }
                ]
              }
            }
          }
        ]
      }
    });

    return definitions.flatMap((definition) => {
      const owned = definition.ownerUserId === userId;
      const publications = [...definition.publications].sort((left, right) =>
        right.revision.revisionNumber - left.revision.revisionNumber ||
        left.id.localeCompare(right.id)
      );
      const revision = owned ? definition.currentRevision : publications[0]?.revision;
      if (!revision) return [];
      return [{
        archived: definition.archivedAt !== null,
        id: definition.id,
        installationScope: publications.some((publication) =>
          publication.scope === "installation"),
        memberGroupNames: publications.flatMap((publication) =>
          publication.scope === "group" && publication.group
            ? [publication.group.name]
            : []),
        owned,
        ownerDisplayName: definition.owner.displayName,
        revision: revisionRow(revision),
        updatedAt: definition.updatedAt,
        version: definition.version
      }];
    });
  }

  const repository = {
    async create(userId: string, draft: SkillDraft): Promise<string> {
      return client.$transaction(async (tx) => {
        const definition = await tx.skillDefinition.create({
          data: { ownerUserId: userId }
        });
        const revision = await tx.skillRevision.create({
          data: {
            authorUserId: userId,
            ...draft,
            revisionNumber: 1,
            skillId: definition.id
          }
        });
        await tx.skillDefinition.update({
          data: { currentRevisionId: revision.id },
          where: { id: definition.id }
        });
        return definition.id;
      });
    },

    listForUser,

    async listPublishableGroups(userId: string): Promise<Array<{ id: string; name: string }>> {
      const memberships = await client.userGroup.findMany({
        select: { group: { select: { id: true, name: true } } },
        where: { group: { archivedAt: null }, userId }
      });
      return memberships.map((membership) => membership.group)
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async publish(input: {
      actorIsAdmin: boolean;
      groupId: string | null;
      scope: "group" | "installation";
      skillId: string;
      userId: string;
    }): Promise<SkillPublicationResult> {
      return client.$transaction(async (tx) => {
        const [skill] = await tx.$queryRaw<Array<{
          archivedAt: Date | null;
          currentRevisionId: string | null;
        }>>`
          SELECT "archivedAt", "currentRevisionId"
          FROM "SkillDefinition"
          WHERE "id" = ${input.skillId}
            AND "ownerUserId" = ${input.userId}
          FOR UPDATE
        `;
        if (!skill) return { kind: "not_found" as const };
        if (skill.archivedAt || !skill.currentRevisionId) return { kind: "invalid" as const };
        if (input.scope === "installation" && !input.actorIsAdmin) {
          return { kind: "forbidden" as const };
        }
        if (input.scope === "group") {
          if (!input.groupId) return { kind: "invalid" as const };
          const memberships = await tx.$queryRaw<Array<{ groupId: string }>>`
            SELECT membership."groupId"
            FROM "UserGroup" AS membership
            INNER JOIN "Group" AS member_group
              ON member_group."id" = membership."groupId"
            WHERE membership."groupId" = ${input.groupId}
              AND membership."userId" = ${input.userId}
              AND member_group."archivedAt" IS NULL
            FOR SHARE OF membership, member_group
          `;
          if (!memberships[0]) return { kind: "forbidden" as const };
          const publication = await tx.skillPublication.upsert({
            create: {
              groupId: input.groupId,
              publishedByUserId: input.userId,
              revisionId: skill.currentRevisionId,
              scope: "group",
              skillId: input.skillId
            },
            update: {
              publishedByUserId: input.userId,
              revisionId: skill.currentRevisionId
            },
            where: {
              skillId_groupId: { groupId: input.groupId, skillId: input.skillId }
            }
          });
          return { id: publication.id, kind: "ok" as const };
        }
        const existing = await tx.skillPublication.findFirst({
          select: { id: true },
          where: { scope: "installation", skillId: input.skillId }
        });
        const publication = existing
          ? await tx.skillPublication.update({
              data: {
                publishedByUserId: input.userId,
                revisionId: skill.currentRevisionId
              },
              where: { id: existing.id }
            })
          : await tx.skillPublication.create({
              data: {
                publishedByUserId: input.userId,
                revisionId: skill.currentRevisionId,
                scope: "installation",
                skillId: input.skillId
              }
            });
        return { id: publication.id, kind: "ok" as const };
      });
    },

    async resolveForRun(userId: string, skillIds: readonly string[]) {
      const entries = await listForUser(userId);
      const available = new Map(
        entries.filter((entry) => !entry.archived).map((entry) => [entry.id, entry] as const)
      );
      const skills: SkillRunMaterialization[] = [];
      for (const skillId of skillIds) {
        const entry = available.get(skillId);
        if (!entry) return { code: "skill_not_available" as const, ok: false as const, status: 404 as const };
        skills.push({
          instructions: entry.revision.instructions,
          name: entry.revision.name,
          revisionId: entry.revision.id,
          skillId: entry.id
        });
      }
      return { ok: true as const, skills };
    },

    async revise(
      userId: string,
      skillId: string,
      expectedVersion: number,
      draft: SkillDraft
    ): Promise<SkillWriteResult> {
      return client.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{
          archivedAt: Date | null;
          ownerUserId: string;
          version: number;
        }>>`
          SELECT "archivedAt", "ownerUserId", "version"
          FROM "SkillDefinition"
          WHERE "id" = ${skillId}
          FOR UPDATE
        `;
        if (!locked || locked.ownerUserId !== userId) return { kind: "not_found" as const };
        if (locked.archivedAt) return { kind: "archived" as const };
        if (locked.version !== expectedVersion) return { kind: "version_conflict" as const };
        const latest = await tx.skillRevision.aggregate({
          _max: { revisionNumber: true },
          where: { skillId }
        });
        const revision = await tx.skillRevision.create({
          data: {
            authorUserId: userId,
            ...draft,
            revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
            skillId
          }
        });
        await tx.skillDefinition.update({
          data: { currentRevisionId: revision.id, version: { increment: 1 } },
          where: { id: skillId }
        });
        return { kind: "ok" as const, skillId };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async revokePublication(input: {
      actorIsAdmin: boolean;
      publicationId: string;
      skillId: string;
      userId: string;
    }): Promise<"not_found" | "ok"> {
      return client.$transaction(async (tx) => {
        const publication = await tx.skillPublication.findFirst({
          select: { id: true, skill: { select: { ownerUserId: true } } },
          where: { id: input.publicationId, skillId: input.skillId }
        });
        if (!publication ||
          (!input.actorIsAdmin && publication.skill.ownerUserId !== input.userId)) {
          return "not_found" as const;
        }
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "SkillDefinition"
          WHERE "id" = ${input.skillId}
          FOR UPDATE
        `;
        const deleted = await tx.skillPublication.deleteMany({
          where: { id: publication.id, skillId: input.skillId }
        });
        return deleted.count === 1 ? "ok" as const : "not_found" as const;
      });
    },

    async setArchived(
      userId: string,
      skillId: string,
      expectedVersion: number,
      archived: boolean
    ): Promise<SkillWriteResult> {
      const updated = await client.skillDefinition.updateMany({
        data: {
          archivedAt: archived ? new Date() : null,
          version: { increment: 1 }
        },
        where: { id: skillId, ownerUserId: userId, version: expectedVersion }
      });
      if (updated.count === 1) return { kind: "ok", skillId };
      const exists = await client.skillDefinition.findFirst({
        select: { version: true },
        where: { id: skillId, ownerUserId: userId }
      });
      return exists ? { kind: "version_conflict" } : { kind: "not_found" };
    }
  };

  return repository satisfies SkillRunResolver & typeof repository;
}

export type PrismaSkillRepository = ReturnType<typeof createPrismaSkillRepository>;
