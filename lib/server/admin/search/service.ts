import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  adminSearchExecutionDefaults,
  type AdminSearchCatalog,
  type AdminSearchDraft,
  type AdminSearchIntegration,
  type AdminSearchKind,
  type AdminSearchProviderModelOption,
  type AdminSearchTestEvidence
} from "../../../contracts/adminSearch";
import { isSearchCombinationCompatible } from "../../../domain/catalogMatrix";
import {
  decodeSearchPlan,
  GEMINI_PROVIDER_SEARCH_INTEGRATION_ID,
  GEMINI_PROVIDER_SEARCH_STRATEGY_ID,
  OPENAI_PROVIDER_SEARCH_INTEGRATION_ID,
  OPENAI_PROVIDER_SEARCH_STRATEGY_ID,
  type SearchPlan
} from "../../../domain/search";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import { lowestSupportedOpenAIResponsesSearchEffort } from "../../providers/openaiResponsesSearch";
import {
  SearchConfigurationError,
  compatibleTechnicalAdapter,
  legacySearchKind,
  normalizeSearchDraft,
  searchDraftHash
} from "../../search/configuration";
import {
  searchValidationFingerprint,
  type SearchProbeBinding
} from "../../search/probeBinding";

export type AdminSearchTester = Readonly<{
  currentBinding?(input: Readonly<{
    providerModelId: string;
    store: PrismaClient | Prisma.TransactionClient;
    userId: string;
  }>): Promise<SearchProbeBinding>;
  test(input: Readonly<{
    draft: AdminSearchDraft;
    userId: string;
  }>): Promise<Omit<AdminSearchTestEvidence, "checkedAt"> & Readonly<{
    probeBinding: SearchProbeBinding;
  }>>;
}>;

export type AdminSearchServiceErrorCode =
  | "search_activation_evidence_missing"
  | "search_configuration_invalid"
  | "search_configuration_unavailable"
  | "search_default_unavailable"
  | "search_draft_stale"
  | "search_integration_material_identity_changed"
  | "search_integration_not_found"
  | "search_name_invalid"
  | "search_policy_stale"
  | "search_provider_model_not_available"
  | "search_source_not_ready"
  | "search_system_integration_forbidden"
  | "search_test_failed";

export class AdminSearchServiceError extends Error {
  constructor(readonly code: AdminSearchServiceErrorCode) {
    super(code);
    this.name = "AdminSearchServiceError";
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new AdminSearchServiceError("search_name_invalid");
  }
  return value.trim();
}

function normalizedDraft(value: unknown): AdminSearchDraft {
  try {
    return normalizeSearchDraft(value);
  } catch (error) {
    if (error instanceof SearchConfigurationError) {
      throw new AdminSearchServiceError(error.code);
    }
    throw error;
  }
}

function optionalDraft(value: unknown): AdminSearchDraft | null {
  try {
    return normalizeSearchDraft(value);
  } catch {
    return null;
  }
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || "search";
}

function testEvidence(value: unknown): AdminSearchTestEvidence | null {
  const evidence = record(value);
  if (
    (evidence.method !== "configuration" && evidence.method !== "provider_search") ||
    (evidence.status !== "available" && evidence.status !== "unavailable") ||
    typeof evidence.protocol !== "string" ||
    typeof evidence.checkedAt !== "string" ||
    !Number.isSafeInteger(evidence.normalizedSourceCount)
  ) {
    return null;
  }
  // Explicitly project the public diagnostics shape. Stored source evidence
  // also carries a server-only exact authority tuple and must never expose it
  // through the administrator API.
  return {
    checkedAt: evidence.checkedAt,
    method: evidence.method,
    normalizedSourceCount: evidence.normalizedSourceCount as number,
    protocol: evidence.protocol as AdminSearchTestEvidence["protocol"],
    status: evidence.status
  };
}

function providerModelConfiguration(value: unknown) {
  try {
    return normalizeProviderModelConfiguration(value);
  } catch {
    return null;
  }
}

function logicalKind(value: unknown): AdminSearchKind | null {
  return value === "gemini_google_search" || value === "perplexity_search" ||
    value === "web_search"
    ? value
    : null;
}

function draftKind(draft: AdminSearchDraft): AdminSearchKind {
  if (draft.protocol === "gemini_google_search") return "gemini_google_search";
  if (draft.protocol === "openrouter_perplexity_chat") return "perplexity_search";
  return "web_search";
}

function clientSearchKind(adapterKind: string): AdminSearchProviderModelOption["searchKind"] | null {
  if (adapterKind === "openai_responses_native" || adapterKind === "openai_responses_compatible") {
    return "web_search";
  }
  if (adapterKind === "gemini_interactions_native") return "gemini_google_search";
  return adapterKind === "openrouter_chat_completions" ? "perplexity_search" : null;
}

