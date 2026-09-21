import type { Prisma, PrismaClient } from "@prisma/client";
import type { SkillFileSummary } from "../../contracts/skills";
import { resolveProjectAccess } from "../projects/access";
import { skillAccessWhere } from "./prismaRepository";
import type { SkillRunCatalogEntry, SkillRunMaterialization } from "./runMaterialization";

const metadata = { id: true, name: true, description: true, fileCount: true, hasExecutables: true } satisfies Prisma.SkillRevisionSelect;
const files = { select: { path: true, byteSize: true, kind: true, executable: true }, orderBy: { path: "asc" as const } };

export function createSkillCatalogRepository(db: PrismaClient) {
  return {
    async loadedBeforeForMessages(userId: string, chatId: string, messageIds: readonly string[]): Promise<string[]> {
      if (!messageIds.length) return [];
      const rows = await db.modelRunSkillBinding.findMany({ where: { mode: "loaded",
        modelRun: { userId, chatId, assistantMessageId: { in: [...new Set(messageIds)] } }
      }, select: { skillId: true }, distinct: ["skillId"] });
      return rows.map(({ skillId }) => skillId).sort();
    },
    async listEnabledForRun(userId: string): Promise<SkillRunCatalogEntry[]> {
      const actor = await db.user.findFirst({ where: { id: userId, status: "active" }, select: { id: true } });
      if (!actor) return [];
      const rows = await db.skillDefinition.findMany({
        where: { AND: [
          { archivedAt: null, deletedAt: null, currentRevisionId: { not: null } }, skillAccessWhere(userId),
          { OR: [{ preferences: { some: { userId, enabled: true } } },
            { ownerUserId: userId, preferences: { none: { userId } } }] }
        ] },
        select: { id: true, ownerUserId: true, currentRevision: { select: metadata }, sharedRevision: { select: metadata } },
        orderBy: { id: "asc" }
      });
      return rows.flatMap((row) => {
        const revision = row.ownerUserId === userId ? row.currentRevision : row.sharedRevision;
        return revision ? [{ skillId: row.id, revisionId: revision.id, name: revision.name,
          description: revision.description || revision.name, fileCount: revision.fileCount,
          hasExecutables: revision.hasExecutables, loadedBefore: false }] : [];
      });
    },

    /** Approval can advance after admission. Authorize the live definition, then
     * read its exact frozen immutable revision without following either pointer. */
    async resolveFrozen(input: { userId: string; projectId?: string; skillId: string; revisionId: string }): Promise<(SkillRunMaterialization & { files: SkillFileSummary[] }) | null> {
      if (input.projectId) {
        if (!await resolveProjectAccess(db, { projectId: input.projectId, userId: input.userId, requireActive: true })) return null;
      } else if (!await db.user.findFirst({ where: { id: input.userId, status: "active" }, select: { id: true } })) return null;
      const revision = await db.skillRevision.findFirst({
        where: { id: input.revisionId, skillId: input.skillId, bundleReady: true, skill: { AND: [
          { deletedAt: null, archivedAt: null }, input.projectId
            ? { sharedRevisionId: { not: null }, projectBindings: { some: { projectId: input.projectId } } }
            : skillAccessWhere(input.userId)
        ] } },
        select: { ...metadata, skillId: true, instructions: true, files }
      });
      return revision ? { skillId: revision.skillId, revisionId: revision.id, name: revision.name,
        description: revision.description || revision.name, instructions: revision.instructions,
        fileCount: revision.fileCount, hasExecutables: revision.hasExecutables,
        files: revision.files.map((file) => ({ ...file, kind: file.kind === "text" ? "text" : "binary" })) } : null;
    }
  };
}
