import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeKnowledgePlan,
  explicitKnowledgeSelection,
  type KnowledgePlan
} from "../../contracts/knowledge";

type ProjectChatDefaultClient =
  | Pick<PrismaClient, "projectKnowledgeBaseBinding" | "projectModelBinding">
  | Prisma.TransactionClient;

const projectModelAuthoritySelect = {
  providerModel: {
    select: {
      activeConfig: true,
      activeVersion: true,
      connection: {
        select: {
          activeConfig: true,
          activeVersion: true,
          defaultCredential: {
            select: {
              activeVersion: { select: { revokedAt: true } },
              enabled: true
            }
          },
          enabled: true,
          family: true
        }
      },
      connectionId: true,
      enabled: true,
      id: true,
      modelClass: true
    }
  }
} satisfies Prisma.ProjectModelBindingSelect;

const projectKnowledgeAuthoritySelect = {
  knowledgeBase: {
    select: {
      activeIndexGeneration: {
        select: {
          embeddingProviderModel: {
            select: {
              activeConfig: true,
              activeVersion: true,
              connection: {
                select: {
                  activeConfig: true,
                  activeVersion: true,
                  defaultCredential: {
                    select: {
                      activeVersion: { select: { revokedAt: true } },
                      enabled: true
                    }
                  },
                  enabled: true,
                  family: true
                }
              },
              enabled: true,
              modelClass: true
            }
          },
          profileRevisionId: true,
          status: true
        }
      },
      archivedAt: true,
      id: true,
      sourceMemberships: {
        select: {
          source: {
            select: {
              currentVersion: {
                select: {
                  artifacts: {
                    select: {
                      hierarchicalIndexes: {
                        orderBy: { schemaVersion: "desc" as const },
                        select: { state: true },
                        take: 1
                      },
                      profileRevisionId: true,
                      state: true
                    }
                  }
                }
              }
            }
          },
          sourceId: true
        },
        where: {
          removedAt: null,
          source: { deletionRequestedAt: null, trashedAt: null }
        }
      }
    }
  }
} satisfies Prisma.ProjectKnowledgeBaseBindingSelect;

type ProjectModelAuthorityRow = Prisma.ProjectModelBindingGetPayload<{
  select: typeof projectModelAuthoritySelect;
}>;
type ProjectKnowledgeAuthorityRow = Prisma.ProjectKnowledgeBaseBindingGetPayload<{
  select: typeof projectKnowledgeAuthoritySelect;
}>;

function activeSharedConnection(connection: ProjectModelAuthorityRow["providerModel"]["connection"]): boolean {
  return connection.enabled && connection.activeVersion > 0 && connection.activeConfig !== null && (
    connection.family === "fake" || Boolean(
      connection.defaultCredential?.enabled &&
      connection.defaultCredential.activeVersion?.revokedAt === null
    )
  );
}

function activeProjectModel(row: ProjectModelAuthorityRow): boolean {
  const model = row.providerModel;
  return model.enabled && model.modelClass === "answer" &&
    model.activeVersion > 0 && model.activeConfig !== null && activeSharedConnection(model.connection);
}

function activeProjectKnowledge(row: ProjectKnowledgeAuthorityRow): boolean {
  const base = row.knowledgeBase;
  const generation = base.activeIndexGeneration;
  const embedding = generation?.embeddingProviderModel;
  return base.archivedAt === null && generation?.status === "active" &&
    Boolean(embedding) && embedding!.enabled &&
    embedding!.modelClass === "embedding" && embedding!.activeVersion > 0 &&
    embedding!.activeConfig !== null && embedding!.connection.family !== "fake" &&
    activeSharedConnection(embedding!.connection);
}

export type ProjectChatDefaultAuthority = Readonly<{
  knowledgeBaseIds: ReadonlySet<string>;
  knowledgeSourceIds: ReadonlySet<string>;
  modelProviders: ReadonlyMap<string, string>;
}>;

/** Load only currently runnable Project authority. Stored chat defaults are
 * hints, never authorization evidence, so callers must project them through
 * this snapshot before returning them to a member. */
export async function loadProjectChatDefaultAuthority(
  client: ProjectChatDefaultClient,
  projectId: string
): Promise<ProjectChatDefaultAuthority> {
  const [models, knowledgeBases] = await Promise.all([
    client.projectModelBinding.findMany({
      select: projectModelAuthoritySelect,
      where: { projectId }
    }),
    client.projectKnowledgeBaseBinding.findMany({
      select: projectKnowledgeAuthoritySelect,
      where: { projectId }
    })
  ]);
  const activeKnowledge = knowledgeBases.filter(activeProjectKnowledge);
  const knowledgeSourceIds = new Set<string>();
  for (const { knowledgeBase } of activeKnowledge) {
    const profileRevisionId = knowledgeBase.activeIndexGeneration?.profileRevisionId;
    if (!profileRevisionId) continue;
    for (const membership of knowledgeBase.sourceMemberships) {
      const ready = membership.source.currentVersion?.artifacts.some((artifact) =>
        artifact.profileRevisionId === profileRevisionId && artifact.state === "ready" &&
        artifact.hierarchicalIndexes.some((hierarchy) => hierarchy.state === "ready"));
      if (ready) knowledgeSourceIds.add(membership.sourceId);
    }
  }
  return {
    knowledgeBaseIds: new Set(
      activeKnowledge.map((row) => row.knowledgeBase.id)
    ),
    knowledgeSourceIds,
    modelProviders: new Map(
      models.filter(activeProjectModel).map((row) => [
        row.providerModel.id,
        row.providerModel.connectionId
      ])
    )
  };
}

export function projectChatDefaultsProjection(
  authority: ProjectChatDefaultAuthority,
  input: Readonly<{
    defaultKnowledgePlan: Prisma.JsonValue | KnowledgePlan | null;
    defaultModelId: string | null;
  }>
): Readonly<{
  defaultKnowledgePlan: KnowledgePlan | null;
  defaultModelId: string | null;
  defaultProvider: string | null;
}> {
  const provider = input.defaultModelId
    ? authority.modelProviders.get(input.defaultModelId) ?? null
    : null;
  const decoded = input.defaultKnowledgePlan === null
    ? null
    : decodeKnowledgePlan(input.defaultKnowledgePlan);
  const knowledge = decoded?.ok && decoded.plan.mode !== "all_my_knowledge" &&
    (decoded.plan.mode !== "inherited" || decoded.plan.inheritedFrom === "project")
    ? decoded.plan.mode === "inherited"
      ? decoded.plan
      : explicitKnowledgeSelection({
          baseIds: decoded.plan.baseIds.filter((baseId) => authority.knowledgeBaseIds.has(baseId)),
          sourceIds: decoded.plan.sourceIds.filter((sourceId) =>
            authority.knowledgeSourceIds.has(sourceId))
        })
    : null;
  return {
    defaultKnowledgePlan: knowledge,
    defaultModelId: provider ? input.defaultModelId : null,
    defaultProvider: provider
  };
}
