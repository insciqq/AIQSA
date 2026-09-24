import type { Prisma } from "@prisma/client";
import type { ChatAccess } from "../projects/access";

/** Shared current-resource policy for retained evidence. It grants neither
 * synthesis delivery proof nor permission to execute retrieval again. */
type CitationViewerClient = Pick<Prisma.TransactionClient,
  "knowledgeBase" | "userGroup" | "knowledgeRunSourceBinding" | "projectKnowledgeSourceBinding">;
type EvidenceItem = Readonly<{
  knowledgeBaseId: string | null;
  sourceId: string | null;
  sourceVersionId: string | null;
  sourceArtifactId: string | null;
  sourceVersionNumber: number | null;
}>;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CurrentBase = Readonly<{
  name: string;
  ownerUserId: string;
  trashedAt: Date | null;
}>;

export type EvidenceAuthority = Readonly<{
  base: CurrentBase | null;
  knowledgeBaseId: string | null;
}>;

function acceptedBaseIds(value: Prisma.JsonValue | null): readonly string[] | null {
  if (!Array.isArray(value)) return value === null ? Object.freeze([]) : null;
  const result: string[] = [];
  for (const entry of value) {
    if (!record(entry) || Object.keys(entry).sort().join("\u0000") !==
      "indexGenerationId\u0000knowledgeBaseId" ||
      typeof entry.indexGenerationId !== "string" || !entry.indexGenerationId ||
      typeof entry.knowledgeBaseId !== "string" || !entry.knowledgeBaseId) return null;
    result.push(entry.knowledgeBaseId);
  }
  return new Set(result).size === result.length ? Object.freeze(result) : null;
}

export function installationOrGroupPublication(
  groupIds: readonly string[],
  includeTrash = false
): Prisma.KnowledgeBaseWhereInput {
  return {
    archivedAt: null,
    publications: {
      some: {
        OR: [
          { scope: "installation" },
          ...(groupIds.length > 0
            ? [{
                group: { archivedAt: null },
                groupId: { in: [...groupIds] },
                scope: "group" as const
              }]
            : [])
        ]
      }
    },
    ...(includeTrash ? {} : { trashedAt: null })
  };
}

export async function currentBaseForAccess(
  client: CitationViewerClient,
  input: Readonly<{
    access: ChatAccess;
    knowledgeBaseId: string;
    userId: string;
  }>
): Promise<CurrentBase | null> {
  if (input.access.kind === "project") {
    return client.knowledgeBase.findFirst({
      select: { name: true, ownerUserId: true, trashedAt: true },
      where: {
        deletionRequestedAt: null,
        id: input.knowledgeBaseId,
        projectBindings: { some: { projectId: input.access.project.projectId } }
      }
    });
  }

  const memberships = await client.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId: input.userId }
  });
  return client.knowledgeBase.findFirst({
    select: { name: true, ownerUserId: true, trashedAt: true },
    where: {
      deletionRequestedAt: null,
      id: input.knowledgeBaseId,
      OR: [
        { ownerUserId: input.userId },
        installationOrGroupPublication(memberships.map(({ groupId }) => groupId), true)
      ]
    }
  });
}

export async function currentAuthorityForEvidence(
  client: CitationViewerClient,
  input: Readonly<{
    access: ChatAccess;
    item: EvidenceItem;
    runId: string;
    userId: string;
  }>
): Promise<EvidenceAuthority | null> {
  if (!input.item.sourceId || !input.item.sourceVersionId || !input.item.sourceArtifactId) {
    return null;
  }
  const binding = await client.knowledgeRunSourceBinding.findFirst({
    select: {
      baseProvenance: true,
      profileBindingId: true,
      sourceVersionNumber: true,
      source: { select: { ownerUserId: true } }
    },
    where: {
      modelRunId: input.runId,
      readinessState: "ready",
      sourceArtifactId: input.item.sourceArtifactId,
      sourceId: input.item.sourceId,
      sourceVersionId: input.item.sourceVersionId,
      tombstonedAt: null
    }
  });
  if (!binding?.source || binding.profileBindingId !== input.item.knowledgeBaseId ||
    binding.sourceVersionNumber !== input.item.sourceVersionNumber) return null;
  const baseIds = acceptedBaseIds(binding.baseProvenance);
  if (baseIds === null) return null;
  for (const knowledgeBaseId of baseIds) {
    const base = await currentBaseForAccess(client, {
      access: input.access,
      knowledgeBaseId,
      userId: input.userId
    });
    if (base) return Object.freeze({ base, knowledgeBaseId });
  }
  if (baseIds.length > 0) return null;
  if (input.access.kind === "personal") {
    return binding.source.ownerUserId === input.userId
      ? Object.freeze({ base: null, knowledgeBaseId: null })
      : null;
  }
  const projectBinding = await client.projectKnowledgeSourceBinding.findUnique({
    select: { projectId: true },
    where: {
      projectId_sourceId: {
        projectId: input.access.project.projectId,
        sourceId: input.item.sourceId
      }
    }
  });
  return projectBinding
    ? Object.freeze({ base: null, knowledgeBaseId: null })
    : null;
}
