import {
  resolveProviderModelParameterControls,
  type CatalogAdapterKind,
  type ProviderModelCatalogEntry,
  type SearchStrategyCatalogEntry,
  type SearchStrategyRouteCatalogEntry
} from "@/lib/domain/catalog";
import { resolveProviderCredential } from "@/lib/domain/providerCredentialResolution";
import {
  canAccessModel,
  canAccessSearchStrategy,
  type ResolvedEntitlements
} from "@/lib/server/auth/entitlements";
import { isTestModeAllowedEnv } from "@/lib/server/auth/csrf";
import { loadEntitlementsForUser } from "@/lib/server/auth/dbEntitlements";
import type { CatalogData } from "@/lib/server/catalog/currentUserCatalog";
import { availableSearchStrategiesForModel } from "@/lib/domain/catalogMatrix";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderDefaultParams,
  normalizeProviderModelCapabilities,
  normalizeProviderModelConfiguration,
  type ProviderModelConfiguration
} from "@/lib/server/providers/providerConfiguration";
import { resolveProviderModelCapabilities } from "@/lib/server/providers/providerModelCapabilities";
import {
  compatibleTechnicalAdapter,
  legacySearchKind,
  normalizeSearchDraft,
  searchExecutionModes
} from "@/lib/server/search/configuration";
import type { SearchProbeBinding } from "@/lib/server/search/probeBinding";
import type {
  PrismaClient,
  ProviderConnection,
  ProviderCredential,
  ProviderCredentialVersion,
  ProviderGroupCredentialAssignment,
  ProviderModel,
  ProviderModelCredentialCheck,
  ProviderUserCredentialAssignment,
  SearchStrategy
} from "@prisma/client";

type CatalogPrismaClient = Pick<
  PrismaClient,
  "modelPolicy" | "providerModel" | "searchOption" | "searchPolicy" | "user"
>;

type UserSettingsRow = {
  defaultControlValues: unknown;
  defaultProviderModel: { connectionId: string } | null;
  defaultProviderModelId: string | null;
  defaultSearchStrategyId: string;
  defaultSearchPlan: unknown;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
};

type CatalogMembershipRow = {
  group: { archivedAt: Date | null };
  groupId: string;
};

type CatalogUserRow = {
  groups: CatalogMembershipRow[];
  settings: UserSettingsRow | null;
};

type CatalogCredentialRow = Pick<ProviderCredential, "enabled" | "id"> & {
  activeVersion: Pick<ProviderCredentialVersion, "id" | "revokedAt"> | null;
  groupAssignments: Pick<ProviderGroupCredentialAssignment, "credentialId" | "groupId">[];
  userAssignments?: Pick<ProviderUserCredentialAssignment, "credentialId" | "userId">[];
};

type CatalogConnectionRow = Pick<
  ProviderConnection,
  | "activeConfig"
  | "activeVersion"
  | "activatedAt"
  | "defaultCredentialId"
  | "displayName"
  | "enabled"
  | "family"
  | "id"
  | "templateKey"
  | "unassignedPolicy"
> & {
  credentials: CatalogCredentialRow[];
};

type CatalogCredentialCheckRow = Pick<
  ProviderModelCredentialCheck,
  | "connectionId"
  | "connectionVersion"
  | "credentialId"
  | "credentialVersionId"
  | "modelVersion"
  | "providerModelId"
  | "status"
>;

export type CatalogProviderModelRow = ProviderModel & {
  activeCredentialChecks: CatalogCredentialCheckRow[];
  connection: CatalogConnectionRow;
};

type ActiveCatalogModelConfiguration = ProviderModelConfiguration | {
  adapterKind: "fake";
  capabilities: ProviderModelConfiguration["capabilities"];
  defaultParams: Record<string, unknown>;
  upstreamModelId: string;
};

export type CatalogDataLoaderDeps = {
  env?: Record<string, string | undefined>;
  loadEntitlements?(userId: string): Promise<ResolvedEntitlements>;
  prisma: CatalogPrismaClient;
};

const supportedSearchOptionKinds = new Map<string, SearchStrategyCatalogEntry["kind"]>([
  ["gemini_google_search", "gemini_google_search"],
  ["none", "none"],
  ["perplexity_search", "perplexity_tool_search"],
  ["web_search", "web_search"]
]);

type CatalogSearchStrategyRow = SearchStrategy & {
  activeRevision: null | {
    adapterKind: string;
    configuration: unknown;
    credentialMode: string;
    id: string;
    providerModelId: string | null;
  };
};

