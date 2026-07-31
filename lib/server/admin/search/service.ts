import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminSearchCatalog,
  AdminSearchDraft,
  AdminSearchIntegration,
  AdminSearchProviderModelOption,
  AdminSearchReadiness,
  AdminSearchTestEvidence
} from "../../../contracts/adminSearch";
import {
  normalizeProviderModelConfiguration
} from "../../providers/providerConfiguration";
import {
  SearchConfigurationError,
  compatibleTechnicalAdapter,
  legacyProvider,
  legacySearchKind,
  normalizeSearchDraft,
  searchDraftHash,
  searchExecutionModes
} from "../../search/configuration";
import { isSearchCombinationCompatible } from "../../../domain/catalogMatrix";
import { decodeSearchPlan, type SearchPlan } from "../../../domain/search";

const SYSTEM_SEARCH_IDS = new Set([
  "gemini-google-search",
  "openai-native-web-search",
  "perplexity-tool-search",
  "search-disabled"
]);

export type AdminSearchTester = Readonly<{
  test(input: Readonly<{
    draft: AdminSearchDraft;
    userId: string;
  }>): Promise<Omit<AdminSearchTestEvidence, "checkedAt">>;
}>;

export type AdminSearchServiceErrorCode =
  | "search_activation_evidence_missing"
  | "search_configuration_invalid"
  | "search_draft_stale"
  | "search_integration_material_identity_changed"
  | "search_integration_not_found"
  | "search_name_invalid"
  | "search_provider_model_not_available"
  | "search_default_unavailable"
  | "search_policy_stale"
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
  return evidence as AdminSearchTestEvidence;
}

function activeRevision(value: {
  activatedAt: Date | null;
  activeRevision: null | { configuration: unknown; id: string; revisionNumber: number };
}): AdminSearchIntegration["activeRevision"] {
  return value.activeRevision && value.activatedAt
    ? {
        activatedAt: value.activatedAt.toISOString(),
        id: value.activeRevision.id,
        revisionNumber: value.activeRevision.revisionNumber
      }
    : null;
}

function providerModelConfiguration(value: unknown) {
  try {
    return normalizeProviderModelConfiguration(value);
  } catch {
    return null;
  }
}

type SearchRow = Awaited<ReturnType<PrismaClient["searchStrategy"]["findMany"]>>[number] & {
  activeRevision: null | { configuration: unknown; id: string; revisionNumber: number };
  providerModel: null | {
    activeConfig: unknown;
    connection: { displayName: string };
    displayName: string;
    id: string;
  };
};

function integrationReadiness(
  row: SearchRow,
  providerModels: readonly AdminSearchProviderModelOption[]
): AdminSearchReadiness {
  if (!row.activeRevisionId || !row.activeRevision) return "activation_required";
  let active: AdminSearchDraft;
  try {
    active = normalizeSearchDraft(row.activeRevision.configuration);
  } catch {
    return "activation_required";
  }
  if (active.adapterKind === "provider_model_client") {
    const model = providerModels.find((candidate) => candidate.id === active.providerModelId);
    return model?.enabled && compatibleTechnicalAdapter(active.protocol, model.adapterKind) &&
      model.nativeSearch
      ? "ready"
      : "provider_model_unavailable";
  }
  return providerModels.some((model) =>
    model.enabled && compatibleTechnicalAdapter(active.protocol, model.adapterKind) &&
    model.nativeSearch
  )
    ? "ready"
    : "compatible_model_unavailable";
}

function serializeIntegration(
  row: SearchRow,
  providerModels: readonly AdminSearchProviderModelOption[]
): AdminSearchIntegration {
  const draft = normalizedDraft(row.draft);
  const configuration = row.providerModel?.activeConfig
    ? providerModelConfiguration(row.providerModel.activeConfig)
    : null;
  const evidence = testEvidence(row.draftTestEvidence);
  const readiness = integrationReadiness(row, providerModels);
  return {
    activeRevision: activeRevision(row),
    adapterKind: row.adapterKind as AdminSearchIntegration["adapterKind"],
    archivedAt: row.archivedAt?.toISOString() ?? null,
    credentialMode: row.credentialMode as AdminSearchIntegration["credentialMode"],
    description: row.description,
    displayName: row.displayName,
    draft,
    draftDirty:
      !row.testedDraftHash?.startsWith("migration:") &&
      row.testedDraftHash !== searchDraftHash(draft),
    draftTestEvidence: evidence,
    draftVersion: row.draftVersion,
    enabled: row.enabled,
    executionModes: row.adapterKind === "none" ? [] : searchExecutionModes(draft.adapterKind),
    id: row.id,
    providerModel: row.providerModel && configuration
      ? {
          connectionDisplayName: row.providerModel.connection.displayName,
          displayName: row.providerModel.displayName,
          id: row.providerModel.id,
          upstreamModelId: configuration.upstreamModelId
        }
      : null,
    // Readiness belongs to the immutable active revision and its live
    // dependencies. Editing a later draft must not unpublish the accepted one.
    ready: readiness === "ready",
    readiness,
    strategyId: row.strategyId,
    system: SYSTEM_SEARCH_IDS.has(row.strategyId)
  };
}