function materialIdentity(draft: AdminSearchDraft): string {
  // The logical source owns the exact provider connection. Its client route may
  // move between eligible technical models on that same source without
  // changing transport semantics; sourceConnectionId is checked separately.
  return [draft.adapterKind, draft.credentialMode, draft.protocol].join("\u0000");
}

function clientRouteIdentities(
  option: Pick<SearchOptionRow, "id" | "optionId" | "templateKey">,
  sourceConnectionId: string,
  generatedId: string
): readonly Readonly<{ id: string; strategyId: string }>[] {
  if (option.templateKey === "search:openai" && option.optionId === "openai-native-web-search") {
    const fallbackId = `openai-search-client:${sourceConnectionId}`;
    return [
      {
        id: OPENAI_PROVIDER_SEARCH_INTEGRATION_ID,
        strategyId: OPENAI_PROVIDER_SEARCH_STRATEGY_ID
      },
      { id: fallbackId, strategyId: fallbackId }
    ];
  }
  if (
    option.templateKey === "search:gemini-google" &&
    option.optionId === "gemini-google-search"
  ) {
    const fallbackId = `gemini-search-client:${sourceConnectionId}`;
    return [
      {
        id: GEMINI_PROVIDER_SEARCH_INTEGRATION_ID,
        strategyId: GEMINI_PROVIDER_SEARCH_STRATEGY_ID
      },
      { id: fallbackId, strategyId: fallbackId }
    ];
  }
  if (
    option.templateKey === null &&
    option.optionId === `custom-web-search:${sourceConnectionId}`
  ) {
    const routeId = `custom-web-search-client:${sourceConnectionId}`;
    return [{ id: routeId, strategyId: routeId }];
  }
  return [{ id: generatedId, strategyId: `${option.optionId}:client` }];
}

function hostedRouteIdentity(
  option: Pick<SearchOptionRow, "optionId" | "templateKey">,
  sourceConnectionId: string,
  generatedId: string
): Readonly<{ id: string; strategyId: string }> {
  if (
    option.templateKey === null &&
    option.optionId === `custom-web-search:${sourceConnectionId}`
  ) {
    const routeId = `custom-web-search-hosted:${sourceConnectionId}`;
    return { id: routeId, strategyId: routeId };
  }
  if (option.templateKey === "search:openai" && option.optionId === "openai-native-web-search") {
    return {
      id: `openai-search-hosted:${sourceConnectionId}`,
      strategyId: option.optionId
    };
  }
  if (
    option.templateKey === "search:gemini-google" &&
    option.optionId === "gemini-google-search"
  ) {
    return {
      id: "00000000-0000-4000-8000-000000001301",
      strategyId: option.optionId
    };
  }
  return { id: generatedId, strategyId: `${option.optionId}:hosted` };
}

function hostedDraftFor(draft: AdminSearchDraft): AdminSearchDraft | null {
  return draft.protocol === "openai_responses_web_search" ||
    draft.protocol === "gemini_google_search"
    ? {
        ...draft,
        adapterKind: "answer_provider_hosted",
        credentialMode: "answer_provider",
        maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
        maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
        providerModelId: null,
        reasoningPolicy: "provider_default"
      }
    : null;
}

type RuntimeProviderModel = AdminSearchProviderModelOption & {
  adapterKind: string;
  nativeSearch: boolean;
};

type SearchChild = {
  activeRevision: null | {
    adapterKind: string;
    configuration: unknown;
    credentialMode: string;
    draftHash: string;
    id: string;
    providerModelId: string | null;
    revisionNumber: number;
    validationEvidence: unknown;
  };
  activeRevisionId: string | null;
  activatedAt: Date | null;
  adapterKind: string;
  archivedAt: Date | null;
  draft: unknown;
  draftTestEvidence: unknown;
  draftVersion: number;
  enabled: boolean;
  id: string;
  providerModelId: string | null;
  revisions?: Array<{ revisionNumber: number }>;
  strategyId: string;
  testedDraftHash: string | null;
};

type SearchOptionRow = {
  archivedAt: Date | null;
  description: string;
  displayName: string;
  enabled: boolean;
  id: string;
  kind: string;
  optionId: string;
  sourceConnectionId: string | null;
  strategies: SearchChild[];
  templateKey: string | null;
};

function hasAmbiguousAdapterChildren(option: Pick<SearchOptionRow, "strategies">): boolean {
  const seen = new Set<string>();
  for (const child of option.strategies) {
    if (child.archivedAt !== null) continue;
    if (child.adapterKind !== "answer_provider_hosted" &&
      child.adapterKind !== "provider_model_client") continue;
    if (seen.has(child.adapterKind)) return true;
    seen.add(child.adapterKind);
  }
  return false;
}

