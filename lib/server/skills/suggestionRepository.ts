import type { PrismaClient } from "@prisma/client";
import type { SkillSuggestionRequest } from "../../contracts/skillSuggestions";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { resolveChatAccess, resolveProjectAccess } from "../projects/access";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { skillAccessWhere } from "./prismaRepository";
import type { SkillSuggestionCandidate } from "./suggestionPolicy";

export type SkillSuggestionContext = Readonly<{
  candidates: readonly SkillSuggestionCandidate[];
  context: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
}>;
export type SkillSuggestionContextLoader = (userId: string, input: SkillSuggestionRequest) => Promise<SkillSuggestionContext | null>;

export function createSkillSuggestionContextLoader(db: PrismaClient): SkillSuggestionContextLoader {
  const conversations = createPrismaRunRepository(db);
  return async (userId, input) => {
    if (!await db.user.findFirst({ where: { id: userId, status: "active" }, select: { id: true } })) return null;
    let context: SkillSuggestionContext["context"] = [];
    if (input.chatId) {
      const access = await resolveChatAccess(db, { userId, chatId: input.chatId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR" });
      if (!access || (access.project?.projectId ?? null) !== input.projectId) return null;
      const messages = await conversations.loadConversationContextForExpectedLeaf(input.chatId, userId, input.expectedActiveLeafMessageId);
      if (messages === null) return null;
      context = messages.filter(message => !message.purpose).map(message => ({ role: message.role, text: textFromContentBlocks(message.content) }));
    } else if (input.projectId && !await resolveProjectAccess(db, {
      userId, projectId: input.projectId, requireActive: true, minimumRole: "CONTRIBUTOR"
    })) return null;
    // Project recommendations use only that Project's shared catalog. A
    // personal library is never a fallback for a missing/revoked Project.
    const rows = await db.skillDefinition.findMany({ where: {
      AND: [{ archivedAt: null, deletedAt: null, currentRevisionId: { not: null } },
        input.projectId ? { projectBindings: { some: { projectId: input.projectId } } } : skillAccessWhere(userId)]
    }, orderBy: { id: "asc" }, select: { id: true, currentRevision: { select: { id: true, name: true, description: true } } } });
    return { context, candidates: rows.flatMap(row => row.currentRevision ? [{ id: row.id,
      revisionId: row.currentRevision.id, name: row.currentRevision.name, description: row.currentRevision.description }] : []) };
  };
}
