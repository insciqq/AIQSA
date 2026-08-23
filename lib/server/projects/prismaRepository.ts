import {
  Prisma,
  PrismaClient,
  type ProjectRole as PrismaProjectRole
} from "@prisma/client";
import {
  DEFAULT_PROJECT_POLICY,
  EMPTY_PROJECT_DEFAULTS,
  decodeProjectDefaults,
  type ProjectActivityResponseWire,
  type ProjectAuditEventWire,
  type ProjectCandidatesResponseWire,
  type ProjectCandidateTypeWire,
  type ProjectCandidateWire,
  type ProjectDefaultsWire,
  type ProjectDetailWire,
  type ProjectGrantWire,
  type ProjectPolicyWire,
  type ProjectReadinessWire,
  type ProjectGrantRemovalPreviewWire,
  type ProjectResourceChangePreviewWire,
  type ProjectResourceDependencyPreviewWire,
  type ProjectResourceTypeWire,
  type ProjectResourceWire,
  type ProjectSummaryWire
} from "../../contracts/projects";
import {
  ASSISTANT_CATEGORIES,
  decodeAssistantAvatarRecipe,
  decodeAssistantRunControls,
  type AssistantCategory
} from "../../contracts/assistants";
import {
  decodeKnowledgePlan,
  explicitKnowledgeSelection,
  inheritedKnowledgeSelection
} from "../../contracts/knowledge";
import { buildCatalogModel, toCatalogSearchStrategy } from "../../domain/catalogMatrix";
import { decodeSearchPlan } from "../../domain/search";
import {
  providerModelToCatalogEntry,
  searchOptionToCatalogEntry,
  type CatalogProviderModelRow,
  type CatalogSearchOptionRow
} from "../catalog/prismaCatalogData";
import { KNOWLEDGE_INDEX_PROFILE_ID } from "../knowledge/knowledgeProfile";
import {
  getRunAttachmentLimits,
  toCatalogAttachmentLimits
} from "../runs/attachmentLimits";
import {
  PROJECT_ROLE_CAPABILITIES,
  highestProjectRole,
  projectRoleAtLeast,
  type ProjectRole
} from "../../domain/projects";
import { resolveProjectAccess } from "./access";
import {
  activeSharedProjectConnection,
  eligibleProjectAnswerModel,
  eligibleProjectKnowledgeBase
} from "./chatDefaults";
import { notifyProjectEvent } from "./events";

export type ProjectRepositoryResult<Value> =
  | Readonly<{ kind: "conflict"; reason: string }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "target_not_found"; reason: string }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "ok"; value: Value }>;

export type ProjectRepository = ReturnType<typeof createPrismaProjectRepository>;

const activeProjectSourceArtifactWhere = {
  profileRevision: {
    activeFor: { is: { id: KNOWLEDGE_INDEX_PROFILE_ID } },
    preflightErrorCode: null,
    preflightStatus: "ready"
  }
} satisfies Prisma.KnowledgeSourceIndexArtifactWhereInput;

const projectListInclude = {
  _count: { select: { chats: true } },
  grants: {
    include: {
      group: { select: { archivedAt: true, id: true, name: true } },
      user: { select: { id: true, status: true } }
    }
  }
} satisfies Prisma.ProjectInclude;

type ProjectListRow = Prisma.ProjectGetPayload<{ include: typeof projectListInclude }>;

const projectDetailInclude = {
  _count: { select: { attachments: true, chats: true } },
  assistantBindings: {
    include: {
      assistant: { select: { archivedAt: true } },
      revision: {
        select: {
          avatar: true,
          category: true,
          createdAt: true,
          description: true,
          developerPrompt: true,
          id: true,
          knowledgeSelection: true,
          mcpServerIds: true,
          name: true,
          providerModelId: true,
          revisionNumber: true,
          runControls: true,
          searchPlan: true,
          skillLinks: { select: { skillId: true } },
          starterPrompts: true,
          systemPrompt: true
        }
      }
    }
  },
  grants: {
    include: {
      group: { select: { archivedAt: true, id: true, name: true } },
      user: { select: { displayName: true, email: true, id: true, status: true } }
    },
    orderBy: { createdAt: "asc" as const }
  },
  knowledgeBaseBindings: {
    include: {
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
                        select: { activeVersion: { select: { revokedAt: true } }, enabled: true }
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
          description: true,
          id: true,
          name: true,
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
                  },
                  description: true,
                  id: true,
                  name: true
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
    }
  },
  knowledgeSourceBindings: {
    include: {
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
                },
                where: activeProjectSourceArtifactWhere
              }
            }
          },
          deletionRequestedAt: true,
          description: true,
          id: true,
          name: true,
          trashedAt: true
        }
      }
    }
  },
  mcpBindings: {
    include: {
      server: {
        select: {
          activeRevision: { select: { configuration: true, validationEvidence: true } },
          activeRevisionId: true,
          archivedAt: true,
          description: true,
          displayName: true,
          enabled: true,
          id: true,
          sharedConfigEnvelope: true
        }
      }
    }
  },
  modelBindings: {
    include: {
      providerModel: {
        select: {
          connection: {
            select: {
              activeConfig: true,
              activeVersion: true,
              activatedAt: true,
              defaultCredential: {
                select: {
                  activeVersion: { select: { id: true, revokedAt: true } },
                  enabled: true,
                  id: true
                }
              },
              defaultCredentialId: true,
              displayName: true,
              enabled: true,
              family: true,
              id: true,
              templateKey: true,
              unassignedPolicy: true
            }
          },
          activeCredentialChecks: {
            select: {
              connectionId: true,
              connectionVersion: true,
              credentialId: true,
              credentialVersionId: true,
              evidence: true,
              modelVersion: true,
              providerModelId: true,
              status: true
            }
          },
          activeConfig: true,
          activeVersion: true,
          activatedAt: true,
          capabilities: true,
          connectionId: true,
          createdAt: true,
          defaultParams: true,
          displayName: true,
          draftConfig: true,
          draftVersion: true,
          enabled: true,
          id: true,
          inputTokenPriceMicros: true,
          modelClass: true,
          modelId: true,
          outputTokenPriceMicros: true,
          provider: true,
          supportsNativeSearch: true,
          supportsPdf: true,
          supportsReasoning: true,
          supportsVision: true,
          templateKey: true,
          updatedAt: true
        }
      }
    }
  },
  searchBindings: {
    include: {
      searchOption: {
        select: {
          archivedAt: true,
          description: true,
          displayName: true,
          enabled: true,
          id: true,
          kind: true,
          optionId: true,
          sourceConnection: {
            select: {
              activeConfig: true,
              activeVersion: true,
              defaultCredential: {
                select: { activeVersion: { select: { revokedAt: true } }, enabled: true }
              },
              enabled: true,
              family: true,
              id: true
            }
          },
          sourceConnectionId: true,
          strategies: {
            select: {
              activeRevision: {
                select: {
                  adapterKind: true,
                  configuration: true,
                  credentialMode: true,
                  id: true,
                  providerModelId: true
                }
              },
              activeRevisionId: true,
              adapterKind: true,
              archivedAt: true,
              config: true,
              credentialMode: true,
              description: true,
              displayName: true,
              draft: true,
              draftTestEvidence: true,
              draftVersion: true,
              enabled: true,
              id: true,
              kind: true,
              modelId: true,
              provider: true,
              providerModelId: true,
              searchOptionId: true,
              strategyId: true,
              testedDraftHash: true,
              updatedAt: true,
              createdAt: true,
              activatedAt: true
            },
            where: { activeRevisionId: { not: null }, archivedAt: null, enabled: true }
          }
        }
      }
    }
  },
  skillBindings: {
    include: {
      skill: {
        include: { currentRevision: { select: { description: true, id: true, instructions: true, name: true } } }
      }
    }
  }
} satisfies Prisma.ProjectInclude;

type ProjectDetailRow = Prisma.ProjectGetPayload<{ include: typeof projectDetailInclude }>;

type ProjectKnowledgeSourceWire = NonNullable<
  ProjectDetailWire["composer"]
>["knowledgeSources"][number];

