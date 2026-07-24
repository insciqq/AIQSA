import {
  resolveProviderModelParameterControls,
  type CatalogAdapterKind,
  type ProviderModelCatalogEntry,
  type SearchStrategyCatalogEntry
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
import { isRunProfileId } from "@/lib/domain/runProfiles";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderDefaultParams,
  normalizeProviderModelCapabilities,
  normalizeProviderModelConfiguration,
  type ProviderModelConfiguration
} from "@/lib/server/providers/providerConfiguration";
import { resolveProviderModelCapabilities } from "@/lib/server/providers/providerModelCapabilities";
import type {
  PrismaClient,
  ProviderConnection,
  ProviderCredential,
  ProviderCredentialVersion,
  ProviderGroupCredentialAssignment,
  ProviderModel,
  ProviderModelCredentialCheck,
  SearchStrategy
} from "@prisma/client";

type CatalogPrismaClient = Pick<PrismaClient, "providerModel" | "runProfile" | "searchStrategy" | "user">;

type PromptPresetRow = {
  developerPrompt: string | null;
  id: string;
  isDefault: boolean;
  name: string;
  systemPrompt: string;
};

type UserSettingsRow = {
  defaultControlValues: unknown;
  defaultPromptPresetId: string | null;
  defaultProviderModel: { connectionId: string } | null;
  defaultProviderModelId: string | null;
  defaultSearchStrategyId: string;
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
  promptPresets: PromptPresetRow[];
  settings: UserSettingsRow | null;
};

type CatalogCredentialRow = Pick<ProviderCredential, "enabled" | "id"> & {
  activeVersion: Pick<ProviderCredentialVersion, "id" | "revokedAt"> | null;
  groupAssignments: Pick<ProviderGroupCredentialAssignment, "credentialId" | "groupId">[];
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

const supportedSearchStrategies = new Map<string, SearchStrategyCatalogEntry["kind"]>([
  ["openai-native-web-search", "openai_native_web_search"],
  ["perplexity-tool-search", "perplexity_tool_search"],
  ["search-disabled", "none"]
]);

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

function isProviderModelAvailable(input: {
  exposeFake: boolean;
  memberships: CatalogMembershipRow[];
  model: CatalogProviderModelRow;
}): boolean {
  const configuration = activeModelConfiguration(input.model);
  if (!configuration) {
    return false;
  }

  if (configuration.adapterKind === "fake") {
    return input.exposeFake;
  }

  const credentials = input.model.connection.credentials;
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
    memberships: input.memberships.map((membership) => ({
      archived: Boolean(membership.group.archivedAt),
      groupId: membership.groupId
    })),
    policy: input.model.connection.unassignedPolicy
  });

  return (
    resolution.ok &&
    hasCurrentAvailableCheck(
      input.model,
      resolution.credentialId,
      resolution.credentialVersionId
    )
  );
}

export function filterAvailableProviderModels(input: {
  exposeFake: boolean;
  memberships: CatalogMembershipRow[];
  models: CatalogProviderModelRow[];
}): CatalogProviderModelRow[] {
  return input.models.filter((model) =>
    isProviderModelAvailable({
      exposeFake: input.exposeFake,
      memberships: input.memberships,
      model
    })
  );
}

