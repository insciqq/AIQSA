import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveChatAccess } from "../projects/access";
import { workspaceAncestorMessageIds, workspaceInboxAttachmentWhere } from "./inboxSelection";

export type WorkspaceInboxFacts = Readonly<{ hasFiles: boolean; hasEarlierExports: boolean }>;
export type WorkspaceInboxFactsInput = Readonly<{
  chatId: string; userId: string; projectId?: string; leafMessageId: string | null; imageIds: readonly string[];
}>;

/** Metadata-only existence checks; never open storage or start a guest. */
export async function loadWorkspaceInboxFacts(client: PrismaClient, input: WorkspaceInboxFactsInput): Promise<WorkspaceInboxFacts> {
  return client.$transaction(async tx => {
    const [chat, actor] = await Promise.all([
      tx.chat.findFirst({ where: { id: input.chatId, archived: false, permanentDeletionAt: null }, select: { id: true } }),
      tx.user.findFirst({ where: { id: input.userId, status: "active" }, select: { id: true } })
    ]);
    if (!chat || !actor) return { hasFiles: false, hasEarlierExports: false };
    const access = await resolveChatAccess(tx, { chatId: input.chatId, userId: input.userId,
      minimumProjectRole: "CONTRIBUTOR", requireMutable: true });
    if (!access || (access.kind === "project" ? access.project.projectId !== input.projectId : Boolean(input.projectId))) {
      return { hasFiles: false, hasEarlierExports: false };
    }
    const ancestorMessageIds = await workspaceAncestorMessageIds(tx, input.chatId, input.leafMessageId);
    const where = workspaceInboxAttachmentWhere({ ...input, ancestorMessageIds });
    const [file, previousExport] = await Promise.all([
      tx.attachment.findFirst({ where, select: { id: true } }),
      tx.attachment.findFirst({ where: { ...where, origin: "WORKSPACE_OUTPUT" }, select: { id: true } })
    ]);
    return { hasFiles: file !== null, hasEarlierExports: previousExport !== null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