function projectKnowledgeSources(
  row: ProjectDetailRow,
  visibleKnowledgeBaseIds: ReadonlySet<string>
): ProjectKnowledgeSourceWire[] {
  const priority = { needs_attention: 0, processing: 1, ready: 2 } as const;
  const sources = new Map<string, ProjectKnowledgeSourceWire>();
  for (const binding of row.knowledgeBaseBindings) {
    const base = binding.knowledgeBase;
    if (!visibleKnowledgeBaseIds.has(base.id)) continue;
    const profileRevisionId = base.activeIndexGeneration?.profileRevisionId;
    for (const membership of base.sourceMemberships) {
      const source = membership.source;
      const artifact = profileRevisionId
        ? source.currentVersion?.artifacts.find((candidate) =>
            candidate.profileRevisionId === profileRevisionId)
        : null;
      const hierarchyState = artifact?.hierarchicalIndexes[0]?.state;
      const readiness: ProjectKnowledgeSourceWire["readiness"] =
        artifact?.state === "ready" && hierarchyState === "ready"
          ? "ready"
          : artifact?.state === "pending" || artifact?.state === "processing" ||
              artifact?.state === "ready" && hierarchyState === "building"
            ? "processing"
            : "needs_attention";
      const next = {
        description: source.description,
        id: source.id,
        name: source.name,
        owned: false,
        readiness
      } satisfies ProjectKnowledgeSourceWire;
      const current = sources.get(source.id);
      if (!current || priority[next.readiness] > priority[current.readiness]) {
        sources.set(source.id, next);
      }
    }
  }
  for (const binding of row.knowledgeSourceBindings) {
    const source = binding.source;
    if (source.deletionRequestedAt !== null || source.trashedAt !== null) continue;
    const artifact = source.currentVersion?.artifacts[0];
    const hierarchyState = artifact?.hierarchicalIndexes[0]?.state;
    const readiness: ProjectKnowledgeSourceWire["readiness"] =
      artifact?.state === "ready" && hierarchyState === "ready"
        ? "ready"
        : artifact?.state === "pending" || artifact?.state === "processing" ||
            artifact?.state === "ready" && hierarchyState === "building"
          ? "processing"
          : "needs_attention";
    const next = {
      description: source.description,
      id: source.id,
      name: source.name,
      owned: false,
      readiness
    } satisfies ProjectKnowledgeSourceWire;
    const current = sources.get(source.id);
    if (!current || priority[next.readiness] > priority[current.readiness]) {
      sources.set(source.id, next);
    }
  }
  return [...sources.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function iso(value: Date): string {
  return value.toISOString();
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function searchOptionIds(value: Prisma.JsonValue): string[] {
  const plan = jsonObject(value);
  return Array.isArray(plan.optionIds)
    ? [...new Set(plan.optionIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
}

function mcpRevisionUsesNoAuth(value: Prisma.JsonValue): boolean {
  const configuration = jsonObject(value);
  const auth = configuration.auth;
  return typeof auth === "object" && auth !== null && !Array.isArray(auth) &&
    "mode" in auth && auth.mode === "none";
}

function storedDefaults(value: Prisma.JsonValue): ProjectDefaultsWire {
  const raw = jsonObject(value);
  return {
    assistantId: typeof raw.assistantId === "string" ? raw.assistantId : null,
    controlValues:
      typeof raw.controlValues === "object" && raw.controlValues !== null && !Array.isArray(raw.controlValues)
        ? raw.controlValues as Record<string, boolean | string>
        : EMPTY_PROJECT_DEFAULTS.controlValues,
    knowledgePlan:
      typeof raw.knowledgePlan === "object" && raw.knowledgePlan !== null
        ? raw.knowledgePlan as ProjectDefaultsWire["knowledgePlan"]
        : EMPTY_PROJECT_DEFAULTS.knowledgePlan,
    mcpMode: raw.mcpMode === "auto" || raw.mcpMode === "load_all" ? raw.mcpMode : "off",
    providerModelId: typeof raw.providerModelId === "string" ? raw.providerModelId : null,
    searchPlan:
      typeof raw.searchPlan === "object" && raw.searchPlan !== null
        ? raw.searchPlan as ProjectDefaultsWire["searchPlan"]
        : EMPTY_PROJECT_DEFAULTS.searchPlan
  };
}

function storedPolicy(value: Prisma.JsonValue): ProjectPolicyWire {
  const raw = jsonObject(value);
  return {
    externalToolsEnabled:
      typeof raw.externalToolsEnabled === "boolean"
        ? raw.externalToolsEnabled
        : DEFAULT_PROJECT_POLICY.externalToolsEnabled
  };
}

function rolesFor(row: ProjectListRow, userId: string, activeGroupIds: ReadonlySet<string>) {
  const directRole = row.grants.find((grant) => grant.userId === userId)?.role ?? null;
  const grantedThrough = row.grants.flatMap((grant) =>
    grant.groupId && grant.group && !grant.group.archivedAt && activeGroupIds.has(grant.groupId)
      ? [{ groupId: grant.groupId, groupName: grant.group.name, role: grant.role }]
      : []
  );
  return {
    directRole,
    effectiveRole: highestProjectRole([
      ...(directRole ? [directRole] : []),
      ...grantedThrough.map(({ role }) => role)
    ]),
    grantedThrough
  };
}

function summary(
  row: ProjectListRow,
  input: { activeGroupIds: ReadonlySet<string>; audienceCount?: number; userId: string }
): ProjectSummaryWire | null {
  const roles = rolesFor(row, input.userId, input.activeGroupIds);
  if (!roles.effectiveRole) return null;
  const audienceCount = input.audienceCount ?? row.grants.filter((grant) =>
    (grant.userId !== null && grant.user?.status === "active") ||
    (grant.groupId !== null && grant.group?.archivedAt === null)
  ).length;
  return {
    accessRevision: row.accessRevision,
    audienceCount,
    chatCount: row._count.chats,
    description: row.description,
    directRole: roles.directRole,
    effectiveRole: roles.effectiveRole,
    grantedThrough: roles.grantedThrough,
    id: row.id,
    name: row.name,
    status: row.status,
    updatedAt: iso(row.updatedAt)
  };
}

function grantWire(grant: ProjectDetailRow["grants"][number]): ProjectGrantWire {
  return {
    createdAt: iso(grant.createdAt),
    group: grant.group
      ? {
          archived: grant.group.archivedAt !== null,
          id: grant.group.id,
          name: grant.group.name
        }
      : null,
    id: grant.id,
    role: grant.role,
    user: grant.user
      ? {
          displayName: grant.user.displayName,
          email: grant.user.email,
          id: grant.user.id,
          status: grant.user.status
        }
      : null
  };
}

function resources(row: ProjectDetailRow): ProjectResourceWire[] {
  const modelEligible = (model: ProjectDetailRow["modelBindings"][number]["providerModel"]) =>
    eligibleProjectAnswerModel(model);
  const values = [
    ...row.modelBindings.map((binding) => ({
      available: modelEligible(binding.providerModel),
      id: `model:${binding.providerModelId}`,
      label: binding.providerModel.displayName,
      // Catalog/run APIs address the installation deployment by ProviderModel
      // id. The legacy `modelId` column is an upstream label and must never be
      // used as Project authority.
      modelId: binding.providerModelId,
      provider: binding.providerModel.connectionId,
      reason: modelEligible(binding.providerModel)
        ? null
        : "resource_unavailable",
      resourceId: binding.providerModelId,
      type: "model" as const
    })),
    ...row.searchBindings.map((binding) => {
      const connection = binding.searchOption.sourceConnection;
      const catalogEntry = searchOptionToCatalogEntry(
        binding.searchOption as unknown as CatalogSearchOptionRow
      );
      const eligible = binding.searchOption.enabled && binding.searchOption.archivedAt === null &&
        Boolean(connection) &&
        Boolean(catalogEntry?.routes.length) &&
        activeSharedProjectConnection(connection!);
      return {
      available: eligible,
      id: `search:${binding.searchOptionId}`,
      label: binding.searchOption.displayName,
      reason: eligible ? null : "resource_unavailable",
      resourceId: binding.searchOption.optionId,
      type: "search" as const
    }; }),
    ...row.mcpBindings.map((binding) => {
      const eligible = binding.server.enabled && binding.server.archivedAt === null &&
        Boolean(binding.server.activeRevisionId) && (
          Boolean(binding.server.sharedConfigEnvelope) || Boolean(
            binding.server.activeRevision &&
            mcpRevisionUsesNoAuth(binding.server.activeRevision.configuration)
          )
        );
      return {
      available: eligible,
      id: `mcp:${binding.serverId}`,
      label: binding.server.displayName,
      reason: eligible ? null : "resource_unavailable",
      resourceId: binding.serverId,
      type: "mcp" as const
    }; }),
    ...row.knowledgeBaseBindings.map((binding) => {
      const eligible = eligibleProjectKnowledgeBase(binding.knowledgeBase);
      return {
      available: eligible,
      id: binding.id,
      label: binding.knowledgeBase.name,
      reason: eligible ? null : "resource_unavailable",
      resourceId: binding.knowledgeBaseId,
      type: "knowledge" as const
    }; }),
    ...row.assistantBindings.map((binding) => ({
      available: binding.assistant.archivedAt === null,
      id: binding.id,
      label: binding.revision.name,
      reason: binding.assistant.archivedAt === null ? null : "resource_archived",
      resourceId: binding.assistantId,
      revisionId: binding.revisionId,
      type: "assistant" as const
    })),
    ...row.skillBindings.map((binding) => ({
      available: binding.skill.archivedAt === null && binding.skill.deletedAt === null &&
        binding.skill.currentRevision !== null,
      id: binding.id,
      label: binding.skill.currentRevision?.name ?? "Unavailable skill",
      ...(binding.skill.currentRevision ? {
        description: binding.skill.currentRevision.description,
        promptCharacterCount: binding.skill.currentRevision.instructions.length
      } : {}),
      reason: binding.skill.currentRevision ? null : "resource_unavailable",
      resourceId: binding.skillId,
      revisionId: binding.skill.currentRevision?.id,
      type: "skill" as const
    }))
  ];
  // A revoked/disabled resource is not a diagnostic projection.  Omitting it
  // prevents stale IDs, labels, and revisions from becoming a privacy leak;
  // the generic activity event remains visible to managers.
  const independentlyAvailable = values.filter((resource) =>
    resource.available && resource.type !== "assistant"
  );
  const activeByType = (type: ProjectResourceTypeWire) => new Set(
    independentlyAvailable.flatMap((resource) => resource.type === type ? [resource.resourceId] : [])
  );
  const models = activeByType("model");
  const searches = activeByType("search");
  const knowledge = activeByType("knowledge");
  const knowledgeSources = new Set(projectKnowledgeSources(row, knowledge)
    .filter((source) => source.readiness === "ready")
    .map((source) => source.id));
  const mcp = activeByType("mcp");
  const skills = activeByType("skill");
  const assistants = values.filter((resource) => {
    if (!resource.available || resource.type !== "assistant") return false;
    const binding = row.assistantBindings.find((candidate) =>
      candidate.assistantId === resource.resourceId && candidate.revisionId === resource.revisionId
    );
    const selection = binding ? decodeKnowledgePlan(binding.revision.knowledgeSelection) : null;
    return Boolean(binding) && selection?.ok === true &&
      selection.plan.mode !== "all_my_knowledge" && selection.plan.mode !== "inherited" &&
      models.has(binding!.revision.providerModelId) &&
      selection.plan.baseIds.every((id) => knowledge.has(id)) &&
      selection.plan.sourceIds.every((id) => knowledgeSources.has(id)) &&
      binding!.revision.mcpServerIds.every((id) => mcp.has(id)) &&
      searchOptionIds(binding!.revision.searchPlan).every((id) => searches.has(id)) &&
      binding!.revision.skillLinks.every((link) => skills.has(link.skillId));
  });
  return [...independentlyAvailable, ...assistants];
}

function mcpKnownToolCount(value: Prisma.JsonValue | undefined): number {
  const evidence = value ? jsonObject(value) : {};
  return Array.isArray(evidence.toolInventory) ? evidence.toolInventory.length : 0;
}

function projectComposer(
  row: ProjectDetailRow,
  visibleResources: readonly ProjectResourceWire[],
  defaults: ProjectDefaultsWire
): ProjectDetailWire["composer"] {
  const visible = new Map(visibleResources.map((resource) => [resource.id, resource] as const));
  const visibleModelIds = new Set(visibleResources.flatMap((resource) =>
    resource.type === "model" ? [resource.resourceId] : []
  ));
  const visibleSearchIds = new Set(visibleResources.flatMap((resource) =>
    resource.type === "search" ? [resource.resourceId] : []
  ));
  const searchEntries = row.searchBindings.flatMap((binding) => {
    if (!visibleSearchIds.has(binding.searchOption.optionId)) return [];
    const entry = searchOptionToCatalogEntry(
      binding.searchOption as unknown as CatalogSearchOptionRow
    );
    return entry ? [entry] : [];
  });
  const modelEntries = row.modelBindings.flatMap((binding) => {
    if (!visibleModelIds.has(binding.providerModelId)) return [];
    const providerModel = binding.providerModel;
    const defaultCredential = providerModel.connection.defaultCredential;
    const credentialCheck = defaultCredential?.enabled && defaultCredential.activeVersion &&
      defaultCredential.activeVersion.revokedAt === null
      ? providerModel.activeCredentialChecks.find((check) =>
          check.status === "available" &&
          check.connectionId === providerModel.connectionId &&
          check.providerModelId === providerModel.id &&
          check.credentialId === defaultCredential.id &&
          check.credentialVersionId === defaultCredential.activeVersion!.id &&
          check.connectionVersion === providerModel.connection.activeVersion &&
          check.modelVersion === providerModel.activeVersion
        ) ?? null
      : null;
    const entry = providerModelToCatalogEntry({
      ...providerModel,
      connection: {
        ...providerModel.connection,
        credentials: []
      }
    } as unknown as CatalogProviderModelRow, {
      credentialCheckEvidence: credentialCheck?.evidence
    });
    return entry ? [entry] : [];
  });
  const models = modelEntries.map((entry) => buildCatalogModel(entry, searchEntries));
  const defaultModel = models.find((model) => model.modelId === defaults.providerModelId) ?? null;
  const providers = Array.from(new Set(models.map((model) => model.provider))).map((provider) => {
    const source = modelEntries.find((model) => model.provider === provider);
    return {
      family: source?.providerFamily ?? "unknown",
      id: provider,
      models: models.filter((model) => model.provider === provider).map((model) => model.modelId),
      name: source?.providerDisplayName ?? provider
    };
  });

  const assistants = row.assistantBindings.flatMap((binding) => {
    if (!visible.has(binding.id)) return [];
    const avatar = decodeAssistantAvatarRecipe(binding.revision.avatar);
    const controls = decodeAssistantRunControls(binding.revision.runControls);
    const searchPlan = decodeSearchPlan(binding.revision.searchPlan);
    if (!avatar || !controls || !searchPlan.ok) return [];
    const category = binding.revision.category !== null &&
      ASSISTANT_CATEGORIES.includes(binding.revision.category as AssistantCategory)
      ? binding.revision.category as AssistantCategory
      : null;
    const promptCharacterCount = binding.revision.systemPrompt.length +
      (binding.revision.developerPrompt?.length ?? 0);
    const modelLabel = models.find((model) =>
      model.modelId === binding.revision.providerModelId
    )?.displayName ?? null;
    const skillIds = binding.revision.skillLinks.map((link) => link.skillId);
    return [{
      promptCharacterCount,
      revision: {
        authorDisplayName: null,
        avatar,
        category,
        createdAt: iso(binding.revision.createdAt),
        description: binding.revision.description,
        // Prompts remain server-side; only the bounded size participates in
        // the composer context gauge.
        developerPrompt: null,
        knowledgeSelection: inheritedKnowledgeSelection("assistant"),
        mcpServerIds: binding.revision.mcpServerIds,
        name: binding.revision.name,
        providerModelId: binding.revision.providerModelId,
        revisionNumber: binding.revision.revisionNumber,
        runControls: controls,
        searchPlan: searchPlan.plan,
        skillIds,
        starterPrompts: binding.revision.starterPrompts,
        systemPrompt: ""
      },
      summary: {
        archived: false,
        availability: { ok: true as const },
        avatar,
        category,
        description: binding.revision.description,
        fingerprint: {
          mcpServerCount: binding.revision.mcpServerIds.length,
          modelLabel,
          reasoningEffort: controls.reasoningEffort ?? null,
          searchOptionCount: searchPlan.plan.optionIds.length
        },
        id: binding.assistantId,
        name: binding.revision.name,
        owned: false,
        ownerDisplayName: "Project",
        pinned: false,
        published: true,
        revisionNumber: binding.revision.revisionNumber,
        scope: { kind: "installation" as const },
        starterPrompts: binding.revision.starterPrompts,
        updatedAt: iso(binding.revision.createdAt)
      }
    }];
  });
  const knowledgeBases = row.knowledgeBaseBindings.flatMap((binding) =>
    visible.has(binding.id)
      ? [{
          archived: false,
          description: binding.knowledgeBase.description,
          id: binding.knowledgeBaseId,
          name: binding.knowledgeBase.name,
          owned: false
        }]
      : []
  );
  const knowledgeSources = projectKnowledgeSources(
    row,
    new Set(knowledgeBases.map((base) => base.id))
  );
  const mcpServers = row.mcpBindings.flatMap((binding) =>
    visible.has(`mcp:${binding.serverId}`)
      ? [{
          description: binding.server.description,
          enabled: true,
          id: binding.serverId,
          knownToolCount: mcpKnownToolCount(binding.server.activeRevision?.validationEvidence),
          name: binding.server.displayName,
          readiness: "ready" as const
        }]
      : []
  );
  const defaultSelection = defaultModel
    ? { modelId: defaultModel.modelId, provider: defaultModel.provider }
    : null;

  return {
    assistants,
    catalog: {
      attachmentLimits: toCatalogAttachmentLimits(getRunAttachmentLimits()),
      defaults: {
        controlValues: { ...defaults.controlValues },
        hasPersonalModelDefault: false,
        modelId: defaultModel?.modelId ?? "",
        modelPreferenceSource: defaultSelection ? "organization" : "none",
        organizationModelDefault: defaultSelection,
        organizationSearchPlan: defaults.searchPlan,
        personalModelDefault: null,
        provider: defaultModel?.provider ?? "",
        searchPlan: defaults.searchPlan,
        searchPreferenceSource: "organization",
        showCitations: true,
        showReasoningBlocks: false
      },
      models,
      providers,
      searchStrategies: searchEntries.map(toCatalogSearchStrategy)
    },
    knowledgeBases,
    knowledgeSources,
    mcpServers
  };
}

function readiness(row: ProjectDetailRow): ProjectReadinessWire {
  const eligibleModelIds = new Set(row.modelBindings.filter((binding) =>
    eligibleProjectAnswerModel(binding.providerModel)
  ).map((binding) => binding.providerModelId));
  const defaultModelId = storedDefaults(row.defaults).providerModelId;
  return defaultModelId && eligibleModelIds.has(defaultModelId)
    ? { readiness: "READY", setupReasons: [] }
    : {
        readiness: "SETUP_REQUIRED",
        setupReasons: [
          "default_model_required",
          ...(eligibleModelIds.size === 0 ? ["shared_model_unavailable" as const] : [])
        ]
      };
}

function detail(
  row: ProjectDetailRow,
  access: NonNullable<Awaited<ReturnType<typeof resolveProjectAccess>>>,
  audienceCount?: number
): ProjectDetailWire {
  const visibleResources = resources(row);
  const visibleModels = new Set(visibleResources.flatMap((resource) =>
    resource.type === "model" ? [resource.resourceId] : []
  ));
  const visibleAssistants = new Set(visibleResources.flatMap((resource) =>
    resource.type === "assistant" ? [resource.resourceId] : []
  ));
  const visibleKnowledge = new Set(visibleResources.flatMap((resource) =>
    resource.type === "knowledge" ? [resource.resourceId] : []
  ));
  const visibleKnowledgeSources = new Set(projectKnowledgeSources(row, visibleKnowledge)
    .filter((source) => source.readiness === "ready")
    .map((source) => source.id));
  const visibleSearch = new Set(visibleResources.flatMap((resource) =>
    resource.type === "search" ? [resource.resourceId] : []
  ));
  const rawDefaults = storedDefaults(row.defaults);
  const safeDefaults: ProjectDefaultsWire = {
    ...rawDefaults,
    assistantId: rawDefaults.assistantId && visibleAssistants.has(rawDefaults.assistantId)
      ? rawDefaults.assistantId
      : null,
    knowledgePlan: rawDefaults.knowledgePlan.mode === "inherited"
      ? rawDefaults.knowledgePlan
      : explicitKnowledgeSelection({
          baseIds: rawDefaults.knowledgePlan.baseIds.filter((id) => visibleKnowledge.has(id)),
          sourceIds: rawDefaults.knowledgePlan.sourceIds.filter((id) =>
            visibleKnowledgeSources.has(id))
        }),
    mcpMode: visibleResources.some((resource) => resource.type === "mcp")
      ? rawDefaults.mcpMode
      : "off",
    providerModelId: rawDefaults.providerModelId && visibleModels.has(rawDefaults.providerModelId)
      ? rawDefaults.providerModelId
      : null,
    searchPlan: {
      ...rawDefaults.searchPlan,
      optionIds: rawDefaults.searchPlan.optionIds.filter((id) => visibleSearch.has(id))
    }
  };
  const base: ProjectSummaryWire = {
    accessRevision: row.accessRevision,
    audienceCount: audienceCount ?? row.grants.filter((grant) =>
      (grant.user !== null && grant.user.status === "active") ||
      (grant.group !== null && grant.group.archivedAt === null)
    ).length,
    chatCount: row._count.chats,
    description: row.description,
    directRole: access.directRole,
    effectiveRole: access.effectiveRole,
    grantedThrough: access.groupGrants,
    id: row.id,
    name: row.name,
    status: row.status,
    updatedAt: iso(row.updatedAt)
  };
  return {
    ...base,
    capabilities: PROJECT_ROLE_CAPABILITIES[access.effectiveRole],
    composer: projectComposer(row, visibleResources, safeDefaults),
    createdAt: iso(row.createdAt),
    defaults: safeDefaults,
    fileCount: row._count.attachments,
    grants: row.grants.map(grantWire),
    instructions: row.instructions,
    instructionsRevision: row.instructionsRevision,
    memoryEnabled: row.memoryEnabled,
    memoryRevision: row.memoryRevision,
    policy: storedPolicy(row.policy),
    policyRevision: row.policyRevision,
    publicSharingEnabled: row.publicSharingEnabled,
    ...readiness(row),
    resources: visibleResources
  };
}

function auditMetadata(value: Prisma.JsonValue): ProjectAuditEventWire["metadata"] {
  const raw = jsonObject(value);
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, boolean | number | string | null] =>
      !/(?:Id$|Ids$|Token|secret|credential|payload|revision|version)/iu.test(entry[0]) &&
      (entry[1] === null || ["boolean", "number", "string"].includes(typeof entry[1]))
    )
  );
}

async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`);
}

async function effectiveAudienceCount(db: PrismaClient | Prisma.TransactionClient, projectId: string): Promise<number> {
  const grants = await db.projectGrant.findMany({
    select: { groupId: true, userId: true },
    where: { projectId }
  });
  const userIds = new Set(grants.flatMap((grant) => grant.userId ? [grant.userId] : []));
  const groupIds = grants.flatMap((grant) => grant.groupId ? [grant.groupId] : []);
  if (groupIds.length) {
    const members = await db.userGroup.findMany({
      select: { userId: true },
      where: { groupId: { in: groupIds }, group: { archivedAt: null }, user: { status: "active" } }
    });
    members.forEach(({ userId }) => userIds.add(userId));
  }
  if (userIds.size === 0) return 0;
  return db.user.count({ where: { id: { in: [...userIds] }, status: "active" } });
}

function audit(input: {
  actorDisplayName: string;
  actorUserId: string;
  eventType: string;
  metadata?: Prisma.InputJsonObject;
  projectId: string;
}): Prisma.ProjectAuditEventUncheckedCreateInput {
  return {
    actorDisplayName: input.actorDisplayName,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    metadata: input.metadata ?? {},
    projectId: input.projectId
  };
}

type BoundProjectResource = Readonly<{
  bindingId: string;
  label: string;
  resourceId: string;
  storageId: string;
  type: ProjectResourceTypeWire;
}>;

type ProjectDataClient = PrismaClient | Prisma.TransactionClient;

async function resolveBoundProjectResource(
  db: ProjectDataClient,
  projectId: string,
  bindingId: string
): Promise<BoundProjectResource | null> {
  const prefixed = /^(model|search|mcp):(.+)$/u.exec(bindingId);
  if (prefixed?.[1] === "model") {
    const binding = await db.projectModelBinding.findUnique({
      include: { providerModel: { select: { displayName: true } } },
      where: { projectId_providerModelId: { projectId, providerModelId: prefixed[2]! } }
    });
    return binding ? {
      bindingId,
      label: binding.providerModel.displayName,
      resourceId: binding.providerModelId,
      storageId: binding.providerModelId,
      type: "model"
    } : null;
  }
  if (prefixed?.[1] === "search") {
    const binding = await db.projectSearchBinding.findUnique({
      include: { searchOption: { select: { displayName: true, optionId: true } } },
      where: { projectId_searchOptionId: { projectId, searchOptionId: prefixed[2]! } }
    });
    return binding ? {
      bindingId,
      label: binding.searchOption.displayName,
      resourceId: binding.searchOption.optionId,
      storageId: binding.searchOptionId,
      type: "search"
    } : null;
  }
  if (prefixed?.[1] === "mcp") {
    const binding = await db.projectMcpBinding.findUnique({
      include: { server: { select: { displayName: true } } },
      where: { projectId_serverId: { projectId, serverId: prefixed[2]! } }
    });
    return binding ? {
      bindingId,
      label: binding.server.displayName,
      resourceId: binding.serverId,
      storageId: binding.serverId,
      type: "mcp"
    } : null;
  }
  const knowledge = await db.projectKnowledgeBaseBinding.findFirst({
    include: { knowledgeBase: { select: { name: true } } },
    where: { id: bindingId, projectId }
  });
  if (knowledge) return {
    bindingId,
    label: knowledge.knowledgeBase.name,
    resourceId: knowledge.knowledgeBaseId,
    storageId: knowledge.id,
    type: "knowledge"
  };
  const assistant = await db.projectAssistantBinding.findFirst({
    include: { revision: { select: { name: true } } },
    where: { id: bindingId, projectId }
  });
  if (assistant) return {
    bindingId,
    label: assistant.revision.name,
    resourceId: assistant.assistantId,
    storageId: assistant.id,
    type: "assistant"
  };
  const skill = await db.projectSkillBinding.findFirst({
    include: { skill: { include: { currentRevision: { select: { name: true } } } } },
    where: { id: bindingId, projectId }
  });
  return skill ? {
    bindingId,
    label: skill.skill.currentRevision?.name ?? "Unavailable Skill",
    resourceId: skill.skillId,
    storageId: skill.id,
    type: "skill"
  } : null;
}

async function projectBoundKnowledgeSourceIds(
  db: ProjectDataClient,
  projectId: string,
  excludingKnowledgeBaseId?: string
): Promise<ReadonlySet<string>> {
  const bindings = await db.projectKnowledgeBaseBinding.findMany({
    select: {
      knowledgeBase: {
        select: {
          activeIndexGeneration: {
            select: { profileRevisionId: true, status: true }
          },
          sourceMemberships: {
            select: {
              source: {
                select: {
                  currentVersion: {
                    select: {
                      artifacts: {
                        select: {
                          hierarchicalIndexes: {
                            orderBy: { schemaVersion: "desc" },
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
    },
    where: {
      projectId,
      knowledgeBase: {
        archivedAt: null,
        deletionRequestedAt: null,
        trashedAt: null
      },
      ...(excludingKnowledgeBaseId
        ? { knowledgeBaseId: { not: excludingKnowledgeBaseId } }
        : {})
    }
  });
  const sourceIds = new Set<string>();
  for (const { knowledgeBase } of bindings) {
    const generation = knowledgeBase.activeIndexGeneration;
    if (generation?.status !== "active" || !generation.profileRevisionId) continue;
    for (const membership of knowledgeBase.sourceMemberships) {
      const ready = membership.source.currentVersion?.artifacts.some((artifact) =>
        artifact.profileRevisionId === generation.profileRevisionId && artifact.state === "ready" &&
        artifact.hierarchicalIndexes.some((hierarchy) => hierarchy.state === "ready"));
      if (ready) sourceIds.add(membership.sourceId);
    }
  }
  return sourceIds;
}

async function dependentAssistantBindings(
  db: ProjectDataClient,
  input: Readonly<{ projectId: string; resourceId: string; type: ProjectResourceTypeWire }>
) {
  if (!(["model", "search", "knowledge", "mcp", "skill"] as const).includes(
    input.type as "model" | "search" | "knowledge" | "mcp" | "skill"
  )) return [];
  const bindings = await db.projectAssistantBinding.findMany({
    include: {
      revision: {
        select: {
          knowledgeSelection: true,
          mcpServerIds: true,
          name: true,
          providerModelId: true,
          searchPlan: true,
          skillLinks: { select: { skillId: true } }
        }
      }
    },
    where: { projectId: input.projectId }
  });
  const remainingKnowledgeSourceIds = input.type === "knowledge"
    ? await projectBoundKnowledgeSourceIds(db, input.projectId, input.resourceId)
    : new Set<string>();
  return bindings.filter((binding) => {
    const revision = binding.revision;
    const knowledge = decodeKnowledgePlan(revision.knowledgeSelection);
    return input.type === "model" && revision.providerModelId === input.resourceId ||
      input.type === "knowledge" && knowledge.ok && (
        knowledge.plan.baseIds.includes(input.resourceId) ||
        knowledge.plan.sourceIds.some((sourceId) => !remainingKnowledgeSourceIds.has(sourceId))
      ) ||
      input.type === "mcp" && revision.mcpServerIds.includes(input.resourceId) ||
      input.type === "search" && searchOptionIds(revision.searchPlan).includes(input.resourceId) ||
      input.type === "skill" && revision.skillLinks.some((link) => link.skillId === input.resourceId);
  });
}

async function hasUsableProjectMcp(
  db: ProjectDataClient,
  projectId: string,
  excludingServerId?: string
): Promise<boolean> {
  const bindings = await db.projectMcpBinding.findMany({
    include: { server: { include: { activeRevision: { select: { configuration: true } } } } },
    where: {
      projectId,
      ...(excludingServerId ? { serverId: { not: excludingServerId } } : {}),
      server: {
        activeRevisionId: { not: null },
        archivedAt: null,
        enabled: true
      }
    }
  });
  return bindings.some(({ server }) => Boolean(server.sharedConfigEnvelope) || Boolean(
    server.activeRevision && mcpRevisionUsesNoAuth(server.activeRevision.configuration)
  ));
}

function defaultsAfterResourceRemoval(
  defaults: ProjectDefaultsWire,
  input: Readonly<{
    dependentAssistantIds: ReadonlySet<string>;
    hasRemainingMcp: boolean;
    remainingKnowledgeSourceIds: ReadonlySet<string>;
    resourceId: string;
    type: ProjectResourceTypeWire;
  }>
): ProjectDefaultsWire {
  return {
    ...defaults,
    assistantId: defaults.assistantId && (
      input.type === "assistant" && defaults.assistantId === input.resourceId ||
      input.dependentAssistantIds.has(defaults.assistantId)
    ) ? null : defaults.assistantId,
    knowledgePlan: explicitKnowledgeSelection({
      baseIds: input.type === "knowledge"
        ? defaults.knowledgePlan.baseIds.filter((id) => id !== input.resourceId)
        : [...defaults.knowledgePlan.baseIds],
      sourceIds: input.type === "knowledge"
        ? defaults.knowledgePlan.sourceIds.filter((id) =>
            input.remainingKnowledgeSourceIds.has(id))
        : defaults.knowledgePlan.sourceIds
    }),
    mcpMode: input.type === "mcp" && !input.hasRemainingMcp ? "off" : defaults.mcpMode,
    providerModelId: input.type === "model" && defaults.providerModelId === input.resourceId
      ? null
      : defaults.providerModelId,
    searchPlan: input.type === "search"
      ? { ...defaults.searchPlan, optionIds: defaults.searchPlan.optionIds.filter((id) => id !== input.resourceId) }
      : defaults.searchPlan
  };
}

async function resourceRemovalConsequences(
  db: ProjectDataClient,
  input: Readonly<{ projectId: string; resource: BoundProjectResource }>
) {
  const project = await db.project.findUnique({ select: { defaults: true }, where: { id: input.projectId } });
  if (!project) return null;
  const decoded = decodeProjectDefaults(project.defaults);
  const defaults = decoded.ok ? decoded.defaults : EMPTY_PROJECT_DEFAULTS;
  const dependents = await dependentAssistantBindings(db, {
    projectId: input.projectId,
    resourceId: input.resource.resourceId,
    type: input.resource.type
  });
  const hasRemainingMcp = input.resource.type !== "mcp" || await hasUsableProjectMcp(
    db,
    input.projectId,
    input.resource.storageId
  );
  const remainingKnowledgeSourceIds = input.resource.type === "knowledge"
    ? await projectBoundKnowledgeSourceIds(db, input.projectId, input.resource.resourceId)
    : new Set(defaults.knowledgePlan.sourceIds);
  const dependentAssistantIds = new Set(dependents.map((binding) => binding.assistantId));
  const next = defaultsAfterResourceRemoval(defaults, {
    dependentAssistantIds,
    hasRemainingMcp,
    remainingKnowledgeSourceIds,
    resourceId: input.resource.resourceId,
    type: input.resource.type
  });
  const clearedDefaults: string[] = [];
  if (defaults.providerModelId !== next.providerModelId) clearedDefaults.push("Project default model");
  if (defaults.assistantId !== next.assistantId) clearedDefaults.push("Project default Assistant");
  if (defaults.knowledgePlan.baseIds.length !== next.knowledgePlan.baseIds.length ||
    defaults.knowledgePlan.sourceIds.length !== next.knowledgePlan.sourceIds.length) {
    clearedDefaults.push("Project default Knowledge");
  }
  if (defaults.searchPlan.optionIds.length !== next.searchPlan.optionIds.length) {
    clearedDefaults.push("Project default Search");
  }
  if (defaults.mcpMode !== next.mcpMode) clearedDefaults.push("Project default MCP mode");
  let affectedChatCount = 0;
  if (input.resource.type === "model") {
    affectedChatCount = await db.chat.count({
      where: { defaultProviderModelId: input.resource.resourceId, projectId: input.projectId }
    });
  } else if (input.resource.type === "knowledge") {
    const chats = await db.chat.findMany({
      select: { defaultKnowledgePlan: true },
      where: { projectId: input.projectId }
    });
    affectedChatCount = chats.filter((chat) => {
      const plan = chat.defaultKnowledgePlan === null
        ? null
        : decodeKnowledgePlan(chat.defaultKnowledgePlan);
      return plan?.ok === true && plan.plan.mode !== "all_my_knowledge" &&
        plan.plan.mode !== "inherited" && (
          plan.plan.baseIds.includes(input.resource.resourceId) ||
          plan.plan.sourceIds.some((sourceId) => !remainingKnowledgeSourceIds.has(sourceId))
        );
    }).length;
  }
  return {
    affectedChatCount,
    clearedDefaults,
    dependentAssistantIds,
    dependentAssistants: dependents.map((binding) => binding.revision.name),
    hasRemainingMcp,
    remainingKnowledgeSourceIds,
    next
  };
}

async function cleanupResourceReferences(
  tx: Prisma.TransactionClient,
  input: Readonly<{ projectId: string; resourceId: string; type: ProjectResourceTypeWire }>
) {
  const resource: BoundProjectResource = {
    bindingId: "",
    label: "",
    resourceId: input.resourceId,
    storageId: input.resourceId,
    type: input.type
  };
  const consequences = await resourceRemovalConsequences(tx, { projectId: input.projectId, resource });
  if (!consequences) return null;
  const next = consequences.next;
  const project = await tx.project.findUnique({ select: { defaults: true }, where: { id: input.projectId } });
  if (!project) return null;
  const decoded = decodeProjectDefaults(project.defaults);
  const defaults = decoded.ok ? decoded.defaults : EMPTY_PROJECT_DEFAULTS;
  if (!decoded.ok || JSON.stringify(next) !== JSON.stringify(defaults)) {
    await tx.project.update({
      data: {
        defaults: next as unknown as Prisma.InputJsonValue
      },
      where: { id: input.projectId }
    });
  }
  if (input.type === "model") {
    await tx.chat.updateMany({
      data: { defaultProviderModelId: null },
      where: { defaultProviderModelId: input.resourceId, projectId: input.projectId }
    });
  }
  if (input.type === "knowledge") {
    const chats = await tx.chat.findMany({
      select: { defaultKnowledgePlan: true, id: true },
      where: { projectId: input.projectId }
    });
    for (const chat of chats) {
      if (chat.defaultKnowledgePlan === null) continue;
      const decodedPlan = decodeKnowledgePlan(chat.defaultKnowledgePlan);
      if (!decodedPlan.ok || decodedPlan.plan.mode === "all_my_knowledge" ||
        decodedPlan.plan.mode === "inherited") continue;
      const nextPlan = explicitKnowledgeSelection({
        baseIds: decodedPlan.plan.baseIds.filter((id) => id !== input.resourceId),
        sourceIds: decodedPlan.plan.sourceIds.filter((id) =>
          consequences.remainingKnowledgeSourceIds.has(id))
      });
      if (JSON.stringify(nextPlan) !== JSON.stringify(decodedPlan.plan)) {
        await tx.chat.update({
          data: { defaultKnowledgePlan: nextPlan as unknown as Prisma.InputJsonValue },
          where: { id: chat.id }
        });
      }
    }
  }
  if (consequences.dependentAssistantIds.size > 0) {
    await tx.projectAssistantBinding.deleteMany({
      where: {
        assistantId: { in: [...consequences.dependentAssistantIds] },
        projectId: input.projectId
      }
    });
  }
  return consequences;
}

function canManageGrant(
  actorRole: ProjectRole,
  oldRole: ProjectRole | null,
  newRole: ProjectRole | null
): boolean {
  if (!projectRoleAtLeast(actorRole, "MANAGER")) return false;
  if (actorRole === "OWNER") return true;
  return ![oldRole, newRole].some((role) => role === "MANAGER" || role === "OWNER");
}

function knownConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2003", "P2004", "P2025", "P2034"].includes(error.code);
}

async function publishProjectResult<Value>(
  projectId: string,
  operation: Promise<ProjectRepositoryResult<Value | undefined>>
): Promise<ProjectRepositoryResult<Value>> {
  const result = await operation;
  if (result.kind === "ok") {
    if (result.value === undefined) return { kind: "not_found" };
    notifyProjectEvent(projectId);
    return { kind: "ok", value: result.value };
  }
  return result;
}

export function createPrismaProjectRepository(prisma: PrismaClient) {
  async function eligibleProjectModels(
    db: PrismaClient | Prisma.TransactionClient,
    preferredModelId?: string
  ) {
    const models = (await db.providerModel.findMany({
      include: {
        connection: {
          include: {
            defaultCredential: { include: { activeVersion: true } }
          }
        }
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        enabled: true,
        modelClass: "answer",
        connection: {
          activeConfig: { not: Prisma.DbNull },
          activeVersion: { gt: 0 },
          enabled: true,
          OR: [
            { family: "fake" },
            {
              defaultCredential: {
                enabled: true,
                activeVersion: { is: { revokedAt: null } }
              }
            }
          ]
        }
      }
    })).filter(eligibleProjectAnswerModel);
    const preferred = preferredModelId ? models.find((model) => model.id === preferredModelId) : undefined;
    if (preferred) return [preferred, ...models.filter((model) => model.id !== preferred.id)];
    const policy = await db.modelPolicy.findUnique({ select: { defaultProviderModelId: true }, where: { id: "installation" } });
    const configured = policy?.defaultProviderModelId
      ? models.find((model) => model.id === policy.defaultProviderModelId)
      : undefined;
    return configured
      ? [configured, ...models.filter((model) => model.id !== configured.id)]
      : models;
  }

  async function assistantResourcePlan(
    db: ProjectDataClient,
    input: Readonly<{ projectId: string; resourceId: string; userId: string }>
  ) {
    const target = await db.assistantDefinition.findFirst({
      include: {
        currentRevision: { include: { skillLinks: { select: { skillId: true } } } }
      },
      where: {
        archivedAt: null,
        id: input.resourceId,
        ownerUserId: input.userId
      }
    });
    const revision = target?.currentRevision ?? null;
    if (!target || !revision) return null;

    const requiredSearchIds = [...new Set(searchOptionIds(revision.searchPlan))];
    const knowledge = decodeKnowledgePlan(revision.knowledgeSelection);
    if (!knowledge.ok || knowledge.plan.mode === "all_my_knowledge" ||
      knowledge.plan.mode === "inherited") return null;
    const requiredKnowledgeIds = [...new Set(knowledge.plan.baseIds)];
    const requiredKnowledgeSourceIds = [...new Set(knowledge.plan.sourceIds)];
    const requiredSkillIds = [...new Set(revision.skillLinks.map((link) => link.skillId))];
    const requiredMcpIds = [...new Set(revision.mcpServerIds)];
    const [
      eligibleModels,
      searchOptions,
      knowledgeBases,
      knowledgeSources,
      skills,
      mcpServers,
      activeModels,
      activeSearch,
      activeKnowledge,
      activeKnowledgeSources,
      activeSkills,
      activeMcp
    ] = await Promise.all([
      eligibleProjectModels(db),
      requiredSearchIds.length > 0
        ? db.searchOption.findMany({
            select: { displayName: true, id: true, optionId: true },
            where: {
              archivedAt: null,
              enabled: true,
              optionId: { in: requiredSearchIds },
              sourceConnection: {
                is: {
                  activeConfig: { not: Prisma.DbNull },
                  activeVersion: { gt: 0 },
                  enabled: true,
                  OR: [
                    { family: "fake" },
                    {
                      defaultCredential: {
                        enabled: true,
                        activeVersion: { is: { revokedAt: null } }
                      }
                    }
                  ]
                }
              },
              strategies: {
                some: { activeRevisionId: { not: null }, archivedAt: null, enabled: true }
              }
            }
          })
        : Promise.resolve([]),
      requiredKnowledgeIds.length > 0
        ? db.knowledgeBase.findMany({
            include: {
              activeIndexGeneration: {
                include: {
                  embeddingProviderModel: {
                    include: {
                      connection: {
                        include: { defaultCredential: { include: { activeVersion: true } } }
                      }
                    }
                  },
                  profileRevision: { select: { id: true } }
                }
              }
            },
            orderBy: { id: "asc" },
            where: {
              archivedAt: null,
              deletionRequestedAt: null,
              trashedAt: null,
              AND: [
                {
                  OR: [
                    { ownerUserId: input.userId },
                    { projectBindings: { some: { projectId: input.projectId } } }
                  ]
                },
                {
                  id: { in: requiredKnowledgeIds }
                }
              ]
            }
          })
        : Promise.resolve([]),
      requiredKnowledgeSourceIds.length > 0
        ? db.knowledgeSource.findMany({
            orderBy: { id: "asc" },
            select: {
              currentVersion: {
                select: {
                  artifacts: {
                    select: {
                      hierarchicalIndexes: {
                        orderBy: { schemaVersion: "desc" },
                        select: { state: true },
                        take: 1
                      },
                      profileRevisionId: true,
                      state: true
                    },
                    where: activeProjectSourceArtifactWhere
                  },
                  id: true
                }
              },
              id: true,
              name: true
            },
            where: {
              deletionRequestedAt: null,
              id: { in: requiredKnowledgeSourceIds },
              OR: [
                { ownerUserId: input.userId },
                { projectBindings: { some: { projectId: input.projectId } } }
              ],
              trashedAt: null
            }
          })
        : Promise.resolve([]),
      requiredSkillIds.length > 0
        ? db.skillDefinition.findMany({
            include: { currentRevision: { select: { name: true } } },
            where: {
              archivedAt: null,
              currentRevisionId: { not: null },
              deletedAt: null,
              id: { in: requiredSkillIds },
              OR: [
                { ownerUserId: input.userId },
                { projectBindings: { some: { projectId: input.projectId } } }
              ]
            }
          })
        : Promise.resolve([]),
      requiredMcpIds.length > 0
        ? db.mcpServer.findMany({
            include: { activeRevision: { select: { configuration: true } } },
            where: {
              activeRevisionId: { not: null },
              archivedAt: null,
              enabled: true,
              id: { in: requiredMcpIds }
            }
          })
        : Promise.resolve([]),
      db.projectModelBinding.findMany({
        select: { providerModelId: true }, where: { projectId: input.projectId }
      }),
      db.projectSearchBinding.findMany({
        select: { searchOptionId: true }, where: { projectId: input.projectId }
      }),
      db.projectKnowledgeBaseBinding.findMany({
        select: { knowledgeBaseId: true }, where: { projectId: input.projectId }
      }),
      requiredKnowledgeSourceIds.length > 0
        ? db.projectKnowledgeSourceBinding.findMany({
            select: { sourceId: true },
            where: {
              projectId: input.projectId,
              sourceId: { in: requiredKnowledgeSourceIds }
            }
          })
        : Promise.resolve([]),
      db.projectSkillBinding.findMany({
        select: { skillId: true }, where: { projectId: input.projectId }
      }),
      db.projectMcpBinding.findMany({
        select: { serverId: true }, where: { projectId: input.projectId }
      })
    ]);

    const active = {
      knowledge: new Set(activeKnowledge.map((binding) => binding.knowledgeBaseId)),
      knowledgeSource: new Set(activeKnowledgeSources.map((binding) => binding.sourceId)),
      mcp: new Set(activeMcp.map((binding) => binding.serverId)),
      model: new Set(activeModels.map((binding) => binding.providerModelId)),
      search: new Set(activeSearch.map((binding) => binding.searchOptionId)),
      skill: new Set(activeSkills.map((binding) => binding.skillId))
    };
    const dependencies: ProjectResourceDependencyPreviewWire[] = [];
    const model = eligibleModels.find((entry) => entry.id === revision.providerModelId);
    dependencies.push(model ? {
      label: model.displayName,
      reason: null,
      state: active.model.has(model.id) ? "active" : "will_add",
      type: "model"
    } : {
      label: "Required answer model",
      reason: "Not available to Projects with an active shared installation credential.",
      state: "ineligible",
      type: "model"
    });

    const searchByOptionId = new Map(searchOptions.map((option) => [option.optionId, option]));
    for (const optionId of requiredSearchIds) {
      const option = searchByOptionId.get(optionId);
      dependencies.push(option ? {
        label: option.displayName,
        reason: null,
        state: active.search.has(option.id) ? "active" : "will_add",
        type: "search"
      } : {
        label: "Required Search integration",
        reason: "Not available to Projects with an active shared installation credential.",
        state: "ineligible",
        type: "search"
      });
    }

    const eligibleKnowledgeIds = new Set<string>();
    for (const base of knowledgeBases) {
      const generation = base?.activeIndexGeneration;
      const embedding = generation?.embeddingProviderModel;
      const connection = embedding?.connection;
      const eligible = Boolean(base && generation?.status === "active" && embedding && connection &&
        embedding.enabled && embedding.modelClass === "embedding" &&
        embedding.activeConfig !== null && embedding.activeVersion > 0 &&
        connection.family !== "fake" &&
        connection.enabled && connection.activeConfig !== null && connection.activeVersion > 0 && Boolean(
          connection.defaultCredential?.enabled &&
          connection.defaultCredential.activeVersion?.revokedAt === null
        ));
      if (base && eligible) eligibleKnowledgeIds.add(base.id);
    }
    const knowledgeById = new Map(knowledgeBases.map((base) => [base.id, base]));
    for (const baseId of requiredKnowledgeIds) {
      const base = knowledgeById.get(baseId);
      const eligible = Boolean(base && eligibleKnowledgeIds.has(base.id));
      dependencies.push(base && eligible ? {
        label: base.name,
        reason: null,
        state: active.knowledge.has(base.id) ? "active" : "will_add",
        type: "knowledge"
      } : {
        label: base?.name ?? "Required Knowledge Base",
        reason: "Not publishable with an active shared embedding configuration.",
        state: "ineligible",
        type: "knowledge"
      });
    }
    const eligibleKnowledgeSourceIds = new Set(knowledgeSources.flatMap((source) =>
      source.currentVersion?.artifacts.some((artifact) =>
        artifact.state === "ready" &&
        artifact.hierarchicalIndexes.some((hierarchy) => hierarchy.state === "ready"))
        ? [source.id]
        : []));
    const knowledgeSourceById = new Map(knowledgeSources.map((source) => [source.id, source]));
    for (const sourceId of requiredKnowledgeSourceIds) {
      const source = knowledgeSourceById.get(sourceId);
      const eligible = Boolean(source && eligibleKnowledgeSourceIds.has(source.id));
      dependencies.push(source && eligible ? {
        label: source.name,
        reason: null,
        state: active.knowledgeSource.has(source.id) ? "active" : "will_add",
        type: "knowledge"
      } : {
        label: source?.name ?? "Required Knowledge Source",
        reason: "Not publishable as a ready Source for the active installation Knowledge Profile.",
        state: "ineligible",
        type: "knowledge"
      });
    }

    const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
    for (const skillId of requiredSkillIds) {
      const skill = skillsById.get(skillId);
      dependencies.push(skill ? {
        label: skill.currentRevision?.name ?? "Skill",
        reason: null,
        state: active.skill.has(skill.id) ? "active" : "will_add",
        type: "skill"
      } : {
        label: "Required Skill",
        reason: "Not publishable by this Project manager.",
        state: "ineligible",
        type: "skill"
      });
    }

    const mcpById = new Map(mcpServers.map((server) => [server.id, server]));
    const eligibleMcpIds = new Set<string>();
    for (const serverId of requiredMcpIds) {
      const server = mcpById.get(serverId);
      const eligible = Boolean(server && (
        server.sharedConfigEnvelope ||
        server.activeRevision && mcpRevisionUsesNoAuth(server.activeRevision.configuration)
      ));
      if (server && eligible) eligibleMcpIds.add(server.id);
      dependencies.push(server && eligible ? {
        label: server.displayName,
        reason: null,
        state: active.mcp.has(server.id) ? "active" : "will_add",
        type: "mcp"
      } : {
        label: server?.displayName ?? "Required MCP server",
        reason: "An active shared or no-auth Project configuration is required.",
        state: "ineligible",
        type: "mcp"
      });
    }

    return {
      canCommit: dependencies.every((dependency) => dependency.state !== "ineligible"),
      dependencies,
      knowledgeBases: knowledgeBases.filter((base) =>
        eligibleKnowledgeIds.has(base.id) && requiredKnowledgeIds.includes(base.id)),
      knowledgeSources: knowledgeSources.filter((source) =>
        eligibleKnowledgeSourceIds.has(source.id)),
      mcpServers: mcpServers.filter((server) => eligibleMcpIds.has(server.id)),
      revision,
      searchOptions,
      skills,
      target
    };
  }

  async function grantRemovalImpact(
    db: ProjectDataClient,
    projectId: string,
    grantId: string
  ) {
    const grants = await db.projectGrant.findMany({
      include: {
        group: {
          include: {
            users: {
              select: { userId: true },
              where: { user: { status: "active" } }
            }
          }
        },
        user: { select: { displayName: true, id: true, status: true } }
      },
      where: { projectId }
    });
    const target = grants.find((grant) => grant.id === grantId);
    if (!target) return null;
    const rolesByUser = new Map<string, Array<{ grantId: string; role: ProjectRole }>>();
    for (const grant of grants) {
      const userIds = grant.user?.status === "active"
        ? [grant.user.id]
        : grant.group && !grant.group.archivedAt
          ? grant.group.users.map(({ userId }) => userId)
          : [];
      for (const userId of userIds) {
        const roles = rolesByUser.get(userId) ?? [];
        roles.push({ grantId: grant.id, role: grant.role });
        rolesByUser.set(userId, roles);
      }
    }
    const targetUsers = target.user?.status === "active"
      ? [target.user.id]
      : target.group && !target.group.archivedAt
        ? target.group.users.map(({ userId }) => userId)
        : [];
    let losesAccessCount = 0;
    let roleChangeCount = 0;
    for (const userId of targetUsers) {
      const current = highestProjectRole((rolesByUser.get(userId) ?? []).map(({ role }) => role));
      const next = highestProjectRole((rolesByUser.get(userId) ?? [])
        .filter((entry) => entry.grantId !== target.id)
        .map(({ role }) => role));
      if (!next) losesAccessCount += 1;
      else if (next !== current) roleChangeCount += 1;
    }
    return {
      grant: target,
      label: target.user?.displayName ?? target.group?.name ?? "Unavailable principal",
      losesAccessCount,
      roleChangeCount
    };
  }

  async function getDetail(userId: string, projectId: string): Promise<ProjectDetailWire | null> {
    const access = await resolveProjectAccess(prisma, { projectId, userId });
    if (!access) return null;
    const row = await prisma.project.findUnique({ include: projectDetailInclude, where: { id: projectId } });
    return row ? detail(row, access, await effectiveAudienceCount(prisma, projectId)) : null;
  }

  return {
    async list(userId: string): Promise<ProjectSummaryWire[] | null> {
      const user = await prisma.user.findFirst({
        select: {
          groups: { select: { groupId: true }, where: { group: { archivedAt: null } } },
          id: true
        },
        where: { id: userId, status: "active" }
      });
      if (!user) return null;
      const activeGroupIds = new Set(user.groups.map(({ groupId }) => groupId));
      const rows = await prisma.project.findMany({
        include: projectListInclude,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        where: {
          grants: {
            some: {
              OR: [
                { userId },
                ...(activeGroupIds.size > 0 ? [{ groupId: { in: [...activeGroupIds] } }] : [])
              ]
            }
          },
          status: { not: "DELETING" }
        }
      });
      const counts = await Promise.all(rows.map((row) => effectiveAudienceCount(prisma, row.id)));
      return rows.flatMap((row, index) => {
        const value = summary(row, { activeGroupIds, audienceCount: counts[index], userId });
        return value ? [value] : [];
      });
    },

    getDetail,

    async candidates(input: {
      cursor?: string;
      limit: number;
      projectId: string;
      query: string;
      type: ProjectCandidateTypeWire;
      userId: string;
    }): Promise<ProjectCandidatesResponseWire | null> {
      const access = await resolveProjectAccess(prisma, {
        minimumRole: "MANAGER",
        projectId: input.projectId,
        requireActive: true,
        userId: input.userId
      });
      if (!access) return null;
      const offset = input.cursor && /^\d+$/u.test(input.cursor) ? Number(input.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) return null;
      const take = Math.min(Math.max(input.limit, 1), 50) + 1;
      const contains = input.query.trim();
      const existingGrants = input.type === "user" || input.type === "group"
        ? await prisma.projectGrant.findMany({
            include: { group: { select: { name: true } } },
            where: { projectId: input.projectId }
          })
        : [];
      const directGrants = new Map(existingGrants.flatMap((grant) =>
        grant.userId ? [[grant.userId, grant.role] as const] : []
      ));
      const groupGrants = new Map(existingGrants.flatMap((grant) =>
        grant.groupId && grant.group
          ? [[grant.groupId, { name: grant.group.name, role: grant.role }] as const]
          : []
      ));
      const linkedResourceIds = new Set<string>(
        input.type === "model"
          ? (await prisma.projectModelBinding.findMany({
              select: { providerModelId: true }, where: { projectId: input.projectId }
            })).map((binding) => binding.providerModelId)
          : input.type === "search"
            ? (await prisma.projectSearchBinding.findMany({
                select: { searchOptionId: true }, where: { projectId: input.projectId }
              })).map((binding) => binding.searchOptionId)
            : input.type === "knowledge"
              ? (await prisma.projectKnowledgeBaseBinding.findMany({
                  select: { knowledgeBaseId: true }, where: { projectId: input.projectId }
                })).map((binding) => binding.knowledgeBaseId)
              : input.type === "assistant"
                ? (await prisma.projectAssistantBinding.findMany({
                    select: { assistantId: true }, where: { projectId: input.projectId }
                  })).map((binding) => binding.assistantId)
                : input.type === "skill"
                  ? (await prisma.projectSkillBinding.findMany({
                      select: { skillId: true }, where: { projectId: input.projectId }
                    })).map((binding) => binding.skillId)
                  : input.type === "mcp"
                    ? (await prisma.projectMcpBinding.findMany({
                        select: { serverId: true }, where: { projectId: input.projectId }
                      })).map((binding) => binding.serverId)
                    : []
      );
      let items: ProjectCandidateWire[] = [];
      if (input.type === "user") {
        const rows = await prisma.user.findMany({
          orderBy: [{ displayName: "asc" }, { id: "asc" }],
          select: {
            displayName: true,
            email: true,
            groups: {
              select: { groupId: true },
              where: { groupId: { in: [...groupGrants.keys()] } }
            },
            id: true
          },
          skip: offset,
          take,
          where: {
            status: "active",
            ...(contains ? { OR: [
              { displayName: { contains, mode: "insensitive" } },
              { email: { contains, mode: "insensitive" } }
            ] } : {})
          }
        });
        items = rows.map((row) => {
          const sources = row.groups.flatMap(({ groupId }) => {
            const grant = groupGrants.get(groupId);
            return grant ? [`${grant.name} (${grant.role.toLowerCase()})`] : [];
          });
          return {
            description: [row.email, sources.length ? `Current via ${sources.join(", ")}` : null]
              .filter(Boolean)
              .join(" · "),
            disabledReason: directGrants.has(row.id) ? "already_has_direct_access" : null,
            id: row.id,
            label: row.displayName,
            type: "user" as const
          };
        });
      } else if (input.type === "group") {
        const rows = await prisma.group.findMany({
          orderBy: [{ name: "asc" }, { id: "asc" }],
          select: {
            _count: { select: { users: { where: { user: { status: "active" } } } } },
            id: true,
            name: true
          },
          skip: offset,
          take,
          where: { archivedAt: null, ...(contains ? { name: { contains, mode: "insensitive" } } : {}) }
        });
        items = rows.map((row) => ({
          description: `${row._count.users} active ${row._count.users === 1 ? "member" : "members"}`,
          disabledReason: groupGrants.has(row.id) ? "already_has_group_access" : null,
          id: row.id,
          label: row.name,
          type: "group"
        }));
      } else if (input.type === "model") {
        const rows = await eligibleProjectModels(prisma);
        items = rows.filter((row) => !contains || row.displayName.toLocaleLowerCase().includes(contains.toLocaleLowerCase()))
          .slice(offset, offset + take)
          .map((row) => ({
            description: row.modelId,
            disabledReason: linkedResourceIds.has(row.id) ? "already_linked_to_project" : null,
            id: row.id,
            label: row.displayName,
            type: "model"
          }));
      } else if (input.type === "search") {
        const rows = await prisma.searchOption.findMany({
          orderBy: [{ displayName: "asc" }, { id: "asc" }],
          select: {
            description: true,
            displayName: true,
            id: true,
            sourceConnection: {
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
            }
          },
          skip: offset,
          take,
          where: {
            archivedAt: null,
            enabled: true,
            sourceConnection: {
              is: {
                activeConfig: { not: Prisma.DbNull },
                activeVersion: { gt: 0 },
                enabled: true,
                OR: [
                  { family: "fake" },
                  {
                    defaultCredential: {
                      enabled: true,
                      activeVersion: { is: { revokedAt: null } }
                    }
                  }
                ]
              }
            },
            strategies: {
              some: { activeRevisionId: { not: null }, archivedAt: null, enabled: true }
            },
            ...(contains ? { displayName: { contains, mode: "insensitive" } } : {})
          }
        });
        items = rows.filter((row) =>
          Boolean(row.sourceConnection) && activeSharedProjectConnection(row.sourceConnection!)
        ).map((row) => ({
          description: row.description || null,
          disabledReason: linkedResourceIds.has(row.id) ? "already_linked_to_project" : null,
          id: row.id,
          label: row.displayName,
          type: "search"
        }));
      } else if (input.type === "knowledge") {
        const rows = await prisma.knowledgeBase.findMany({
          include: {
            activeIndexGeneration: {
              include: {
                embeddingProviderModel: {
                  include: {
                    connection: {
                      include: { defaultCredential: { include: { activeVersion: true } } }
                    }
                  }
                }
              }
            }
          },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: offset,
          take,
          where: {
            archivedAt: null,
            deletionRequestedAt: null,
            ownerUserId: input.userId,
            trashedAt: null,
            ...(contains ? { name: { contains, mode: "insensitive" } } : {})
          }
        });
        items = rows.map((row) => {
          const embeddingEligible = eligibleProjectKnowledgeBase(row);
          return {
            description: row.description || null,
            disabledReason: linkedResourceIds.has(row.id)
              ? "already_linked_to_project"
              : embeddingEligible ? null : "shared_embedding_required",
            id: row.id,
            label: row.name,
            type: "knowledge" as const
          };
        });
      } else if (input.type === "assistant") {
        const rows = await prisma.assistantDefinition.findMany({
          include: { currentRevision: true },
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          skip: offset,
          take,
          where: {
            archivedAt: null,
            currentRevisionId: { not: null },
            ownerUserId: input.userId,
            ...(contains ? { currentRevision: { is: { name: { contains, mode: "insensitive" } } } } : {})
          }
        });
        items = rows.flatMap((row) => row.currentRevision ? [{
          description: row.currentRevision.description || null,
          disabledReason: linkedResourceIds.has(row.id) ? "already_linked_to_project" : null,
          id: row.id,
          label: row.currentRevision.name,
          type: "assistant" as const
        }] : []);
      } else if (input.type === "skill") {
        const rows = await prisma.skillDefinition.findMany({
          include: { currentRevision: true },
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          skip: offset,
          take,
          where: {
            archivedAt: null,
            currentRevisionId: { not: null },
            deletedAt: null,
            ownerUserId: input.userId,
            ...(contains ? { currentRevision: { is: { name: { contains, mode: "insensitive" } } } } : {})
          }
        });
        items = rows.flatMap((row) => row.currentRevision ? [{
          description: row.currentRevision.description || null,
          disabledReason: linkedResourceIds.has(row.id) ? "already_linked_to_project" : null,
          id: row.id,
          label: row.currentRevision.name,
          type: "skill" as const
        }] : []);
      } else {
        const rows = await prisma.mcpServer.findMany({
          include: { activeRevision: { select: { configuration: true } } },
          orderBy: [{ displayName: "asc" }, { id: "asc" }],
          skip: offset,
          take,
          where: {
            activeRevisionId: { not: null },
            archivedAt: null,
            enabled: true,
            ...(contains ? { displayName: { contains, mode: "insensitive" } } : {})
          }
        });
        items = rows.map((row) => {
          const config = row.activeRevision?.configuration;
          const auth = typeof config === "object" && config !== null && !Array.isArray(config) &&
            "auth" in config && typeof config.auth === "object" && config.auth !== null && "mode" in config.auth
            ? config.auth.mode : null;
          return {
            description: row.description || null,
            disabledReason: linkedResourceIds.has(row.id)
              ? "already_linked_to_project"
              : row.sharedConfigEnvelope || auth === "none" ? null : "shared_configuration_required",
            id: row.id,
            label: row.displayName,
            type: "mcp" as const
          };
        });
      }
      const hasMore = items.length > input.limit;
      const page = items.slice(0, input.limit);
      return {
        items: page,
        nextCursor: hasMore ? String(offset + page.length) : null
      };
    },

    async create(input: {
      actorDisplayName: string;
      description: string;
      name: string;
      preferredModelId?: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectDetailWire>> {
      try {
        const projectId = await prisma.$transaction(async (tx) => {
          const user = await tx.user.findFirst({
            select: { id: true },
            where: { id: input.userId, status: "active" }
          });
          if (!user) return null;
          const candidates = await eligibleProjectModels(tx, input.preferredModelId);
          const selectedModel = candidates[0] ?? null;
          const defaults = selectedModel
            ? { ...EMPTY_PROJECT_DEFAULTS, providerModelId: selectedModel.id }
            : EMPTY_PROJECT_DEFAULTS;
          const project = await tx.project.create({
            data: {
              createdByDisplayName: input.actorDisplayName,
              createdByUserId: input.userId,
              defaults: defaults as unknown as Prisma.InputJsonValue,
              description: input.description,
              name: input.name,
              policy: DEFAULT_PROJECT_POLICY as unknown as Prisma.InputJsonValue
            },
            select: { id: true }
          });
          await tx.projectGrant.create({
            data: {
              createdByUserId: input.userId,
              projectId: project.id,
              role: "OWNER",
              userId: input.userId
            }
          });
          if (selectedModel) {
            await tx.projectModelBinding.create({
              data: {
                addedByUserId: input.userId,
                projectId: project.id,
                providerModelId: selectedModel.id
              }
            });
          }
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "project_created",
              projectId: project.id
            })
          });
          return project.id;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (!projectId) return { kind: "not_found" };
        notifyProjectEvent(projectId);
        const value = await getDetail(input.userId, projectId);
        return value ? { kind: "ok", value } : { kind: "not_found" };
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_create_conflict" };
        throw error;
      }
    },

    async update(input: {
      actorDisplayName: string;
      defaults?: ProjectDefaultsWire;
      description?: string;
      expectedAccessRevision?: number;
      expectedInstructionsRevision?: number;
      expectedMemoryRevision?: number;
      expectedPolicyRevision?: number;
      instructions?: string;
      memoryEnabled?: boolean;
      name?: string;
      policy?: ProjectPolicyWire;
      projectId: string;
      publicSharingEnabled?: boolean;
      status?: "ACTIVE" | "ARCHIVED";
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectDetailWire>> {
      try {
        const changed = await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          const current = await tx.project.findUnique({ where: { id: input.projectId } });
          if (!current || current.status === "DELETING") return { kind: "not_found" as const };
          if (current.status === "ARCHIVED" && [
            input.defaults,
            input.description,
            input.instructions,
            input.memoryEnabled,
            input.name,
            input.policy,
            input.publicSharingEnabled
          ].some((value) => value !== undefined)) {
            return { kind: "conflict" as const, reason: "project_archived" };
          }
          if (
            input.expectedAccessRevision !== undefined &&
            input.expectedAccessRevision !== current.accessRevision
          ) return { kind: "conflict" as const, reason: "access_revision_conflict" };
          if (
            input.expectedInstructionsRevision !== undefined &&
            input.expectedInstructionsRevision !== current.instructionsRevision
          ) return { kind: "conflict" as const, reason: "instructions_revision_conflict" };
          if (
            input.expectedMemoryRevision !== undefined &&
            input.expectedMemoryRevision !== current.memoryRevision
          ) return { kind: "conflict" as const, reason: "memory_revision_conflict" };
          if (
            input.expectedPolicyRevision !== undefined &&
            input.expectedPolicyRevision !== current.policyRevision
          ) return { kind: "conflict" as const, reason: "policy_revision_conflict" };
          if (input.defaults !== undefined) {
            const authority = await tx.project.findUnique({
              include: projectDetailInclude,
              where: { id: input.projectId }
            });
            if (!authority) return { kind: "not_found" as const };
            const activeResources = resources(authority);
            const modelIds = new Set(activeResources.flatMap((resource) =>
              resource.type === "model" ? [resource.resourceId] : []
            ));
            const searchIds = new Set(activeResources.flatMap((resource) =>
              resource.type === "search" ? [resource.resourceId] : []
            ));
            const knowledgeIds = new Set(activeResources.flatMap((resource) =>
              resource.type === "knowledge" ? [resource.resourceId] : []
            ));
            const knowledgeSourceIds = new Set(projectKnowledgeSources(authority, knowledgeIds)
              .filter((source) => source.readiness === "ready")
              .map((source) => source.id));
            const assistantIds = new Set(activeResources.flatMap((resource) =>
              resource.type === "assistant" ? [resource.resourceId] : []
            ));
            const hasMcp = activeResources.some((resource) => resource.type === "mcp");
            if (
              (input.defaults.providerModelId !== null && !modelIds.has(input.defaults.providerModelId)) ||
              input.defaults.knowledgePlan.baseIds.some((id) => !knowledgeIds.has(id)) ||
              input.defaults.knowledgePlan.sourceIds.some((id) => !knowledgeSourceIds.has(id)) ||
              input.defaults.searchPlan.optionIds.some((id) => !searchIds.has(id)) ||
              (input.defaults.assistantId !== null && !assistantIds.has(input.defaults.assistantId)) ||
              (input.defaults.mcpMode !== "off" && !hasMcp)
            ) return { kind: "conflict" as const, reason: "project_default_resource_unavailable" };
          }
          const effectivePolicy = input.policy ?? storedPolicy(current.policy);
          const effectiveDefaults = input.defaults ?? storedDefaults(current.defaults);
          if (
            !effectivePolicy.externalToolsEnabled &&
            (effectiveDefaults.searchPlan.optionIds.length > 0 || effectiveDefaults.mcpMode !== "off")
          ) return { kind: "conflict" as const, reason: "project_external_tools_disabled" };
          if (
            (input.status !== undefined || input.publicSharingEnabled !== undefined) &&
            access.effectiveRole !== "OWNER"
          ) return { kind: "conflict" as const, reason: "owner_role_required" };

          const data: Prisma.ProjectUpdateInput = {};
          const events: Array<{ eventType: string; metadata?: Prisma.InputJsonObject }> = [];
          if (input.name !== undefined && input.name !== current.name) {
            data.name = input.name;
            events.push({ eventType: "project_renamed" });
          }
          if (input.description !== undefined && input.description !== current.description) {
            data.description = input.description;
            events.push({ eventType: "project_description_updated" });
          }
          if (input.instructions !== undefined && input.instructions !== current.instructions) {
            data.instructions = input.instructions;
            data.instructionsRevision = { increment: 1 };
            events.push({ eventType: "instructions_updated", metadata: { fromRevision: current.instructionsRevision } });
          }
          if (input.policy !== undefined) {
            data.policy = input.policy as unknown as Prisma.InputJsonValue;
            data.policyRevision = { increment: 1 };
            events.push({ eventType: "policy_updated", metadata: { fromRevision: current.policyRevision } });
          }
          if (input.defaults !== undefined) {
            data.defaults = input.defaults as unknown as Prisma.InputJsonValue;
            if (input.policy === undefined) data.policyRevision = { increment: 1 };
            events.push({ eventType: "defaults_updated", metadata: { fromRevision: current.policyRevision } });
          }
          if (input.memoryEnabled !== undefined && input.memoryEnabled !== current.memoryEnabled) {
            data.memoryEnabled = input.memoryEnabled;
            data.memoryRevision = { increment: 1 };
            events.push({ eventType: "memory_policy_updated", metadata: { enabled: input.memoryEnabled } });
          }
          if (input.publicSharingEnabled !== undefined && input.publicSharingEnabled !== current.publicSharingEnabled) {
            data.publicSharingEnabled = input.publicSharingEnabled;
            if (input.policy === undefined && input.defaults === undefined) {
              data.policyRevision = { increment: 1 };
            }
            events.push({ eventType: input.publicSharingEnabled ? "public_sharing_enabled" : "public_sharing_disabled" });
            if (!input.publicSharingEnabled) {
              await tx.sharedChatSnapshot.updateMany({
                data: { revokedAt: new Date() },
                where: { projectId: input.projectId, revokedAt: null }
              });
            }
          }
          if (input.status !== undefined && input.status !== current.status) {
            data.status = input.status;
            data.archivedAt = input.status === "ARCHIVED" ? new Date() : null;
            data.accessRevision = { increment: 1 };
            events.push({ eventType: input.status === "ARCHIVED" ? "project_archived" : "project_restored" });
          }
          if (Object.keys(data).length > 0) {
            await tx.project.update({ data, where: { id: input.projectId } });
          }
          if (events.length > 0) {
            await tx.projectAuditEvent.createMany({
              data: events.map((event) => audit({
                actorDisplayName: input.actorDisplayName,
                actorUserId: input.userId,
                eventType: event.eventType,
                metadata: event.metadata,
                projectId: input.projectId
              }))
            });
          }
          return { kind: "ok" as const };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (changed.kind !== "ok") return changed;
        notifyProjectEvent(input.projectId);
        const value = await getDetail(input.userId, input.projectId);
        return value ? { kind: "ok", value } : { kind: "not_found" };
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_update_conflict" };
        throw error;
      }
    },

    async listGrants(userId: string, projectId: string): Promise<ProjectGrantWire[] | null> {
      const value = await getDetail(userId, projectId);
      return value ? [...value.grants] : null;
    },

    async addGrant(input: {
      actorDisplayName: string;
      expectedAccessRevision: number;
      groupId?: string;
      projectId: string;
      role: ProjectRole;
      userId: string;
      targetUserId?: string;
    }): Promise<ProjectRepositoryResult<ProjectGrantWire>> {
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.accessRevision !== input.expectedAccessRevision) {
            return { kind: "conflict" as const, reason: "access_revision_conflict" };
          }
          if (!canManageGrant(access.effectiveRole, null, input.role) || (input.groupId && input.role === "OWNER")) {
            return { kind: "conflict" as const, reason: "grant_role_not_permitted" };
          }
          if (input.targetUserId) {
            const target = await tx.user.findFirst({ where: { id: input.targetUserId, status: "active" } });
            if (!target) return { kind: "target_not_found" as const, reason: "project_user_not_found" };
          } else if (input.groupId) {
            const target = await tx.group.findFirst({ where: { archivedAt: null, id: input.groupId } });
            if (!target) return { kind: "target_not_found" as const, reason: "project_group_not_found" };
          } else {
            return { kind: "conflict" as const, reason: "grant_subject_invalid" };
          }
          const created = await tx.projectGrant.create({
            data: {
              createdByUserId: input.userId,
              groupId: input.groupId,
              projectId: input.projectId,
              role: input.role,
              userId: input.targetUserId
            },
            include: projectDetailInclude.grants.include
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: input.groupId ? "group_grant_added" : "user_grant_added",
              metadata: { role: input.role },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: grantWire(created) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "grant_conflict" };
        throw error;
      }
    },

    async updateGrant(input: {
      actorDisplayName: string;
      expectedAccessRevision: number;
      grantId: string;
      projectId: string;
      role: ProjectRole;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectGrantWire>> {
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.accessRevision !== input.expectedAccessRevision) {
            return { kind: "conflict" as const, reason: "access_revision_conflict" };
          }
          const current = await tx.projectGrant.findFirst({
            where: { id: input.grantId, projectId: input.projectId }
          });
          if (!current) return { kind: "target_not_found" as const, reason: "project_grant_not_found" };
          if (!canManageGrant(access.effectiveRole, current.role, input.role) || (current.groupId && input.role === "OWNER")) {
            return { kind: "conflict" as const, reason: "grant_role_not_permitted" };
          }
          if (current.role === "OWNER" && input.role !== "OWNER") {
            const ownerCount = await tx.projectGrant.count({
              where: {
                projectId: input.projectId,
                role: "OWNER",
                user: { status: "active" },
                userId: { not: null }
              }
            });
            if (ownerCount <= 1) return { kind: "conflict" as const, reason: "last_owner_required" };
          }
          const updated = await tx.projectGrant.update({
            data: { role: input.role as PrismaProjectRole },
            include: projectDetailInclude.grants.include,
            where: { id: input.grantId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: current.groupId ? "group_grant_changed" : "user_grant_changed",
              metadata: { fromRole: current.role, toRole: input.role },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: grantWire(updated) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "grant_conflict" };
        throw error;
      }
    },

    async previewGrantRemoval(input: Readonly<{
      expectedAccessRevision: number;
      grantId: string;
      projectId: string;
      userId: string;
    }>): Promise<ProjectRepositoryResult<ProjectGrantRemovalPreviewWire>> {
      return prisma.$transaction(async (tx) => {
        await lockProject(tx, input.projectId);
        const access = await resolveProjectAccess(tx, {
          minimumRole: "MANAGER",
          projectId: input.projectId,
          requireActive: true,
          userId: input.userId
        });
        if (!access) return { kind: "not_found" as const };
        if (access.accessRevision !== input.expectedAccessRevision) {
          return { kind: "conflict" as const, reason: "access_revision_conflict" };
        }
        const impact = await grantRemovalImpact(tx, input.projectId, input.grantId);
        if (!impact) return { kind: "target_not_found" as const, reason: "project_grant_not_found" };
        if (!canManageGrant(access.effectiveRole, impact.grant.role, null)) {
          return { kind: "conflict" as const, reason: "grant_role_not_permitted" };
        }
        let reason: string | null = null;
        if (impact.grant.role === "OWNER") {
          const ownerCount = await tx.projectGrant.count({
            where: {
              projectId: input.projectId,
              role: "OWNER",
              user: { status: "active" },
              userId: { not: null }
            }
          });
          if (ownerCount <= 1) reason = "last_owner_required";
        }
        return {
          kind: "ok" as const,
          value: {
            accessRevision: access.accessRevision,
            canCommit: reason === null,
            grant: {
              label: impact.label,
              role: impact.grant.role,
              type: impact.grant.groupId ? "group" : "user"
            },
            losesAccessCount: impact.losesAccessCount,
            reason,
            roleChangeCount: impact.roleChangeCount
          }
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async removeGrant(input: {
      actorDisplayName: string;
      expectedAccessRevision: number;
      grantId: string;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<{ id: string }>> {
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.accessRevision !== input.expectedAccessRevision) {
            return { kind: "conflict" as const, reason: "access_revision_conflict" };
          }
          const current = await tx.projectGrant.findFirst({
            where: { id: input.grantId, projectId: input.projectId }
          });
          if (!current) return { kind: "target_not_found" as const, reason: "project_grant_not_found" };
          if (!canManageGrant(access.effectiveRole, current.role, null)) {
            return { kind: "conflict" as const, reason: "grant_role_not_permitted" };
          }
          if (current.role === "OWNER") {
            const ownerCount = await tx.projectGrant.count({
              where: {
                projectId: input.projectId,
                role: "OWNER",
                user: { status: "active" },
                userId: { not: null }
              }
            });
            if (ownerCount <= 1) return { kind: "conflict" as const, reason: "last_owner_required" };
          }
          await tx.projectGrant.delete({ where: { id: current.id } });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: current.groupId ? "group_grant_removed" : "user_grant_removed",
              metadata: { role: current.role },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: { id: current.id } };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "grant_conflict" };
        throw error;
      }
    },

    async leave(input: Readonly<{
      actorDisplayName: string;
      expectedAccessRevision: number;
      projectId: string;
      userId: string;
    }>): Promise<ProjectRepositoryResult<{ accessRemaining: boolean }>> {
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "VIEWER",
            projectId: input.projectId,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.accessRevision !== input.expectedAccessRevision) {
            return { kind: "conflict" as const, reason: "access_revision_conflict" };
          }
          const direct = await tx.projectGrant.findFirst({
            where: { projectId: input.projectId, userId: input.userId }
          });
          if (!direct) {
            return { kind: "conflict" as const, reason: "project_direct_access_not_found" };
          }
          if (direct.role === "OWNER") {
            return { kind: "conflict" as const, reason: "project_owner_cannot_leave" };
          }
          await tx.projectGrant.delete({ where: { id: direct.id } });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "user_left_project",
              metadata: { role: direct.role },
              projectId: input.projectId
            })
          });
          return {
            kind: "ok" as const,
            value: { accessRemaining: access.groupGrants.length > 0 }
          };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "grant_conflict" };
        throw error;
      }
    },

    async listResources(userId: string, projectId: string): Promise<ProjectResourceWire[] | null> {
      const value = await getDetail(userId, projectId);
      return value ? [...value.resources] : null;
    },

    async previewResourceChange(input: Readonly<{
      action: "add" | "remove";
      bindingId?: string;
      expectedPolicyRevision: number;
      projectId: string;
      resourceId?: string;
      type?: ProjectResourceTypeWire;
      userId: string;
    }>): Promise<ProjectRepositoryResult<ProjectResourceChangePreviewWire>> {
      return prisma.$transaction(async (tx) => {
        await lockProject(tx, input.projectId);
        const access = await resolveProjectAccess(tx, {
          minimumRole: "MANAGER",
          projectId: input.projectId,
          requireActive: true,
          userId: input.userId
        });
        if (!access) return { kind: "not_found" as const };
        if (access.policyRevision !== input.expectedPolicyRevision) {
          return { kind: "conflict" as const, reason: "policy_revision_conflict" };
        }
        if (input.action === "add") {
          if (input.type !== "assistant" || !input.resourceId) {
            return { kind: "unavailable" as const, reason: "project_resource_preview_unsupported" };
          }
          const plan = await assistantResourcePlan(tx, {
            projectId: input.projectId,
            resourceId: input.resourceId,
            userId: input.userId
          });
          if (!plan) return { kind: "unavailable" as const, reason: "project_assistant_unavailable" };
          return {
            kind: "ok" as const,
            value: {
              action: "add",
              canCommit: plan.canCommit,
              consequences: {
                affectedChatCount: 0,
                clearedDefaults: [],
                dependentAssistants: []
              },
              dependencies: plan.dependencies,
              policyRevision: access.policyRevision,
              resource: { label: plan.revision.name, type: "assistant" },
              revisionId: plan.revision.id
            }
          };
        }
        if (!input.bindingId) {
          return { kind: "target_not_found" as const, reason: "project_resource_not_found" };
        }
        const resource = await resolveBoundProjectResource(tx, input.projectId, input.bindingId);
        if (!resource) return { kind: "target_not_found" as const, reason: "project_resource_not_found" };
        const consequences = await resourceRemovalConsequences(tx, {
          projectId: input.projectId,
          resource
        });
        if (!consequences) return { kind: "conflict" as const, reason: "project_defaults_invalid" };
        return {
          kind: "ok" as const,
          value: {
            action: "remove",
            canCommit: true,
            consequences: {
              affectedChatCount: consequences.affectedChatCount,
              clearedDefaults: consequences.clearedDefaults,
              dependentAssistants: consequences.dependentAssistants
            },
            dependencies: [],
            policyRevision: access.policyRevision,
            resource: { label: resource.label, type: resource.type },
            revisionId: null
          }
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async addResource(input: {
      actorDisplayName: string;
      expectedPolicyRevision: number;
      projectId: string;
      resourceId: string;
      revisionId?: string;
      type: ProjectResourceTypeWire;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectResourceWire[]>> {
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.policyRevision !== input.expectedPolicyRevision) {
            return { kind: "conflict" as const, reason: "policy_revision_conflict" };
          }
          let eventType = "resource_attached";
          if (input.type === "model") {
            const target = (await eligibleProjectModels(tx)).find((model) => model.id === input.resourceId);
            if (!target) return { kind: "unavailable" as const, reason: "project_model_unavailable" };
            await tx.projectModelBinding.create({
              data: { addedByUserId: input.userId, projectId: input.projectId, providerModelId: input.resourceId }
            });
          } else if (input.type === "search") {
            const target = await tx.searchOption.findFirst({
              select: { id: true, optionId: true },
              where: {
                archivedAt: null,
                enabled: true,
                AND: [{ OR: [{ id: input.resourceId }, { optionId: input.resourceId }] }],
                sourceConnection: {
                  is: {
                    activeConfig: { not: Prisma.DbNull },
                    activeVersion: { gt: 0 },
                    enabled: true,
                    OR: [
                      { family: "fake" },
                      {
                        defaultCredential: {
                          enabled: true,
                          activeVersion: { is: { revokedAt: null } }
                        }
                      }
                    ]
                  }
                },
                strategies: {
                  some: { activeRevisionId: { not: null }, archivedAt: null, enabled: true }
                }
              }
            });
            if (!target) return { kind: "unavailable" as const, reason: "project_search_unavailable" };
            await tx.projectSearchBinding.create({
              data: { addedByUserId: input.userId, projectId: input.projectId, searchOptionId: target.id }
            });
          } else if (input.type === "mcp") {
            const target = await tx.mcpServer.findFirst({
              select: { activeRevisionId: true, enabled: true, id: true, sharedConfigEnvelope: true },
              where: {
                activeRevisionId: { not: null },
                archivedAt: null,
                enabled: true,
                id: input.resourceId
              }
            });
            if (!target) return { kind: "unavailable" as const, reason: "project_mcp_unavailable" };
            // A Project MCP binding is only valid with a shared envelope or a
            // no-auth active configuration. Personal grants/slots are never a
            // delegation source.
            if (!target.sharedConfigEnvelope) {
              const revision = await tx.mcpRevision.findFirst({
                select: { configuration: true },
                where: { id: target.activeRevisionId! }
              });
              if (!revision || !mcpRevisionUsesNoAuth(revision.configuration)) {
                return { kind: "unavailable" as const, reason: "project_mcp_shared_configuration_required" };
              }
            }
            await tx.projectMcpBinding.create({
              data: { addedByUserId: input.userId, projectId: input.projectId, serverId: input.resourceId }
            });
          } else if (input.type === "knowledge") {
            const target = await tx.knowledgeBase.findFirst({
              include: {
                activeIndexGeneration: {
                  include: {
                    embeddingProviderModel: {
                      include: {
                        connection: {
                          include: { defaultCredential: { include: { activeVersion: true } } }
                        }
                      }
                    }
                  }
                }
              },
              where: {
                archivedAt: null,
                deletionRequestedAt: null,
                id: input.resourceId,
                ownerUserId: input.userId,
                trashedAt: null
              }
            });
            const generation = target?.activeIndexGeneration;
            const embedding = generation?.embeddingProviderModel;
            const connection = embedding?.connection;
            if (!target || generation?.status !== "active" || !embedding || !connection ||
              !embedding.enabled || embedding.modelClass !== "embedding" ||
              embedding.activeConfig === null || embedding.activeVersion <= 0 ||
              connection.family === "fake" ||
              !connection.enabled || connection.activeConfig === null || connection.activeVersion <= 0 || !(
                connection.defaultCredential?.enabled &&
                connection.defaultCredential.activeVersion?.revokedAt === null
              )) {
              return { kind: "unavailable" as const, reason: "project_knowledge_unavailable" };
            }
            await tx.projectKnowledgeBaseBinding.create({
              data: { addedByUserId: input.userId, knowledgeBaseId: input.resourceId, projectId: input.projectId }
            });
          } else if (input.type === "skill") {
            const target = await tx.skillDefinition.findFirst({
              where: {
                archivedAt: null,
                currentRevisionId: { not: null },
                deletedAt: null,
                id: input.resourceId,
                ownerUserId: input.userId
              }
            });
            if (!target) return { kind: "unavailable" as const, reason: "project_skill_unavailable" };
            await tx.projectSkillBinding.create({
              data: { addedByUserId: input.userId, projectId: input.projectId, skillId: target.id }
            });
          } else {
            const plan = await assistantResourcePlan(tx, input);
            if (!plan || (input.revisionId && input.revisionId !== plan.revision.id)) {
              return { kind: "unavailable" as const, reason: "project_assistant_unavailable" };
            }
            if (!plan.canCommit) {
              return { kind: "unavailable" as const, reason: "project_assistant_dependency_unavailable" };
            }
            // Preview and commit share this exact plan. The serializable
            // transaction plus policy/revision checks makes Assistant and all
            // newly delegated dependencies one atomic publication.
            const {
              knowledgeBases,
              knowledgeSources,
              mcpServers,
              revision,
              searchOptions,
              skills
            } = plan;

            await tx.projectModelBinding.createMany({
              data: [{ addedByUserId: input.userId, projectId: input.projectId, providerModelId: revision.providerModelId }],
              skipDuplicates: true
            });
            if (searchOptions.length > 0) await tx.projectSearchBinding.createMany({
              data: searchOptions.map((option) => ({
                addedByUserId: input.userId,
                projectId: input.projectId,
                searchOptionId: option.id
              })),
              skipDuplicates: true
            });
            if (knowledgeBases.length > 0) await tx.projectKnowledgeBaseBinding.createMany({
              data: knowledgeBases.map((base) => ({
                addedByUserId: input.userId,
                knowledgeBaseId: base.id,
                projectId: input.projectId
              })),
              skipDuplicates: true
            });
            if (knowledgeSources.length > 0) await tx.projectKnowledgeSourceBinding.createMany({
              data: knowledgeSources.map((source) => ({
                addedByUserId: input.userId,
                projectId: input.projectId,
                sourceId: source.id
              })),
              skipDuplicates: true
            });
            if (skills.length > 0) await tx.projectSkillBinding.createMany({
              data: skills.map((skill) => ({
                addedByUserId: input.userId,
                projectId: input.projectId,
                skillId: skill.id
              })),
              skipDuplicates: true
            });
            if (mcpServers.length > 0) await tx.projectMcpBinding.createMany({
              data: mcpServers.map((server) => ({
                addedByUserId: input.userId,
                projectId: input.projectId,
                serverId: server.id
              })),
              skipDuplicates: true
            });

            const revisionId = revision.id;
            const existing = await tx.projectAssistantBinding.findUnique({
              where: { projectId_assistantId: { assistantId: input.resourceId, projectId: input.projectId } }
            });
            if (existing) {
              await tx.projectAssistantBinding.update({
                data: { addedByUserId: input.userId, revisionId },
                where: { id: existing.id }
              });
              eventType = "resource_revision_updated";
            } else {
              await tx.projectAssistantBinding.create({
                data: {
                  addedByUserId: input.userId,
                  assistantId: input.resourceId,
                  projectId: input.projectId,
                  revisionId
                }
              });
            }
          }
          await tx.project.update({
            data: { policyRevision: { increment: 1 } },
            where: { id: input.projectId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType,
              metadata: { resourceType: input.type },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (outcome.kind !== "ok") return outcome;
        notifyProjectEvent(input.projectId);
        const values = await this.listResources(input.userId, input.projectId);
        return values ? { kind: "ok", value: values } : { kind: "not_found" };
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "resource_binding_conflict" };
        throw error;
      }
    },

    async removeResource(input: {
      actorDisplayName: string;
      bindingId: string;
      expectedPolicyRevision: number;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<{ id: string }>> {
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.policyRevision !== input.expectedPolicyRevision) {
            return { kind: "conflict" as const, reason: "policy_revision_conflict" };
          }
          const removed = await resolveBoundProjectResource(tx, input.projectId, input.bindingId);
          if (!removed) return { kind: "target_not_found" as const, reason: "project_resource_not_found" };
          if (!await resourceRemovalConsequences(tx, {
            projectId: input.projectId,
            resource: removed
          })) return { kind: "conflict" as const, reason: "project_defaults_invalid" };
          if (removed.type === "model") {
            await tx.projectModelBinding.delete({
              where: {
                projectId_providerModelId: {
                  projectId: input.projectId,
                  providerModelId: removed.storageId
                }
              }
            });
          } else if (removed.type === "search") {
            await tx.projectSearchBinding.delete({
              where: {
                projectId_searchOptionId: {
                  projectId: input.projectId,
                  searchOptionId: removed.storageId
                }
              }
            });
          } else if (removed.type === "mcp") {
            await tx.projectMcpBinding.delete({
              where: {
                projectId_serverId: {
                  projectId: input.projectId,
                  serverId: removed.storageId
                }
              }
            });
          } else if (removed.type === "knowledge") {
            await tx.projectKnowledgeBaseBinding.delete({ where: { id: removed.storageId } });
          } else if (removed.type === "assistant") {
            await tx.projectAssistantBinding.delete({ where: { id: removed.storageId } });
          } else {
            await tx.projectSkillBinding.delete({ where: { id: removed.storageId } });
          }
          const consequences = await cleanupResourceReferences(tx, {
            projectId: input.projectId,
            resourceId: removed.resourceId,
            type: removed.type
          });
          if (!consequences) throw new Error("project_resource_cleanup_invariant");
          await tx.project.update({
            data: { policyRevision: { increment: 1 } },
            where: { id: input.projectId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "resource_detached",
              metadata: {
                affectedChatCount: consequences?.affectedChatCount ?? 0,
                clearedDefaultCount: consequences?.clearedDefaults.length ?? 0,
                dependentAssistantCount: consequences?.dependentAssistants.length ?? 0,
                resourceType: removed.type
              },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: { id: input.bindingId } };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "resource_binding_conflict" };
        throw error;
      }
    },

    async activity(input: {
      before?: string;
      limit: number;
      projectId: string;
      userId: string;
    }): Promise<ProjectActivityResponseWire | null> {
      const access = await resolveProjectAccess(prisma, {
        minimumRole: "VIEWER",
        projectId: input.projectId,
        userId: input.userId
      });
      if (!access) return null;
      const cursor = input.before
        ? await prisma.projectAuditEvent.findFirst({
            select: { createdAt: true, id: true },
            where: { id: input.before, projectId: input.projectId }
          })
        : null;
      if (input.before && !cursor) return null;
      const rows = await prisma.projectAuditEvent.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        where: {
          projectId: input.projectId,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                ]
              }
            : {})
        }
      });
      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit);
      return {
        events: page.map((event) => ({
          actorDisplayName: event.actorDisplayName,
          createdAt: iso(event.createdAt),
          eventType: event.eventType,
          id: event.id,
          metadata: auditMetadata(event.metadata)
        })),
        nextCursor: hasMore ? page.at(-1)?.id ?? null : null
      };
    },

    async delete(input: {
      actorDisplayName: string;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<{ id: string }>> {
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            allowDeleting: true,
            minimumRole: "OWNER",
            projectId: input.projectId,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          await tx.project.update({
            data: { deletionRequestedAt: new Date(), status: "DELETING" },
            where: { id: input.projectId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "deletion_requested",
              projectId: input.projectId
            })
          });
          await tx.sharedChatSnapshot.updateMany({
            data: { revokedAt: new Date() },
            where: { projectId: input.projectId, revokedAt: null }
          });
          const attachments = await tx.attachment.findMany({
            select: { storageKey: true },
            where: { projectId: input.projectId }
          });
          if (attachments.length > 0) {
            await tx.attachmentDeletionJob.createMany({
              data: attachments.map(({ storageKey }) => ({ storageKey })),
              skipDuplicates: true
            });
          }
          // Project run and Memory evidence is immutable while the Project
          // exists, but an explicit owner-authorized erasure removes the
          // aggregate as a whole. Clear restrictive evidence/current-version
          // edges before the Project cascade removes the remaining rows.
          await tx.projectRunBinding.deleteMany({ where: { projectId: input.projectId } });
          await tx.projectMemoryProposal.deleteMany({ where: { projectId: input.projectId } });
          await tx.projectMemoryFact.updateMany({
            data: { currentVersionId: null, state: "FORGOTTEN" },
            where: { projectId: input.projectId }
          });
          await tx.project.delete({ where: { id: input.projectId } });
          return { kind: "ok" as const, value: { id: input.projectId } };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_delete_conflict" };
        throw error;
      }
    }
  };
}

/**
 * Resource-owner revoke intentionally does not resolve Project membership or
 * return Project metadata. Ownership of the private definition is sufficient
 * to fence its future Project use; the same cleanup used by Manager unlink
 * removes defaults and dependent Assistant publications atomically.
 */
export async function revokeOwnedProjectResourcePublication(
  prisma: PrismaClient,
  input: Readonly<{
    bindingId: string;
    resourceId: string;
    type: "assistant" | "knowledge" | "skill";
    userId: string;
  }>
): Promise<boolean> {
  const initial = input.type === "knowledge"
    ? await prisma.projectKnowledgeBaseBinding.findFirst({
        select: { projectId: true },
        where: {
          id: input.bindingId,
          knowledgeBaseId: input.resourceId,
          knowledgeBase: { ownerUserId: input.userId }
        }
      })
    : input.type === "assistant"
      ? await prisma.projectAssistantBinding.findFirst({
          select: { projectId: true },
          where: {
            assistant: { ownerUserId: input.userId },
            assistantId: input.resourceId,
            id: input.bindingId
          }
        })
      : await prisma.projectSkillBinding.findFirst({
          select: { projectId: true },
          where: {
            id: input.bindingId,
            skill: { ownerUserId: input.userId },
            skillId: input.resourceId
          }
        });
  if (!initial) return false;
  const removed = await prisma.$transaction(async (tx) => {
    await lockProject(tx, initial.projectId);
    const actor = await tx.user.findFirst({
      select: { displayName: true },
      where: { id: input.userId, status: "active" }
    });
    if (!actor) return false;
    const count = input.type === "knowledge"
      ? await tx.projectKnowledgeBaseBinding.deleteMany({
          where: {
            id: input.bindingId,
            knowledgeBaseId: input.resourceId,
            knowledgeBase: { ownerUserId: input.userId },
            projectId: initial.projectId
          }
        })
      : input.type === "assistant"
        ? await tx.projectAssistantBinding.deleteMany({
            where: {
              assistant: { ownerUserId: input.userId },
              assistantId: input.resourceId,
              id: input.bindingId,
              projectId: initial.projectId
            }
          })
        : await tx.projectSkillBinding.deleteMany({
            where: {
              id: input.bindingId,
              projectId: initial.projectId,
              skill: { ownerUserId: input.userId },
              skillId: input.resourceId
            }
          });
    if (count.count !== 1) return false;
    const consequences = await cleanupResourceReferences(tx, {
      projectId: initial.projectId,
      resourceId: input.resourceId,
      type: input.type
    });
    if (!consequences) throw new Error("project_resource_cleanup_invariant");
    await tx.project.update({
      data: { policyRevision: { increment: 1 } },
      where: { id: initial.projectId }
    });
    await tx.projectAuditEvent.create({
      data: audit({
        actorDisplayName: actor.displayName,
        actorUserId: input.userId,
        eventType: "resource_owner_revoked",
        metadata: {
          affectedChatCount: consequences?.affectedChatCount ?? 0,
          clearedDefaultCount: consequences?.clearedDefaults.length ?? 0,
          dependentAssistantCount: consequences?.dependentAssistants.length ?? 0,
          resourceType: input.type
        },
        projectId: initial.projectId
      })
    });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (removed) notifyProjectEvent(initial.projectId);
  return removed;
}