export type CatalogSearchOptionRow = {
  description: string;
  displayName: string;
  id: string;
  kind: string;
  optionId: string;
  sourceConnection: { id: string } | null;
  sourceConnectionId: string | null;
  strategies: CatalogSearchStrategyRow[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function exposeFakeProvider(env: Record<string, string | undefined> = process.env): boolean {
  return isTestModeAllowedEnv(env);
}

function activeModelConfiguration(
  model: CatalogProviderModelRow
): ActiveCatalogModelConfiguration | null {
  if (
    !model.enabled ||
    model.activeVersion <= 0 ||
    !model.activatedAt ||
    !model.connection.enabled ||
    model.connection.activeVersion <= 0 ||
    !model.connection.activatedAt
  ) {
    return null;
  }

  try {
    normalizeProviderConnectionConfiguration(model.connection.activeConfig);

    if (
      model.connection.family === "fake" &&
      model.connection.templateKey === "fake" &&
      model.templateKey === "fake:fake-qsa"
    ) {
      if (
        !isRecord(model.activeConfig) ||
        model.activeConfig.adapterKind !== "fake" ||
        !nonEmptyString(model.activeConfig.upstreamModelId)
      ) {
        return null;
      }

      return {
        adapterKind: "fake",
        capabilities: normalizeProviderModelCapabilities(model.activeConfig.capabilities),
        defaultParams: normalizeProviderDefaultParams(model.activeConfig.defaultParams),
        upstreamModelId: model.activeConfig.upstreamModelId.trim()
      };
    }

    return normalizeProviderModelConfiguration(model.activeConfig);
  } catch {
    return null;
  }
}

function hasCurrentAvailableCheck(
  model: CatalogProviderModelRow,
  credentialId: string,
  credentialVersionId: string
): boolean {
  return model.activeCredentialChecks.some(
    (check) =>
      check.status === "available" &&
      check.connectionId === model.connectionId &&
      check.providerModelId === model.id &&
      check.credentialId === credentialId &&
      check.credentialVersionId === credentialVersionId &&
      check.connectionVersion === model.connection.activeVersion &&
      check.modelVersion === model.activeVersion
  );
}

function activeProviderAuthority(input: {
  memberships?: CatalogMembershipRow[];
  model: CatalogProviderModelRow;
  userId?: string;
}): SearchProbeBinding | null {
  const credentials = input.model.connection.credentials;
  const directAssignmentCredentialId = input.userId
    ? credentials.flatMap((credential) => credential.userAssignments ?? [])
        .find((assignment) => assignment.userId === input.userId)?.credentialId ?? null
    : null;
  const resolution = resolveProviderCredential({
    assignments: credentials.flatMap((credential) => credential.groupAssignments),
    credentials: credentials.map((credential) => ({
      activeVersion: credential.activeVersion
        ? {
            id: credential.activeVersion.id,
            revoked: Boolean(credential.activeVersion.revokedAt)
          }
        : null,
      enabled: credential.enabled,
      id: credential.id
    })),
    defaultCredentialId: input.model.connection.defaultCredentialId,
    directAssignmentCredentialId,
    memberships: (input.memberships ?? []).map((membership) => ({
      archived: Boolean(membership.group.archivedAt),
      groupId: membership.groupId
    })),
    policy: input.model.connection.unassignedPolicy
  });
  if (!resolution.ok || !hasCurrentAvailableCheck(
    input.model,
    resolution.credentialId,
    resolution.credentialVersionId
  )) {
    return null;
  }
  return {
    connectionId: input.model.connectionId,
    connectionVersion: input.model.connection.activeVersion,
    credentialId: resolution.credentialId,
    credentialVersionId: resolution.credentialVersionId,
    modelVersion: input.model.activeVersion,
    providerModelId: input.model.id
  };
}

function isProviderModelAvailable(input: {
  exposeFake: boolean;
  memberships: CatalogMembershipRow[];
  model: CatalogProviderModelRow;
  userId?: string;
}): boolean {
  const configuration = activeModelConfiguration(input.model);
  if (!configuration) {
    return false;
  }

  if (configuration.adapterKind === "fake") {
    return input.exposeFake;
  }

  return activeProviderAuthority(input) !== null;
}

export function filterAvailableProviderModels(input: {
  exposeFake: boolean;
  memberships: CatalogMembershipRow[];
  models: CatalogProviderModelRow[];
  userId?: string;
}): CatalogProviderModelRow[] {
  return input.models.filter((model) =>
    isProviderModelAvailable({
      exposeFake: input.exposeFake,
      memberships: input.memberships,
      model,
      userId: input.userId
    })
  );
}

export function filterExposedProviderModels(input: {
  entitlements: ResolvedEntitlements;
  models: CatalogProviderModelRow[];
}): CatalogProviderModelRow[] {
  return input.models.filter((model) => {
    const configuration = activeModelConfiguration(model);
    return Boolean(
      configuration &&
      (configuration.adapterKind === "fake" || configuration.answerSelectable) &&
      canAccessModel(input.entitlements, model.connectionId, model.id)
    );
  });
}

export function providerModelToCatalogEntry(
  model: CatalogProviderModelRow
): ProviderModelCatalogEntry | null {
  const configuration = activeModelConfiguration(model);
  if (!configuration) {
    return null;
  }

  const resolvedCapabilities = resolveProviderModelCapabilities({
    adapterKind: configuration.adapterKind,
    capabilities: configuration.capabilities,
    legacyContextWindow: model.contextWindow,
    providerFamily: model.connection.family,
    upstreamModelId: configuration.upstreamModelId
  });
  const capabilities = {
    backgroundStreaming: resolvedCapabilities.backgroundStreaming ?? false,
    nativeBackground: resolvedCapabilities.nativeBackground ?? false,
    nativePdfInput: resolvedCapabilities.nativePdfInput,
    nativeSearch: resolvedCapabilities.nativeSearch,
    parallelToolCalls: resolvedCapabilities.parallelToolCalls ?? false,
    pdf: resolvedCapabilities.pdf,
    reasoning: resolvedCapabilities.reasoning,
    streaming: resolvedCapabilities.streaming ?? false,
    toolCalling: resolvedCapabilities.toolCalling ?? false,
    vision: resolvedCapabilities.vision
  };

  return {
    adapterKind: configuration.adapterKind as CatalogAdapterKind,
    capabilities,
    contextWindow: resolvedCapabilities.contextWindow ?? 0,
    defaultParams: configuration.defaultParams,
    displayName: model.displayName,
    inputTokenPriceMicros: model.inputTokenPriceMicros,
    modelId: model.id,
    outputTokenPriceMicros: model.outputTokenPriceMicros,
    parameterControls: resolveProviderModelParameterControls({
      adapterKind: configuration.adapterKind as CatalogAdapterKind,
      defaultMaxOutputTokens: resolvedCapabilities.defaultMaxOutputTokens,
      defaultReasoningEffort: resolvedCapabilities.defaultReasoningEffort,
      defaultReasoningMode: resolvedCapabilities.defaultReasoningMode,
      defaultParams: configuration.defaultParams,
      providerFamily: model.connection.family,
      reasoningEfforts: resolvedCapabilities.reasoningEfforts,
      reasoningModes: resolvedCapabilities.reasoningModes,
      supportsReasoningMode: "reasoningRequestMapping" in configuration &&
        Boolean(configuration.reasoningRequestMapping?.modePath),
      supportsReasoning: capabilities.reasoning,
      supportsStreaming: capabilities.streaming,
      upstreamModelId: configuration.upstreamModelId
    }),
    provider: model.connectionId,
    providerDisplayName: model.connection.displayName,
    providerFamily: model.connection.family,
    upstreamModelId: configuration.upstreamModelId
  };
}

function routeBelongsToOption(
  optionKind: SearchStrategyCatalogEntry["kind"],
  route: SearchStrategyRouteCatalogEntry
): boolean {
  if (optionKind === "web_search") {
    return route.protocol === "anthropic_web_search" ||
      route.protocol === "openai_responses_web_search";
  }
  if (optionKind === "gemini_google_search") {
    return route.protocol === "gemini_google_search";
  }
  if (optionKind === "perplexity_tool_search") {
    return route.adapterKind === "provider_model_client" &&
      route.protocol === "openrouter_perplexity_chat";
  }
  return false;
}

export function searchStrategyToCatalogRoute(
  strategy: CatalogSearchStrategyRow
): SearchStrategyRouteCatalogEntry | null {
  const revision = strategy.activeRevision;
  if (!revision) return null;

  let draft;
  try {
    draft = normalizeSearchDraft(revision.configuration);
  } catch {
    return null;
  }
  if (
    revision.adapterKind !== draft.adapterKind ||
    revision.credentialMode !== draft.credentialMode ||
    revision.providerModelId !== draft.providerModelId ||
    strategy.providerModelId !== draft.providerModelId ||
    strategy.kind !== legacySearchKind(draft.protocol, draft.adapterKind)
  ) {
    return null;
  }

  return {
    adapterKind: draft.adapterKind,
    config: { ...draft },
    credentialMode: draft.credentialMode,
    executionModes: searchExecutionModes(draft.adapterKind),
    kind: strategy.kind as SearchStrategyRouteCatalogEntry["kind"],
    physicalStrategyId: strategy.strategyId,
    protocol: draft.protocol,
    ...(draft.providerModelId ? { providerModelId: draft.providerModelId } : {}),
    revisionId: revision.id,
    searchStrategyRowId: strategy.id
  };
}

export function searchOptionToCatalogEntry(
  option: CatalogSearchOptionRow,
  routes = option.strategies.flatMap((strategy) => {
    const route = searchStrategyToCatalogRoute(strategy);
    return route ? [route] : [];
  })
): SearchStrategyCatalogEntry | null {
  const kind = supportedSearchOptionKinds.get(option.kind);
  if (
    !kind ||
    !nonEmptyString(option.optionId) ||
    !nonEmptyString(option.displayName) ||
    !nonEmptyString(option.description)
  ) {
    return null;
  }
  if (kind === "none") {
    if (option.optionId !== "search-disabled" || option.sourceConnectionId !== null ||
      option.sourceConnection !== null) return null;
    return {
      description: option.description,
      displayName: option.displayName,
      kind,
      routes: [],
      strategyId: option.optionId
    };
  }
  if (
    !option.sourceConnectionId ||
    option.sourceConnection?.id !== option.sourceConnectionId
  ) {
    return null;
  }
  const adapterKinds = new Set<string>();
  for (const route of routes) {
    if (adapterKinds.has(route.adapterKind)) return null;
    adapterKinds.add(route.adapterKind);
  }

  return {
    description: option.description,
    displayName: option.displayName,
    kind,
    routes: routes.filter((route) => routeBelongsToOption(kind, route)),
    sourceConnectionId: option.sourceConnectionId,
    strategyId: option.optionId
  };
}

export function filterExposedSearchOptions(input: {
  availableProviderModels: CatalogProviderModelRow[];
  entitlements: ResolvedEntitlements;
  exposedProviderModels: CatalogProviderModelRow[];
  memberships?: CatalogMembershipRow[];
  searchOptions: CatalogSearchOptionRow[];
  userId?: string;
}): SearchStrategyCatalogEntry[] {
  const availableProviderModels = new Map(
    input.availableProviderModels.map((model) => [model.id, model])
  );
  const exposedProviderModels = input.exposedProviderModels.flatMap((model) => {
    const entry = providerModelToCatalogEntry(model);
    return entry ? [entry] : [];
  });

  return input.searchOptions.flatMap((option) => {
    if (!canAccessSearchStrategy(input.entitlements, option.optionId)) return [];

    const normalizedRoutes = option.strategies.flatMap((strategy) => {
      const route = searchStrategyToCatalogRoute(strategy);
      return route ? [route] : [];
    });
    const adapterKinds = new Set<string>();
    for (const route of normalizedRoutes) {
      if (adapterKinds.has(route.adapterKind)) return [];
      adapterKinds.add(route.adapterKind);
    }
    const routes = normalizedRoutes.flatMap((route) => {
      if (route.adapterKind !== "provider_model_client") return [route];
      if (!route.providerModelId) return [];
      const technicalModel = availableProviderModels.get(route.providerModelId);
      const configuration = technicalModel
        ? activeModelConfiguration(technicalModel)
        : null;
      const currentAuthority = technicalModel
        ? activeProviderAuthority({
            memberships: input.memberships ?? [],
            model: technicalModel,
            userId: input.userId
          })
        : null;
      return configuration &&
        currentAuthority &&
        (!option.sourceConnectionId || technicalModel?.connectionId === option.sourceConnectionId) &&
        compatibleTechnicalAdapter(route.protocol, configuration.adapterKind) &&
        configuration.capabilities.nativeSearch
        ? [route]
        : [];
    });
    const entry = searchOptionToCatalogEntry(option, routes);
    if (!entry) return [];
    if (entry.kind === "none") return [entry];
    return exposedProviderModels.some((model) =>
      availableSearchStrategiesForModel(model, [entry]).includes(entry.strategyId)
    ) ? [entry] : [];
  });
}

export function createPrismaCatalogDataLoader({
  env = process.env,
  loadEntitlements = loadEntitlementsForUser,
  prisma
}: CatalogDataLoaderDeps) {
  return async function loadCatalogData(userId: string): Promise<CatalogData | null> {
    const user = (await prisma.user.findUnique({
      include: {
        groups: {
          include: {
            group: {
              select: {
                archivedAt: true
              }
            }
          }
        },
        settings: {
          include: {
            defaultProviderModel: {
              select: {
                connectionId: true
              }
            }
          }
        }
      },
      where: {
        id: userId
      }
    })) as CatalogUserRow | null;

    if (!user?.settings) {
      return null;
    }

    const [models, searchOptions, entitlements, modelPolicy, searchPolicy] = await Promise.all([
      prisma.providerModel.findMany({
        include: {
          activeCredentialChecks: {
            select: {
              connectionId: true,
              connectionVersion: true,
              credentialId: true,
              credentialVersionId: true,
              modelVersion: true,
              providerModelId: true,
              status: true
            }
          },
          connection: {
            include: {
              credentials: {
                select: {
                  activeVersion: {
                    select: {
                      id: true,
                      revokedAt: true
                    }
                  },
                  enabled: true,
                  groupAssignments: {
                    select: {
                      credentialId: true,
                      groupId: true
                    }
                  },
                  id: true,
                  userAssignments: {
                    select: {
                      credentialId: true,
                      userId: true
                    },
                    where: { userId }
                  }
                }
              }
            }
          }
        },
        orderBy: [{ connectionId: "asc" }, { displayName: "asc" }, { id: "asc" }],
        where: {
          enabled: true,
          connection: {
            enabled: true
          }
        }
      }),
      prisma.searchOption.findMany({
        include: {
          sourceConnection: {
            select: {
              id: true
            }
          },
          strategies: {
            include: {
              activeRevision: {
                select: {
                  adapterKind: true,
                  configuration: true,
                  credentialMode: true,
                  id: true,
                  providerModelId: true
                }
              }
            },
            orderBy: {
              strategyId: "asc"
            },
            where: {
              activeRevisionId: { not: null },
              archivedAt: null,
              enabled: true
            }
          }
        },
        orderBy: {
          optionId: "asc"
        },
        where: {
          archivedAt: null,
          enabled: true
        }
      }),
      loadEntitlements(userId),
      prisma.modelPolicy?.findUnique({
        select: { defaultProviderModelId: true },
        where: { id: "installation" }
      }) ?? Promise.resolve(null),
      prisma.searchPolicy?.findUnique({
        select: { defaultPlan: true },
        where: { id: "installation" }
      }) ?? Promise.resolve(null)
    ]);
    const availableModels = filterAvailableProviderModels({
      exposeFake: exposeFakeProvider(env),
      memberships: user.groups,
      models: models as CatalogProviderModelRow[],
      userId
    });
    const exposedModels = filterExposedProviderModels({
      entitlements,
      models: availableModels
    });
    const exposedSearchOptions = filterExposedSearchOptions({
      availableProviderModels: availableModels,
      entitlements,
      exposedProviderModels: exposedModels,
      memberships: user.groups,
      searchOptions: searchOptions as CatalogSearchOptionRow[],
      userId
    });

    return {
      entitlements,
      modelPolicy,
      models: exposedModels
        .map(providerModelToCatalogEntry)
        .filter((model): model is ProviderModelCatalogEntry => model !== null),
      searchPolicy,
      searchStrategies: exposedSearchOptions,
      settings: {
        defaultControlValues: user.settings.defaultControlValues,
        defaultModelId: user.settings.defaultProviderModelId ?? "",
        defaultProvider: user.settings.defaultProviderModel?.connectionId ?? "",
        defaultProviderConnectionId: user.settings.defaultProviderModel?.connectionId ?? null,
        defaultProviderModelId: user.settings.defaultProviderModelId,
        defaultSearchStrategyId: user.settings.defaultSearchStrategyId,
        defaultSearchPlan: user.settings.defaultSearchPlan,
        showCitations: user.settings.showCitations,
        showReasoningBlocks: user.settings.showReasoningBlocks,
        showToolActivity: user.settings.showToolActivity
      }
    };
  };
}