function editableChild(option: Pick<SearchOptionRow, "kind" | "strategies">): {
  child: SearchChild;
  draft: AdminSearchDraft;
} | null {
  if (hasAmbiguousAdapterChildren(option)) return null;
  const kind = logicalKind(option.kind);
  if (!kind) return null;
  for (const child of option.strategies) {
    if (child.archivedAt) continue;
    const draft = optionalDraft(child.draft);
    if (draft?.adapterKind === "provider_model_client" && draftKind(draft) === kind) {
      return { child, draft };
    }
  }
  return null;
}

function activeChildDraft(child: SearchChild): AdminSearchDraft | null {
  if (!child.enabled || !child.activeRevisionId || !child.activeRevision) return null;
  const draft = optionalDraft(child.activeRevision.configuration);
  if (
    !draft ||
    child.activeRevision.id !== child.activeRevisionId ||
    child.activeRevision.adapterKind !== draft.adapterKind ||
    child.activeRevision.credentialMode !== draft.credentialMode ||
    child.activeRevision.providerModelId !== draft.providerModelId ||
    child.providerModelId !== draft.providerModelId
  ) {
    return null;
  }
  return draft;
}

function routeReady(
  option: SearchOptionRow,
  child: SearchChild,
  providerModels: readonly RuntimeProviderModel[]
): { adapterKind: AdminSearchDraft["adapterKind"]; draft: AdminSearchDraft } | null {
  const kind = logicalKind(option.kind);
  const draft = activeChildDraft(child);
  if (!kind || !draft || !option.sourceConnectionId || draftKind(draft) !== kind) return null;
  if (draft.adapterKind === "provider_model_client") {
    const model = providerModels.find((candidate) => candidate.id === draft.providerModelId);
    return model?.enabled && model.connectionId === option.sourceConnectionId &&
      model.nativeSearch && compatibleTechnicalAdapter(draft.protocol, model.adapterKind)
      ? { adapterKind: draft.adapterKind, draft }
      : null;
  }
  return providerModels.some((model) =>
    model.enabled && model.connectionId === option.sourceConnectionId && model.nativeSearch &&
    compatibleTechnicalAdapter(draft.protocol, model.adapterKind)
  )
    ? { adapterKind: draft.adapterKind, draft }
    : null;
}

function serializeIntegration(
  option: SearchOptionRow,
  providerModels: readonly RuntimeProviderModel[]
): AdminSearchIntegration | null {
  const kind = logicalKind(option.kind);
  if (!kind || !option.sourceConnectionId) return null;
  const ambiguousRoutes = hasAmbiguousAdapterChildren(option);
  const editable = ambiguousRoutes ? null : editableChild(option);
  const readyRoutes = ambiguousRoutes ? [] : option.strategies.flatMap((child) => {
    const route = routeReady(option, child, providerModels);
    return route ? [route] : [];
  });
  const readyClient = readyRoutes.some((route) => route.adapterKind === "provider_model_client");
  const readyHosted = readyRoutes.some((route) => route.adapterKind === "answer_provider_hosted");
  const ready = readyClient || readyHosted;
  const configuration = editable?.draft ?? null;
  const providerModel = configuration?.providerModelId
    ? providerModels.find((candidate) => candidate.id === configuration.providerModelId) ?? null
    : null;
  const evidence = editable ? testEvidence(editable.child.draftTestEvidence) : null;
  const activeEditableDraft = editable ? activeChildDraft(editable.child) : null;
  const configurationActive = Boolean(
    editable && activeEditableDraft &&
    searchDraftHash(activeEditableDraft) === searchDraftHash(editable.draft)
  );
  return {
    archivedAt: option.archivedAt?.toISOString() ?? null,
    broaderModelSetup: kind !== "web_search"
      ? "not_applicable"
      : readyClient
        ? "ready"
        : "setup_required",
    configurable: Boolean(editable),
    configuration,
    configurationActive,
    description: option.description,
    displayName: option.displayName,
    draftDirty: Boolean(editable && !configurationActive),
    draftTestEvidence: evidence,
    draftVersion: editable?.child.draftVersion ?? 0,
    enabled: option.enabled,
    executionModes: readyClient
      ? ["all_selected", "model_choice"]
      : readyHosted
        ? ["model_choice"]
        : [],
    id: option.id,
    kind,
    providerModel: providerModel
      ? {
          connectionDisplayName: providerModel.connectionDisplayName,
          connectionId: providerModel.connectionId,
          displayName: providerModel.displayName,
          id: providerModel.id
        }
      : null,
    ready,
    readiness: ready
      ? "ready"
      : option.strategies.some((child) => child.activeRevisionId && child.activeRevision)
        ? "source_unavailable"
        : "setup_required",
    sourceConnectionId: option.sourceConnectionId,
    strategyId: option.optionId,
    system: option.templateKey !== null
  };
}

