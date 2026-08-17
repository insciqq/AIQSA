import type { Prisma, PrismaClient } from "@prisma/client";
import type { ProjectKnowledgeCitationWire } from "../../contracts/projects";
import { decodeKnowledgeRetrievedPassage } from "../knowledge/toolResult";
import { resolveProjectAccess } from "./access";

type ProjectCitationClient = PrismaClient | Prisma.TransactionClient;

export async function resolveProjectKnowledgeCitation(
  client: ProjectCitationClient,
  input: Readonly<{
    assistantMessageId: string;
    chatId: string;
    handle: string;
    projectId: string;
    userId: string;
  }>
): Promise<ProjectKnowledgeCitationWire | null> {
  if (
    !input.assistantMessageId || !input.chatId || !input.projectId || !input.userId ||
    !/^K[1-3]\.[1-8]$/u.test(input.handle)
  ) return null;

  const access = await resolveProjectAccess(client, {
    projectId: input.projectId,
    userId: input.userId
  });
  if (!access) return null;

  const invocationOrdinal = Number(input.handle[1]);
  const run = await client.modelRun.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      knowledgeRuns: {
        select: { results: true },
        take: 1,
        where: { invocationOrdinal }
      }
    },
    where: {
      assistantMessageId: input.assistantMessageId,
      chat: { projectId: input.projectId },
      chatId: input.chatId,
      projectRunBinding: { is: { projectId: input.projectId } }
    }
  });
  const results = run?.knowledgeRuns[0]?.results;
  if (!Array.isArray(results)) return null;
  const passage = results
    .map(decodeKnowledgeRetrievedPassage)
    .find((candidate) => candidate?.handle === input.handle) ?? null;
  if (!passage) return null;

  const memberships = await client.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId: input.userId }
  });
  const groupIds = memberships.map(({ groupId }) => groupId);
  const currentBase = await client.knowledgeBase.findFirst({
    select: { id: true },
    where: {
      archivedAt: null,
      id: passage.knowledgeBaseId,
      OR: [
        { ownerUserId: input.userId },
        {
          publications: {
            some: {
              OR: [
                { scope: "installation" },
                ...(groupIds.length > 0
                  ? [{ groupId: { in: groupIds }, scope: "group" as const }]
                  : [])
              ]
            }
          }
        }
      ],
      projectBindings: { some: { projectId: input.projectId } }
    }
  });
  if (!currentBase) return null;

  return {
    baseName: passage.baseName,
    fileName: passage.fileName,
    handle: passage.handle,
    page: passage.page,
    text: passage.includedText,
    textTruncated: passage.textTruncated
  };
}