export function filterExposedProviderModels(input: {
  entitlements: ResolvedEntitlements;
  models: CatalogProviderModelRow[];
}): CatalogProviderModelRow[] {
  return input.models.filter((model) =>
    canAccessModel(input.entitlements, model.connectionId, model.id)
  );
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
      defaultParams: configuration.defaultParams,
      providerFamily: model.connection.family,
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

export function searchStrategyToCatalogEntry(
  strategy: SearchStrategy
): SearchStrategyCatalogEntry | null {
  const kind = supportedSearchStrategies.get(strategy.strategyId);
  if (!kind || strategy.kind !== kind) {
    return null;
  }

  return {
    config: isRecord(strategy.config) ? strategy.config : {},
    description: strategy.description,
    displayName: strategy.displayName,
    kind,
    ...(strategy.modelId ? { modelId: strategy.modelId } : {}),
    provider: strategy.provider,
    ...(strategy.providerModelId ? { providerModelId: strategy.providerModelId } : {}),
    strategyId: strategy.strategyId
  };
}

export function filterExposedSearchStrategies(input: {
  availableProviderModels: CatalogProviderModelRow[];
  entitlements: ResolvedEntitlements;
  searchStrategies: SearchStrategy[];
}): SearchStrategy[] {
  const availableProviderModels = new Map(
    input.availableProviderModels.map((model) => [model.id, model])
  );

  return input.searchStrategies.filter((strategy) => {
    const kind = supportedSearchStrategies.get(strategy.strategyId);
    if (!kind || strategy.kind !== kind) {
      return false;
    }
    if (!canAccessSearchStrategy(input.entitlements, strategy.strategyId)) {
      return false;
    }
    if (kind !== "perplexity_tool_search") {
      return true;
    }

    if (!strategy.providerModelId) {
      return false;
    }
    const technicalModel = availableProviderModels.get(strategy.providerModelId);
    if (!technicalModel) {
      return false;
    }
    const configuration = activeModelConfiguration(technicalModel);
    return Boolean(
      configuration?.adapterKind === "openrouter_chat_completions" &&
      configuration.capabilities.nativeSearch
    );
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
        promptPresets: true,
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

    const [models, runProfiles, searchStrategies, entitlements] = await Promise.all([
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
                  id: true
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
      prisma.runProfile.findMany({
        orderBy: { id: "asc" },
        select: {
          description: true,
          enabled: true,
          id: true,
          providerModelId: true,
          reasoningEffort: true,
          reasoningMode: true
        }
      }),
      prisma.searchStrategy.findMany({
        orderBy: {
          strategyId: "asc"
        },
        where: {
          enabled: true
        }
      }),
      loadEntitlements(userId)
    ]);
    const availableModels = filterAvailableProviderModels({
      exposeFake: exposeFakeProvider(env),
      memberships: user.groups,
      models: models as CatalogProviderModelRow[]
    });
    const exposedModels = filterExposedProviderModels({
      entitlements,
      models: availableModels
    });
    const exposedSearchStrategies = filterExposedSearchStrategies({
      availableProviderModels: availableModels,
      entitlements,
      searchStrategies
    });

    return {
      entitlements,
      models: exposedModels
        .map(providerModelToCatalogEntry)
        .filter((model): model is ProviderModelCatalogEntry => model !== null),
      promptPresets: user.promptPresets.map((preset) => ({
        developerPrompt: preset.developerPrompt,
        id: preset.id,
        isDefault: preset.isDefault,
        name: preset.name,
        systemPrompt: preset.systemPrompt
      })),
      runProfiles: runProfiles.flatMap((profile) => isRunProfileId(profile.id)
        ? [{ ...profile, id: profile.id }]
        : []),
      searchStrategies: exposedSearchStrategies
        .map(searchStrategyToCatalogEntry)
        .filter((strategy): strategy is SearchStrategyCatalogEntry => strategy !== null),
      settings: {
        defaultControlValues: user.settings.defaultControlValues,
        defaultModelId: user.settings.defaultProviderModelId ?? "",
        defaultPromptPresetId: user.settings.defaultPromptPresetId,
        defaultProvider: user.settings.defaultProviderModel?.connectionId ?? "",
        defaultProviderConnectionId: user.settings.defaultProviderModel?.connectionId ?? null,
        defaultProviderModelId: user.settings.defaultProviderModelId,
        defaultSearchStrategyId: user.settings.defaultSearchStrategyId,
        showCitations: user.settings.showCitations,
        showReasoningBlocks: user.settings.showReasoningBlocks,
        showToolActivity: user.settings.showToolActivity
      }
    };
  };
}