export function createAdminSearchService(input: Readonly<{
  idFactory?: () => string;
  now?: () => Date;
  prisma: PrismaClient;
  tester: AdminSearchTester;
}>) {
  const idFactory = input.idFactory ?? randomUUID;
  const now = input.now ?? (() => new Date());

  async function policy() {
    const row = await input.prisma.searchPolicy.findUnique({ where: { id: "installation" } });
    if (!row) throw new Error("installation_search_policy_missing");
    const decoded = decodeSearchPlan(row.defaultPlan);
    return {
      defaultPlan: decoded.ok ? decoded.plan : { mode: "all_selected" as const, optionIds: [] },
      updatedAt: row.updatedAt.toISOString(),
      version: row.version
    };
  }

  async function providerModelForDraft(
    draft: AdminSearchDraft,
    store: PrismaClient | Prisma.TransactionClient = input.prisma
  ) {
    if (
      draft.adapterKind !== "provider_model_client" ||
      draft.credentialMode !== "provider_model" ||
      !draft.providerModelId
    ) {
      throw new AdminSearchServiceError("search_configuration_invalid");
    }
    const model = await store.providerModel.findFirst({
      include: { connection: true },
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        activatedAt: { not: null },
        connection: {
          activeConfig: { not: Prisma.DbNull },
          activeVersion: { gt: 0 },
          activatedAt: { not: null },
          enabled: true
        },
        enabled: true,
        id: draft.providerModelId
      }
    });
    if (!model) throw new AdminSearchServiceError("search_provider_model_not_available");
    const configuration = providerModelConfiguration(model.activeConfig);
    if (
      !configuration ||
      clientSearchKind(configuration.adapterKind) !== draftKind(draft) ||
      !compatibleTechnicalAdapter(draft.protocol, configuration.adapterKind) ||
      configuration.capabilities.nativeSearch !== true
    ) {
      throw new AdminSearchServiceError("search_provider_model_not_available");
    }
    return { configuration, model };
  }

  function configurationEvidence(draft: AdminSearchDraft): AdminSearchTestEvidence {
    return {
      checkedAt: now().toISOString(),
      method: "configuration",
      normalizedSourceCount: 0,
      protocol: draft.protocol,
      status: "available"
    };
  }

  async function publishChild(
    tx: Prisma.TransactionClient,
    child: SearchChild,
    draft: AdminSearchDraft,
    technical: Awaited<ReturnType<typeof providerModelForDraft>>
  ): Promise<void> {
    const evidence = configurationEvidence(draft);
    const draftHash = searchDraftHash(draft);
    const validationFingerprint = searchValidationFingerprint(evidence);
    const activeDraft = child.activeRevision
      ? optionalDraft(child.activeRevision.configuration)
      : null;
    const activeIsConfigurationRevision = Boolean(
      child.activeRevision && activeDraft &&
      child.activeRevision.id === child.activeRevisionId &&
      child.activeRevision.draftHash === draftHash &&
      searchDraftHash(activeDraft) === draftHash &&
      record(child.activeRevision.validationEvidence).method === "configuration"
    );
    let revision = activeIsConfigurationRevision
      ? child.activeRevision
      : await tx.searchIntegrationRevision.findUnique({
          where: {
            searchStrategyId_draftHash_validationFingerprint: {
              draftHash,
              searchStrategyId: child.id,
              validationFingerprint
            }
          }
        });
    revision ??= await tx.searchIntegrationRevision.create({
      data: {
        adapterKind: draft.adapterKind,
        configuration: json(draft),
        credentialMode: draft.credentialMode,
        draftHash,
        providerModelId: draft.providerModelId,
        revisionNumber: (child.revisions?.[0]?.revisionNumber ?? 0) + 1,
        searchStrategyId: child.id,
        validationEvidence: json(evidence),
        validationFingerprint
      }
    });
    await tx.searchStrategy.update({
      data: {
        activatedAt: now(),
        activeRevisionId: revision.id,
        adapterKind: draft.adapterKind,
        config: json(draft),
        credentialMode: draft.credentialMode,
        draft: json(draft),
        enabled: true,
        kind: legacySearchKind(draft.protocol, draft.adapterKind),
        modelId: draft.adapterKind === "provider_model_client"
          ? technical.configuration.upstreamModelId
          : null,
        provider: technical.model.connection.family,
        providerModelId: draft.providerModelId
      },
      where: { id: child.id }
    });
  }

  async function publishLogicalOption(
    tx: Prisma.TransactionClient,
    option: SearchOptionRow
  ): Promise<void> {
    const editable = editableChild(option);
    if (!editable) throw new AdminSearchServiceError("search_configuration_unavailable");
    const technical = await providerModelForDraft(editable.draft, tx);
    if (technical.model.connectionId !== option.sourceConnectionId) {
      throw new AdminSearchServiceError("search_provider_model_not_available");
    }
    if (editable.child.activeRevision) {
      const active = normalizedDraft(editable.child.activeRevision.configuration);
      if (materialIdentity(active) !== materialIdentity(editable.draft)) {
        throw new AdminSearchServiceError("search_integration_material_identity_changed");
      }
    }
    await publishChild(tx, editable.child, editable.draft, technical);

    const hostedDraft = hostedDraftFor(editable.draft);
    if (!hostedDraft) return;
    const hostedChildren = option.strategies.filter((child) =>
      child.archivedAt === null && child.adapterKind === "answer_provider_hosted"
    );
    if (hostedChildren.length !== 1) {
      throw new AdminSearchServiceError("search_configuration_unavailable");
    }
    await publishChild(tx, hostedChildren[0]!, hostedDraft, technical);
  }

  async function list(_args: Readonly<{ userId?: string }> = {}): Promise<AdminSearchCatalog> {
    const [options, providerModels, searchPolicy] = await Promise.all([
      input.prisma.searchOption.findMany({
        include: {
          strategies: {
            include: {
              activeRevision: {
                select: {
                  adapterKind: true,
                  configuration: true,
                  credentialMode: true,
                  draftHash: true,
                  id: true,
                  providerModelId: true,
                  revisionNumber: true,
                  validationEvidence: true
                }
              }
            },
            orderBy: { strategyId: "asc" }
          }
        },
        orderBy: [{ archivedAt: "asc" }, { displayName: "asc" }, { optionId: "asc" }]
      }),
      input.prisma.providerModel.findMany({
        include: {
          connection: {
            select: {
              activeConfig: true,
              activeVersion: true,
              activatedAt: true,
              displayName: true,
              enabled: true,
              id: true
            }
          }
        },
        orderBy: [{ connectionId: "asc" }, { displayName: "asc" }, { id: "asc" }],
        where: { activeConfig: { not: Prisma.DbNull }, activeVersion: { gt: 0 } }
      }),
      policy()
    ]);
    const runtimeModels: RuntimeProviderModel[] = providerModels.flatMap((model) => {
      const configuration = providerModelConfiguration(model.activeConfig);
      if (!configuration) return [];
      const searchKind = clientSearchKind(configuration.adapterKind) ?? "web_search";
      return [{
        adapterKind: configuration.adapterKind,
        connectionDisplayName: model.connection.displayName,
        connectionId: model.connectionId,
        displayName: model.displayName,
        enabled: model.enabled && Boolean(model.activatedAt) && model.connection.enabled &&
          model.connection.activeVersion > 0 && Boolean(model.connection.activatedAt) &&
          model.connection.activeConfig !== null,
        id: model.id,
        nativeSearch: configuration.capabilities.nativeSearch,
        searchReasoningSupported:
          (configuration.adapterKind === "openai_responses_native" ||
            configuration.adapterKind === "openai_responses_compatible" ||
            configuration.adapterKind === "gemini_interactions_native") &&
          Boolean(lowestSupportedOpenAIResponsesSearchEffort(configuration.capabilities)),
        searchKind
      }];
    });
    return {
      integrations: (options as SearchOptionRow[]).flatMap((option) => {
        if (option.kind === "none") return [];
        const integration = serializeIntegration(option, runtimeModels);
        return integration ? [integration] : [];
      }),
      policy: searchPolicy,
      providerModels: runtimeModels.flatMap((model) => {
        const searchKind = clientSearchKind(model.adapterKind);
        return model.nativeSearch && searchKind
          ? [{
              connectionDisplayName: model.connectionDisplayName,
              connectionId: model.connectionId,
              displayName: model.displayName,
              enabled: model.enabled,
              id: model.id,
              searchReasoningSupported: model.searchReasoningSupported,
              searchKind
            }]
          : [];
      })
    };
  }

  async function updatePolicy(args: Readonly<{
    defaultPlan: unknown;
    expectedVersion: number;
    userId: string;
  }>): Promise<void> {
    const decoded = decodeSearchPlan(args.defaultPlan);
    if (!decoded.ok) throw new AdminSearchServiceError("search_default_unavailable");
    const catalog = await list({ userId: args.userId });
    const selectable = catalog.integrations
      .filter((integration) => integration.enabled && !integration.archivedAt && integration.ready)
      .map((integration) => ({
        executionModes: integration.executionModes,
        kind: integration.kind === "perplexity_search"
          ? "perplexity_tool_search" as const
          : integration.kind,
        strategyId: integration.strategyId
      }));
    const plan: SearchPlan = decoded.plan;
    if (plan.optionIds.some((optionId) =>
      !selectable.some((integration) => integration.strategyId === optionId)) ||
      (plan.mode === "all_selected" && plan.optionIds.some((optionId) =>
        !selectable.find((integration) => integration.strategyId === optionId)
          ?.executionModes.includes("all_selected"))) ||
      !isSearchCombinationCompatible(plan.optionIds, selectable, plan.mode)) {
      throw new AdminSearchServiceError("search_default_unavailable");
    }
    const updated = await input.prisma.searchPolicy.updateMany({
      data: {
        defaultPlan: json(plan),
        updatedByUserId: args.userId,
        version: { increment: 1 }
      },
      where: { id: "installation", version: args.expectedVersion }
    });
    if (updated.count !== 1) throw new AdminSearchServiceError("search_policy_stale");
  }

  async function createDraft(args: Readonly<{
    description: string;
    displayName: string;
    draft: unknown;
  }>): Promise<Readonly<{ created: boolean; id: string }>> {
    const displayName = text(args.displayName, 160);
    const description = text(args.description, 500);
    const draft = normalizedDraft(args.draft);
    const technical = await providerModelForDraft(draft);
    const optionRowId = idFactory();
    const strategyRowId = idFactory();
    const optionId = `${slug(displayName)}-${optionRowId.slice(0, 8)}`;
    return input.prisma.$transaction(async (tx) => {
      const kind = draftKind(draft);
      // Keep the same lock order as provider Quick setup. The second read after
      // the connection lock also sees a parent created by a concurrent admin
      // request that initially found no row to lock.
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "SearchOption"
        WHERE "sourceConnectionId" = ${technical.model.connectionId}
          AND "kind" = ${kind}
        ORDER BY "id"
        FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "ProviderConnection"
        WHERE "id" = ${technical.model.connectionId}
        FOR UPDATE
      `);
      const matchingOptions = await tx.searchOption.findMany({
        include: {
          strategies: {
            include: {
              activeRevision: true,
              revisions: { orderBy: { revisionNumber: "desc" }, take: 1 }
            },
            orderBy: { strategyId: "asc" }
          }
        },
        orderBy: { id: "asc" },
        where: {
          kind,
          sourceConnectionId: technical.model.connectionId
        }
      }) as SearchOptionRow[];
      if (matchingOptions.length > 1) {
        throw new AdminSearchServiceError("search_configuration_unavailable");
      }
      async function availableRoute(
        candidates: readonly Readonly<{ id: string; strategyId: string }>[]
      ): Promise<Readonly<{ id: string; strategyId: string }>> {
        for (const candidate of candidates) {
          const idOwner = await tx.searchStrategy.findUnique({ where: { id: candidate.id } });
          const strategyOwner = await tx.searchStrategy.findUnique({
            where: { strategyId: candidate.strategyId }
          });
          if (!idOwner && !strategyOwner) return candidate;
        }
        throw new AdminSearchServiceError("search_configuration_unavailable");
      }
      async function createRoute(
        option: Pick<SearchOptionRow, "description" | "displayName" | "id">,
        route: Readonly<{ id: string; strategyId: string }>,
        routeDraft: AdminSearchDraft,
        enabled: boolean
      ): Promise<void> {
        const client = routeDraft.adapterKind === "provider_model_client";
        await tx.searchStrategy.create({
          data: {
            adapterKind: routeDraft.adapterKind,
            config: json({}),
            credentialMode: routeDraft.credentialMode,
            description: option.description,
            displayName: option.displayName,
            draft: json(routeDraft),
            enabled,
            id: route.id,
            kind: legacySearchKind(routeDraft.protocol, routeDraft.adapterKind),
            modelId: client ? technical.configuration.upstreamModelId : null,
            provider: technical.model.connection.family,
            providerModelId: client ? routeDraft.providerModelId : null,
            searchOptionId: option.id,
            strategyId: route.strategyId
          }
        });
      }
      async function publishOption(optionId: string): Promise<void> {
        const refreshed = await tx.searchOption.findUnique({
          include: {
            strategies: {
              include: {
                activeRevision: true,
                revisions: { orderBy: { revisionNumber: "desc" }, take: 1 }
              },
              orderBy: { strategyId: "asc" }
            }
          },
          where: { id: optionId }
        }) as SearchOptionRow | null;
        if (!refreshed) {
          throw new AdminSearchServiceError("search_integration_not_found");
        }
        await publishLogicalOption(tx, refreshed);
      }
      async function ensureHostedRoute(
        option: SearchOptionRow,
        generatedId: string
      ): Promise<void> {
        const hostedDraft = hostedDraftFor(draft);
        if (!hostedDraft) return;
        const hostedChildren = option.strategies.filter((child) =>
          child.adapterKind === "answer_provider_hosted"
        );
        if (hostedChildren.some((child) => child.archivedAt === null)) return;
        if (hostedChildren.length === 1) {
          await tx.searchStrategy.update({
            data: { archivedAt: null, enabled: false },
            where: { id: hostedChildren[0]!.id }
          });
          return;
        }
        if (hostedChildren.length > 1) {
          throw new AdminSearchServiceError("search_configuration_unavailable");
        }
        const route = await availableRoute([
          hostedRouteIdentity(option, technical.model.connectionId, generatedId)
        ]);
        await createRoute(option, route, hostedDraft, false);
      }
      const existingOption = matchingOptions[0];
      if (existingOption) {
        const clientChildren = existingOption.strategies.filter((child) =>
          child.adapterKind === "provider_model_client"
        );
        const currentEditable = editableChild(existingOption);
        if (!currentEditable) {
          const archivedEditable = clientChildren.filter((child) =>
            child.archivedAt !== null && optionalDraft(child.draft)?.adapterKind ===
              "provider_model_client"
          );
          if (archivedEditable.length === 1) {
            await tx.searchStrategy.update({
              data: {
                archivedAt: null,
                draft: json(draft),
                draftTestEvidence: Prisma.DbNull,
                draftVersion: { increment: 1 },
                enabled: false,
                testedDraftHash: null
              },
              where: { id: archivedEditable[0]!.id }
            });
          } else if (clientChildren.length > 0) {
            throw new AdminSearchServiceError("search_configuration_unavailable");
          } else {
            const route = await availableRoute(clientRouteIdentities(
              existingOption,
              technical.model.connectionId,
              strategyRowId
            ));
            await createRoute(existingOption, route, draft, true);
          }
        } else if (
          existingOption.archivedAt &&
          searchDraftHash(currentEditable.draft) !== searchDraftHash(draft)
        ) {
          // Reopening an archived logical source honors the model selected in
          // the Add flow while retaining prior immutable revision history.
          await tx.searchStrategy.update({
            data: {
              draft: json(draft),
              draftTestEvidence: Prisma.DbNull,
              draftVersion: { increment: 1 },
              enabled: false,
              testedDraftHash: null
            },
            where: { id: currentEditable.child.id }
          });
        }
        await ensureHostedRoute(existingOption, idFactory());
        if (existingOption.archivedAt) {
          await tx.searchOption.update({
            data: { archivedAt: null, enabled: false },
            where: { id: existingOption.id }
          });
        }
        await publishOption(existingOption.id);
        return { created: false, id: existingOption.id };
      }
      await tx.searchOption.create({
        data: {
          description,
          displayName,
          enabled: false,
          id: optionRowId,
          kind,
          optionId,
          sourceConnectionId: technical.model.connectionId
        }
      });
      await tx.searchStrategy.create({
        data: {
          adapterKind: draft.adapterKind,
          config: json({}),
          credentialMode: draft.credentialMode,
          description,
          displayName,
          draft: json(draft),
          enabled: true,
          id: strategyRowId,
          kind: legacySearchKind(draft.protocol, draft.adapterKind),
          modelId: technical.configuration.upstreamModelId,
          provider: technical.model.connection.family,
          providerModelId: draft.providerModelId,
          searchOptionId: optionRowId,
          strategyId: `${optionId}:client`
        }
      });
      const hostedDraft = hostedDraftFor(draft);
      if (hostedDraft) {
        await createRoute(
          {
            description,
            displayName,
            id: optionRowId
          },
          hostedRouteIdentity({ optionId, templateKey: null }, technical.model.connectionId, idFactory()),
          hostedDraft,
          false
        );
      }
      await publishOption(optionRowId);
      return { created: true, id: optionRowId };
    });
  }

  async function updateDraft(args: Readonly<{
    description: string;
    displayName: string;
    draft: unknown;
    expectedDraftVersion: number;
    id: string;
  }>): Promise<void> {
    const displayName = text(args.displayName, 160);
    const description = text(args.description, 500);
    const draft = normalizedDraft(args.draft);
    await input.prisma.$transaction(async (tx) => {
      const option = await tx.searchOption.findUnique({
        include: {
          strategies: {
            include: {
              activeRevision: true,
              revisions: { orderBy: { revisionNumber: "desc" }, take: 1 }
            },
            orderBy: { strategyId: "asc" }
          }
        },
        where: { id: args.id }
      }) as SearchOptionRow | null;
      if (!option || option.kind === "none") {
        throw new AdminSearchServiceError("search_integration_not_found");
      }
      const editable = editableChild(option);
      if (!editable) throw new AdminSearchServiceError("search_configuration_unavailable");
      const technical = await providerModelForDraft(draft, tx);
      if (technical.model.connectionId !== option.sourceConnectionId) {
        throw new AdminSearchServiceError("search_provider_model_not_available");
      }
      if (editable.child.activeRevision) {
        const active = normalizedDraft(editable.child.activeRevision.configuration);
        if (materialIdentity(active) !== materialIdentity(draft)) {
          throw new AdminSearchServiceError("search_integration_material_identity_changed");
        }
      }
      const updated = await tx.searchStrategy.updateMany({
        data: {
          description,
          displayName,
          draft: json(draft),
          draftTestEvidence: Prisma.DbNull,
          draftVersion: { increment: 1 },
          testedDraftHash: null
        },
        where: { draftVersion: args.expectedDraftVersion, id: editable.child.id }
      });
      if (updated.count !== 1) throw new AdminSearchServiceError("search_draft_stale");
      editable.child.draft = draft;
      editable.child.draftTestEvidence = null;
      editable.child.draftVersion += 1;
      editable.child.testedDraftHash = null;
      await tx.searchOption.update({
        data: { description, displayName },
        where: { id: option.id }
      });
      await publishLogicalOption(tx, option);
    });
  }

  async function testDraft(args: Readonly<{ id: string; userId: string }>): Promise<void> {
    const option = await input.prisma.searchOption.findUnique({
      include: { strategies: { include: { activeRevision: true }, orderBy: { strategyId: "asc" } } },
      where: { id: args.id }
    }) as SearchOptionRow | null;
    if (!option) throw new AdminSearchServiceError("search_integration_not_found");
    const editable = editableChild(option);
    if (!editable) throw new AdminSearchServiceError("search_configuration_unavailable");
    const technical = await providerModelForDraft(editable.draft);
    if (technical.model.connectionId !== option.sourceConnectionId) {
      throw new AdminSearchServiceError("search_provider_model_not_available");
    }
    let outcome: Omit<AdminSearchTestEvidence, "checkedAt"> & Readonly<{
      probeBinding: SearchProbeBinding;
    }>;
    try {
      outcome = await input.tester.test({ draft: editable.draft, userId: args.userId });
    } catch {
      throw new AdminSearchServiceError("search_test_failed");
    }
    if (
      outcome.probeBinding.providerModelId !== editable.draft.providerModelId ||
      outcome.probeBinding.connectionId !== option.sourceConnectionId
    ) {
      throw new AdminSearchServiceError("search_test_failed");
    }
    const evidence = { ...outcome, checkedAt: now().toISOString() };
    const updated = await input.prisma.searchStrategy.updateMany({
      data: {
        draftTestEvidence: json(evidence),
        testedDraftHash: searchDraftHash(editable.draft)
      },
      where: { draftVersion: editable.child.draftVersion, id: editable.child.id }
    });
    if (updated.count !== 1) throw new AdminSearchServiceError("search_draft_stale");
  }

  async function activate(args: Readonly<{ id: string; userId: string }>): Promise<void> {
    await input.prisma.$transaction(async (tx) => {
      const option = await tx.searchOption.findUnique({
        include: {
          strategies: {
            include: {
              activeRevision: true,
              revisions: { orderBy: { revisionNumber: "desc" }, take: 1 }
            },
            orderBy: { strategyId: "asc" }
          }
        },
        where: { id: args.id }
      }) as SearchOptionRow | null;
      if (!option) throw new AdminSearchServiceError("search_integration_not_found");
      // Compatibility endpoint: activation is now a network-free publication
      // of the saved configuration. It never depends on a prior live check or
      // on the credential version used by one administrator.
      await publishLogicalOption(tx, option);
    });
  }

  async function setEnabled(args: Readonly<{
    enabled: boolean;
    id: string;
    userId: string;
  }>): Promise<void> {
    const source = (await list({ userId: args.userId })).integrations.find(
      (integration) => integration.id === args.id
    );
    if (!source) throw new AdminSearchServiceError("search_integration_not_found");
    if (args.enabled && (!source.ready || source.archivedAt)) {
      throw new AdminSearchServiceError("search_source_not_ready");
    }
    await input.prisma.searchOption.update({
      data: { enabled: args.enabled },
      where: { id: args.id }
    });
  }

  async function archive(args: Readonly<{ id: string }>): Promise<void> {
    const current = await input.prisma.searchOption.findUnique({
      select: { templateKey: true },
      where: { id: args.id }
    });
    if (!current) throw new AdminSearchServiceError("search_integration_not_found");
    if (current.templateKey !== null) {
      throw new AdminSearchServiceError("search_system_integration_forbidden");
    }
    await input.prisma.searchOption.update({
      data: { archivedAt: now(), enabled: false },
      where: { id: args.id }
    });
  }

  return Object.freeze({
    activate,
    archive,
    createDraft,
    list,
    setEnabled,
    testDraft,
    updateDraft,
    updatePolicy
  });
}