function materialIdentity(draft: AdminSearchDraft): string {
  return [draft.adapterKind, draft.credentialMode, draft.protocol, draft.providerModelId ?? ""].join("\u0000");
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
    const row = await input.prisma.searchPolicy.findUnique({
      where: { id: "installation" }
    });
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
    if (!draft.providerModelId) return null;
    const model = await store.providerModel.findFirst({
      include: { connection: true },
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        connection: {
          activeConfig: { not: Prisma.DbNull },
          activeVersion: { gt: 0 },
          enabled: true
        },
        enabled: true,
        id: draft.providerModelId
      }
    });
    if (!model) throw new AdminSearchServiceError("search_provider_model_not_available");
    const configuration = providerModelConfiguration(model.activeConfig);
    if (!configuration || !compatibleTechnicalAdapter(draft.protocol, configuration.adapterKind) ||
      configuration.capabilities.nativeSearch !== true) {
      throw new AdminSearchServiceError("search_provider_model_not_available");
    }
    return { configuration, model };
  }

  async function list(): Promise<AdminSearchCatalog> {
    const [integrations, providerModels, searchPolicy] = await Promise.all([
      input.prisma.searchStrategy.findMany({
        include: {
          activeRevision: { select: { configuration: true, id: true, revisionNumber: true } },
          providerModel: {
            include: { connection: { select: { displayName: true } } }
          }
        },
        orderBy: [{ archivedAt: "asc" }, { displayName: "asc" }, { strategyId: "asc" }]
      }),
      input.prisma.providerModel.findMany({
        include: {
          connection: {
            select: {
              activeConfig: true,
              activeVersion: true,
              activatedAt: true,
              displayName: true,
              enabled: true
            }
          }
        },
        orderBy: [{ connectionId: "asc" }, { displayName: "asc" }, { id: "asc" }],
        where: { activeConfig: { not: Prisma.DbNull }, activeVersion: { gt: 0 } }
      }),
      policy()
    ]);
    const providerModelOptions: AdminSearchProviderModelOption[] = providerModels.flatMap((model) => {
      const configuration = providerModelConfiguration(model.activeConfig);
      if (!configuration) return [];
      return [{
        adapterKind: configuration.adapterKind,
        connectionDisplayName: model.connection.displayName,
        displayName: model.displayName,
        enabled: model.enabled && Boolean(model.activatedAt) && model.connection.enabled &&
          model.connection.activeVersion > 0 && Boolean(model.connection.activatedAt) &&
          model.connection.activeConfig !== null,
        id: model.id,
        nativeSearch: configuration.capabilities.nativeSearch,
        upstreamModelId: configuration.upstreamModelId
      }];
    });
    return {
      integrations: (integrations as SearchRow[])
        .filter((row) => row.strategyId !== "search-disabled")
        .map((row) => serializeIntegration(row, providerModelOptions)),
      policy: searchPolicy,
      providerModels: providerModelOptions
    };
  }

  async function updatePolicy(args: Readonly<{
    defaultPlan: unknown;
    expectedVersion: number;
    userId: string;
  }>): Promise<void> {
    const decoded = decodeSearchPlan(args.defaultPlan);
    if (!decoded.ok) throw new AdminSearchServiceError("search_default_unavailable");
    const catalog = await list();
    const selectable = catalog.integrations
      .filter((integration) => integration.enabled && !integration.archivedAt && integration.ready)
      .map((integration) => ({
        adapterKind: integration.adapterKind,
        executionModes: integration.executionModes,
        kind: integration.adapterKind === "none" as const
          ? "none" as const
          : "provider_model_web_search" as const,
        protocol: integration.draft.protocol,
        strategyId: integration.strategyId
      }));
    const plan: SearchPlan = decoded.plan;
    if (plan.optionIds.some((optionId) =>
      !selectable.some((integration) => integration.strategyId === optionId)) ||
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
  }>): Promise<void> {
    const displayName = text(args.displayName, 160);
    const description = text(args.description, 500);
    const draft = normalizedDraft(args.draft);
    const technical = await providerModelForDraft(draft);
    const id = idFactory();
    await input.prisma.searchStrategy.create({
      data: {
        adapterKind: draft.adapterKind,
        config: json({}),
        credentialMode: draft.credentialMode,
        description,
        displayName,
        draft: json(draft),
        enabled: false,
        kind: legacySearchKind(draft.protocol, draft.adapterKind),
        modelId: technical?.configuration.upstreamModelId ?? null,
        provider: technical?.model.connection.family ?? legacyProvider(draft.protocol),
        providerModelId: draft.providerModelId,
        strategyId: `${slug(displayName)}-${id.slice(0, 8)}`
      }
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
    await providerModelForDraft(draft);
    const current = await input.prisma.searchStrategy.findUnique({
      include: { activeRevision: true },
      where: { id: args.id }
    });
    if (!current) throw new AdminSearchServiceError("search_integration_not_found");
    if (current.strategyId === "search-disabled") {
      throw new AdminSearchServiceError("search_system_integration_forbidden");
    }
    if (current.activeRevision) {
      const active = normalizedDraft(current.activeRevision.configuration);
      if (materialIdentity(active) !== materialIdentity(draft)) {
        throw new AdminSearchServiceError("search_integration_material_identity_changed");
      }
    }
    const updated = await input.prisma.searchStrategy.updateMany({
      data: {
        description,
        displayName,
        draft: json(draft),
        draftTestEvidence: Prisma.DbNull,
        draftVersion: { increment: 1 },
        testedDraftHash: null
      },
      where: { draftVersion: args.expectedDraftVersion, id: args.id }
    });
    if (updated.count !== 1) throw new AdminSearchServiceError("search_draft_stale");
  }

  async function testDraft(args: Readonly<{ id: string; userId: string }>): Promise<void> {
    const current = await input.prisma.searchStrategy.findUnique({ where: { id: args.id } });
    if (!current) throw new AdminSearchServiceError("search_integration_not_found");
    const draft = normalizedDraft(current.draft);
    await providerModelForDraft(draft);
    let outcome: Omit<AdminSearchTestEvidence, "checkedAt">;
    try {
      outcome = await input.tester.test({ draft, userId: args.userId });
    } catch {
      throw new AdminSearchServiceError("search_test_failed");
    }
    const checkedAt = now().toISOString();
    const evidence: AdminSearchTestEvidence = { ...outcome, checkedAt };
    const updated = await input.prisma.searchStrategy.updateMany({
      data: {
        draftTestEvidence: json(evidence),
        testedDraftHash: searchDraftHash(draft)
      },
      where: { draftVersion: current.draftVersion, id: current.id }
    });
    if (updated.count !== 1) throw new AdminSearchServiceError("search_draft_stale");
  }

  async function activate(args: Readonly<{ id: string }>): Promise<void> {
    await input.prisma.$transaction(async (tx) => {
      const current = await tx.searchStrategy.findUnique({
        include: { activeRevision: true, revisions: { orderBy: { revisionNumber: "desc" }, take: 1 } },
        where: { id: args.id }
      });
      if (!current) throw new AdminSearchServiceError("search_integration_not_found");
      const draft = normalizedDraft(current.draft);
      const evidence = testEvidence(current.draftTestEvidence);
      if (
        current.testedDraftHash !== searchDraftHash(draft) ||
        evidence?.status !== "available"
      ) {
        throw new AdminSearchServiceError("search_activation_evidence_missing");
      }
      if (current.activeRevision) {
        const active = normalizedDraft(current.activeRevision.configuration);
        if (materialIdentity(active) !== materialIdentity(draft)) {
          throw new AdminSearchServiceError("search_integration_material_identity_changed");
        }
      }
      const technical = await providerModelForDraft(draft, tx);
      const existingRevision = await tx.searchIntegrationRevision.findUnique({
        where: {
          searchStrategyId_draftHash: {
            draftHash: current.testedDraftHash,
            searchStrategyId: current.id
          }
        }
      });
      const revision = existingRevision ?? await tx.searchIntegrationRevision.create({
        data: {
          adapterKind: draft.adapterKind,
          configuration: json(draft),
          credentialMode: draft.credentialMode,
          draftHash: current.testedDraftHash,
          providerModelId: draft.providerModelId,
          revisionNumber: (current.revisions[0]?.revisionNumber ?? 0) + 1,
          searchStrategyId: current.id,
          validationEvidence: json(evidence)
        }
      });
      await tx.searchStrategy.update({
        data: {
          activatedAt: now(),
          activeRevisionId: revision.id,
          adapterKind: draft.adapterKind,
          config: json(draft),
          credentialMode: draft.credentialMode,
          kind: legacySearchKind(draft.protocol, draft.adapterKind),
          modelId: technical?.configuration.upstreamModelId ?? null,
          provider: technical?.model.connection.family ?? legacyProvider(draft.protocol),
          providerModelId: draft.providerModelId
        },
        where: { id: current.id }
      });
    });
  }

  async function setEnabled(args: Readonly<{ enabled: boolean; id: string }>): Promise<void> {
    const current = await input.prisma.searchStrategy.findUnique({ where: { id: args.id } });
    if (!current) throw new AdminSearchServiceError("search_integration_not_found");
    if (args.enabled && (!current.activeRevisionId || current.archivedAt)) {
      throw new AdminSearchServiceError("search_activation_evidence_missing");
    }
    await input.prisma.searchStrategy.update({ data: { enabled: args.enabled }, where: { id: args.id } });
  }

  async function archive(args: Readonly<{ id: string }>): Promise<void> {
    const current = await input.prisma.searchStrategy.findUnique({ where: { id: args.id } });
    if (!current) throw new AdminSearchServiceError("search_integration_not_found");
    if (SYSTEM_SEARCH_IDS.has(current.strategyId)) {
      throw new AdminSearchServiceError("search_system_integration_forbidden");
    }
    await input.prisma.searchStrategy.update({
      data: { archivedAt: now(), enabled: false },
      where: { id: args.id }
    });
  }

  return Object.freeze({ activate, archive, createDraft, list, setEnabled, testDraft, updateDraft, updatePolicy });
}
