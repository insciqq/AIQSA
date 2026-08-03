import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { resolveProviderCredential } from "../../domain/providerCredentialResolution";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration
} from "../providers/providerConfiguration";
import { resolveProviderModelCapabilities } from "../providers/providerModelCapabilities";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ProviderModelCapabilities } from "../providers/types";
import type {
  RunModelConfiguration,
  RunSearchStrategyConfiguration
} from "../runs/runRepositoryContract";
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "../auth/fullAccessGroup";
import {
  decodeSearchPlan,
  OPENAI_PROVIDER_SEARCH_STRATEGY_ID,
  SEARCH_DISABLED_STRATEGY_ID,
  type SearchPlan
} from "../../domain/search";
import {
  compatibleTechnicalAdapter,
  legacySearchKind,
  normalizeSearchDraft,
  searchExecutionModes
} from "../search/configuration";
import type { SearchProbeBinding } from "../search/probeBinding";

export type ProviderAdmissionErrorCode =
  | "credential_active_version_missing"
  | "credential_assignment_ambiguous"
  | "credential_assignment_required"
  | "credential_default_missing"
  | "credential_disabled"
  | "credential_not_found"
  | "credential_revoked"
  | "model_not_available"
  | "search_strategy_not_available"
  | "user_not_available";

export class ProviderAdmissionError extends Error {
  readonly code: ProviderAdmissionErrorCode;

  constructor(code: ProviderAdmissionErrorCode) {
    super(code);
    this.code = code;
    this.name = "ProviderAdmissionError";
  }
}

export type ProviderAdmissionRole = Readonly<{
  authority?: SearchProbeBinding | null;
  credentialSource: "default" | "group" | "user";
  modelConfiguration: RunModelConfiguration;
  snapshot: ProviderExecutionSnapshot;
}>;

export type ProviderAdmissionPlan = Readonly<{
  answer: ProviderAdmissionRole;
  fingerprint: string;
  requestedSearchStrategyId: string;
  requestedSearchPlan?: SearchPlan;
  requestedSearchPreferencePlan?: SearchPlan | null;
  requestedSearchPreferenceSource?: "organization" | "personal";
  search?: ProviderAdmissionRole;
  searchConfiguration?: RunSearchStrategyConfiguration;
  searches?: readonly Readonly<{
    bindingKey: string | null;
    configuration: RunSearchStrategyConfiguration;
    integrationId: string;
    optionId: string;
    ordinal: number;
    revisionId: string;
    role?: ProviderAdmissionRole;
  }>[];
  selection: Readonly<{
    providerConnectionId: string;
    providerModelId: string;
  }>;
  userId: string;
}>;

type AdmissionPrisma = Pick<
  Prisma.TransactionClient,
  | "accessGrant"
  | "providerCredential"
  | "providerGroupCredentialAssignment"
  | "providerModel"
  | "providerModelCredentialCheck"
  | "providerUserCredentialAssignment"
  | "searchOption"
  | "searchStrategy"
  | "user"
  | "userGroup"
>;

type ActiveMembership = Readonly<{
  group: Readonly<{ systemRole: "full_access" | null }>;
  groupId: string;
}>;

async function activeUserAuthority(db: AdmissionPrisma, userId: string): Promise<{
  fullAccess: boolean;
  groupIds: string[];
}> {
  const user = await db.user.findFirst({
    select: { id: true },
    where: { id: userId, status: "active" }
  });
  if (!user) throw new ProviderAdmissionError("user_not_available");
  const memberships: ActiveMembership[] = await db.userGroup.findMany({
    select: {
      group: { select: { systemRole: true } },
      groupId: true
    },
    where: { group: { archivedAt: null }, userId }
  });
  return {
    fullAccess: memberships.some(
      (membership) => membership.group.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
    ),
    groupIds: memberships.map((membership) => membership.groupId)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withResolvedModelCapabilities(
  snapshot: ProviderExecutionSnapshot,
  legacyContextWindow: number | null | undefined
): ProviderExecutionSnapshot {
  return normalizeProviderExecutionSnapshot({
    ...snapshot,
    model: {
      ...snapshot.model,
      capabilities: resolveProviderModelCapabilities({
        adapterKind: snapshot.model.adapterKind,
        capabilities: snapshot.model.capabilities,
        legacyContextWindow,
        providerFamily: snapshot.providerFamily,
        upstreamModelId: snapshot.model.upstreamModelId
      })
    }
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function planFingerprint(value: Omit<ProviderAdmissionPlan, "fingerprint">): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

async function hasModelEntitlement(
  db: AdmissionPrisma,
  input: {
    connectionId: string;
    fullAccess: boolean;
    groupIds: string[];
    modelId: string;
    userId: string;
  }
): Promise<boolean> {
  if (input.fullAccess) return true;
  const count = await db.accessGrant.count({
    where: {
      enabled: true,
      OR: [
        { userId: input.userId },
        ...(input.groupIds.length ? [{ groupId: { in: input.groupIds } }] : [])
      ],
      AND: [{
        OR: [
          { providerModelId: input.modelId },
          { providerConnectionId: input.connectionId }
        ]
      }]
    }
  });
  return count > 0;
}

async function hasSearchEntitlement(
  db: AdmissionPrisma,
  input: { fullAccess: boolean; groupIds: string[]; strategyId: string; userId: string }
): Promise<boolean> {
  if (input.strategyId === "search-disabled") return true;
  if (input.fullAccess) return true;
  return (await db.accessGrant.count({
    where: {
      enabled: true,
      searchStrategy: input.strategyId,
      OR: [
        { userId: input.userId },
        ...(input.groupIds.length ? [{ groupId: { in: input.groupIds } }] : [])
      ]
    }
  })) > 0;
}

async function loadRole(
  db: AdmissionPrisma,
  input: {
    connectionId: string;
    fullAccess: boolean;
    groupIds: string[];
    modelId: string;
    requireAnswerSelectable: boolean;
    requireEntitlement: boolean;
    userId: string;
  }
): Promise<ProviderAdmissionRole> {
  const model = await db.providerModel.findFirst({
    include: {
      connection: true
    },
    where: {
      activeConfig: { not: Prisma.DbNull },
      activeVersion: { gt: 0 },
      connectionId: input.connectionId,
      enabled: true,
      id: input.modelId,
      connection: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        enabled: true
      }
    }
  });
  if (!model) throw new ProviderAdmissionError("model_not_available");

  if (input.requireEntitlement && !(await hasModelEntitlement(db, input))) {
    throw new ProviderAdmissionError("model_not_available");
  }

  const connectionConfig = normalizeProviderConnectionConfiguration(model.connection.activeConfig);
  if (model.connection.family === "fake") {
    if (!isRecord(model.activeConfig) || model.activeConfig.adapterKind !== "fake") {
      throw new ProviderAdmissionError("model_not_available");
    }
    const snapshot = withResolvedModelCapabilities(
      normalizeProviderExecutionSnapshot({
        connection: connectionConfig,
        connectionDisplayName: model.connection.displayName,
        connectionId: model.connectionId,
        credentialId: null,
        credentialVersionId: null,
        model: model.activeConfig,
        modelDisplayName: model.displayName,
        providerFamily: model.connection.family,
        providerModelId: model.id,
        version: 1
      }),
      model.contextWindow
    );
    const fakeModel = snapshot.model;
    if (fakeModel.adapterKind !== "fake") throw new ProviderAdmissionError("model_not_available");
    return {
      authority: null,
      credentialSource: "default",
      modelConfiguration: {
        adapterKind: "fake",
        capabilities: fakeModel.capabilities,
        defaultParams: fakeModel.defaultParams
      },
      snapshot
    };
  }

  const modelConfig = normalizeProviderModelConfiguration(model.activeConfig);
  if (input.requireAnswerSelectable && !modelConfig.answerSelectable) {
    throw new ProviderAdmissionError("model_not_available");
  }

  const [credentials, assignments, directAssignment] = await Promise.all([
    db.providerCredential.findMany({
      include: {
        activeVersion: {
          select: {
            id: true,
            revokedAt: true
          }
        }
      },
      where: { connectionId: model.connectionId }
    }),
    db.providerGroupCredentialAssignment.findMany({
      select: { credentialId: true, groupId: true },
      where: {
        connectionId: model.connectionId,
        groupId: { in: input.groupIds }
      }
    }),
    db.providerUserCredentialAssignment.findUnique({
      select: { credentialId: true },
      where: {
        connectionId_userId: {
          connectionId: model.connectionId,
          userId: input.userId
        }
      }
    })
  ]);
  const credential = resolveProviderCredential({
    assignments,
    credentials: credentials.map((candidate) => ({
      activeVersion: candidate.activeVersion
        ? { id: candidate.activeVersion.id, revoked: Boolean(candidate.activeVersion.revokedAt) }
        : null,
      enabled: candidate.enabled,
      id: candidate.id
    })),
    defaultCredentialId: model.connection.defaultCredentialId,
    directAssignmentCredentialId: directAssignment?.credentialId ?? null,
    memberships: input.groupIds.map((groupId) => ({ archived: false, groupId })),
    policy: model.connection.unassignedPolicy
  });
  if (!credential.ok) throw new ProviderAdmissionError(credential.code);

  const check = await db.providerModelCredentialCheck.findFirst({
    select: { id: true },
    where: {
      connectionId: model.connectionId,
      connectionVersion: model.connection.activeVersion,
      credentialId: credential.credentialId,
      credentialVersionId: credential.credentialVersionId,
      modelVersion: model.activeVersion,
      providerModelId: model.id,
      status: "available"
    }
  });
  if (!check) throw new ProviderAdmissionError("model_not_available");

  const snapshot = withResolvedModelCapabilities(
    normalizeProviderExecutionSnapshot({
      connection: connectionConfig,
      connectionDisplayName: model.connection.displayName,
      connectionId: model.connectionId,
      credentialId: credential.credentialId,
      credentialVersionId: credential.credentialVersionId,
      model: modelConfig,
      modelDisplayName: model.displayName,
      providerFamily: model.connection.family,
      providerModelId: model.id,
      version: 1
    }),
    model.contextWindow
  );
  const resolvedModel = snapshot.model;
  if (resolvedModel.adapterKind === "fake") {
    throw new ProviderAdmissionError("model_not_available");
  }

  return {
    authority: {
      connectionId: model.connectionId,
      connectionVersion: model.connection.activeVersion,
      credentialId: credential.credentialId,
      credentialVersionId: credential.credentialVersionId,
      modelVersion: model.activeVersion,
      providerModelId: model.id
    },
    credentialSource: credential.source,
    modelConfiguration: {
      adapterKind: resolvedModel.adapterKind,
      capabilities: resolvedModel.capabilities,
      defaultParams: resolvedModel.defaultParams
    },
    snapshot
  };
}

/** Resolve a technical provider model through the same credential precedence
 * as run admission, without requiring an answer-model entitlement. Search
 * lifecycle tests and accepted Search bindings use this boundary instead of
 * selecting credential versions in the browser. */
export async function loadTechnicalProviderRole(
  db: AdmissionPrisma,
  input: { providerModelId: string; userId: string }
): Promise<ProviderAdmissionRole> {
  const authority = await activeUserAuthority(db, input.userId);
  const model = await db.providerModel.findUnique({
    select: { connectionId: true },
    where: { id: input.providerModelId }
  });
  if (!model) throw new ProviderAdmissionError("model_not_available");
  return loadRole(db, {
    connectionId: model.connectionId,
    fullAccess: authority.fullAccess,
    groupIds: authority.groupIds,
    modelId: input.providerModelId,
    requireAnswerSelectable: false,
    requireEntitlement: false,
    userId: input.userId
  });
}

async function canonicalSearchOptionId(
  db: AdmissionPrisma,
  optionId: string
): Promise<string | null> {
  if (optionId !== OPENAI_PROVIDER_SEARCH_STRATEGY_ID) {
    return optionId;
  }

  const legacyRoute = await db.searchStrategy.findUnique({
    select: {
      searchOption: {
        select: {
          archivedAt: true,
          enabled: true,
          optionId: true
        }
      }
    },
    where: { strategyId: OPENAI_PROVIDER_SEARCH_STRATEGY_ID }
  });
  const option = legacyRoute?.searchOption;
  return option?.enabled && option.archivedAt === null ? option.optionId : null;
}

async function canonicalSearchPlan(
  db: AdmissionPrisma,
  plan: SearchPlan
): Promise<SearchPlan | null> {
  const optionIds = await Promise.all(
    plan.optionIds.map((optionId) => canonicalSearchOptionId(db, optionId))
  );
  if (optionIds.some((optionId) => optionId === null)) return null;
  const resolvedOptionIds = optionIds.filter((optionId): optionId is string => optionId !== null);
  if (new Set(resolvedOptionIds).size !== resolvedOptionIds.length) return null;
  return {
    mode: plan.mode,
    optionIds: resolvedOptionIds
  };
}

type LoadedSearchOption = Readonly<{
  archivedAt: Date | null;
  displayName: string;
  enabled: boolean;
  id: string;
  kind: string;
  optionId: string;
  sourceConnectionId: string | null;
  strategies: ReadonlyArray<Readonly<{
    activeRevision: null | Readonly<{
      adapterKind: string;
      configuration: unknown;
      credentialMode: string;
      id: string;
      providerModelId: string | null;
    }>;
    activeRevisionId: string | null;
    adapterKind: string;
    archivedAt: Date | null;
    credentialMode: string;
    enabled: boolean;
    id: string;
    kind: string;
    providerModelId: string | null;
    strategyId: string;
  }>>;
}>;

type ResolvedSearchRoute = Readonly<{
  draft: ReturnType<typeof normalizeSearchDraft>;
  revisionId: string;
  strategy: LoadedSearchOption["strategies"][number];
}>;

function supportedSearchOption(option: LoadedSearchOption): boolean {
  if (!option.enabled || option.archivedAt !== null) return false;
  if (option.kind === "none") {
    return option.optionId === SEARCH_DISABLED_STRATEGY_ID && option.sourceConnectionId === null;
  }
  return (
    option.kind === "web_search" ||
    option.kind === "gemini_google_search" ||
    option.kind === "perplexity_search"
  ) && typeof option.sourceConnectionId === "string" && option.sourceConnectionId.length > 0;
}

function normalizeActiveSearchRoute(
  strategy: LoadedSearchOption["strategies"][number]
): ResolvedSearchRoute | null {
  const revision = strategy.activeRevision;
  if (
    !strategy.enabled ||
    strategy.archivedAt !== null ||
    !strategy.activeRevisionId ||
    !revision ||
    revision.id !== strategy.activeRevisionId
  ) {
    return null;
  }
  let draft: ReturnType<typeof normalizeSearchDraft>;
  try {
    draft = normalizeSearchDraft(revision.configuration);
  } catch {
    return null;
  }
  if (
    revision.adapterKind !== draft.adapterKind ||
    revision.credentialMode !== draft.credentialMode ||
    revision.providerModelId !== draft.providerModelId ||
    strategy.adapterKind !== draft.adapterKind ||
    strategy.credentialMode !== draft.credentialMode ||
    strategy.providerModelId !== draft.providerModelId ||
    strategy.kind !== legacySearchKind(draft.protocol, draft.adapterKind)
  ) {
    return null;
  }
  return {
    draft,
    revisionId: revision.id,
    strategy
  };
}

function hasAmbiguousRouteKinds(routes: readonly ResolvedSearchRoute[]): boolean {
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.draft.adapterKind)) return true;
    seen.add(route.draft.adapterKind);
  }
  return false;
}

function hostedRouteCompatible(
  option: LoadedSearchOption,
  route: ResolvedSearchRoute,
  answer: ProviderAdmissionRole
): boolean {
  if (
    route.draft.adapterKind !== "answer_provider_hosted" ||
    option.sourceConnectionId !== answer.snapshot.connectionId ||
    !answer.modelConfiguration.capabilities.nativeSearch
  ) {
    return false;
  }
  if (option.kind === "gemini_google_search") {
    return route.draft.protocol === "gemini_google_search" &&
      answer.snapshot.providerFamily === "gemini" &&
      answer.snapshot.model.adapterKind === "gemini_interactions_native";
  }
  return option.kind === "web_search" &&
    route.draft.protocol === "openai_responses_web_search" &&
    (answer.snapshot.model.adapterKind === "openai_responses_native" ||
      answer.snapshot.model.adapterKind === "openai_responses_compatible");
}

function clientRouteCompatible(
  option: LoadedSearchOption,
  route: ResolvedSearchRoute,
  answer: ProviderAdmissionRole,
  answerModelId: string
): boolean {
  if (
    route.draft.adapterKind !== "provider_model_client" ||
    !route.draft.providerModelId ||
    !option.sourceConnectionId ||
    !answer.modelConfiguration.capabilities.toolCalling
  ) {
    return false;
  }
  if (option.kind === "web_search") {
    return route.draft.protocol === "openai_responses_web_search";
  }
  return option.kind === "perplexity_search" &&
    route.draft.protocol === "openrouter_perplexity_chat" &&
    route.draft.providerModelId !== answerModelId;
}

function routeBelongsToOption(
  option: LoadedSearchOption,
  route: ResolvedSearchRoute
): boolean {
  if (option.kind === "web_search") {
    return route.draft.protocol === "openai_responses_web_search";
  }
  if (option.kind === "gemini_google_search") {
    return route.draft.adapterKind === "answer_provider_hosted" &&
      route.draft.protocol === "gemini_google_search";
  }
  return option.kind === "perplexity_search" &&
    route.draft.adapterKind === "provider_model_client" &&
    route.draft.protocol === "openrouter_perplexity_chat";
}

async function loadClientRouteRole(
  db: AdmissionPrisma,
  input: {
    fullAccess: boolean;
    groupIds: string[];
    option: LoadedSearchOption;
    route: ResolvedSearchRoute;
    userId: string;
  }
): Promise<ProviderAdmissionRole | null> {
  const providerModelId = input.route.draft.providerModelId;
  if (
    input.route.draft.adapterKind !== "provider_model_client" ||
    !providerModelId ||
    !input.option.sourceConnectionId ||
    !routeBelongsToOption(input.option, input.route)
  ) {
    return null;
  }
  const technicalModel = await db.providerModel.findUnique({
    select: { connectionId: true },
    where: { id: providerModelId }
  });
  if (!technicalModel || technicalModel.connectionId !== input.option.sourceConnectionId) {
    return null;
  }
  const role = await loadRole(db, {
    connectionId: technicalModel.connectionId,
    fullAccess: input.fullAccess,
    groupIds: input.groupIds,
    modelId: providerModelId,
    requireAnswerSelectable: false,
    requireEntitlement: false,
    userId: input.userId
  });
  return role.authority &&
    role.snapshot.connectionId === input.option.sourceConnectionId &&
    role.modelConfiguration.capabilities.nativeSearch === true &&
    compatibleTechnicalAdapter(input.route.draft.protocol, role.snapshot.model.adapterKind)
    ? role
    : null;
}

function searchConfiguration(
  option: LoadedSearchOption,
  route: ResolvedSearchRoute,
  answer: ProviderAdmissionRole,
  role: ProviderAdmissionRole | undefined
): RunSearchStrategyConfiguration {
  return {
    adapterKind: route.draft.adapterKind,
    config: {
      ...route.draft,
      ...(role
        ? {
            modelCapabilities: role.modelConfiguration.capabilities,
            ...(route.draft.protocol === "openrouter_perplexity_chat"
              ? { modelDefaultParams: role.modelConfiguration.defaultParams }
              : {})
          }
        : {})
    },
    credentialMode: route.draft.credentialMode,
    displayName: option.displayName,
    executionModes: searchExecutionModes(route.draft.adapterKind),
    kind: route.strategy.kind,
    modelId: role?.snapshot.model.upstreamModelId ?? null,
    protocol: route.draft.protocol,
    provider: role?.snapshot.providerFamily ?? answer.snapshot.providerFamily,
    providerModelId: route.draft.providerModelId,
    revisionId: route.revisionId,
    searchStrategyRowId: route.strategy.id,
    strategyId: option.optionId
  };
}

export async function loadProviderAdmissionPlan(
  db: AdmissionPrisma,
  input: {
    providerConnectionId: string;
    providerModelId: string;
    searchPlan?: SearchPlan;
    searchPreferencePlan?: SearchPlan | null;
    searchPreferenceSource?: "organization" | "personal";
    searchStrategyId: string;
    userId: string;
  }
): Promise<ProviderAdmissionPlan> {
  const user = await db.user.findFirst({
    select: { id: true },
    where: { id: input.userId, status: "active" }
  });
  if (!user) throw new ProviderAdmissionError("user_not_available");

  const memberships: ActiveMembership[] = await db.userGroup.findMany({
    select: {
      group: {
        select: { systemRole: true }
      },
      groupId: true
    },
    where: {
      group: { archivedAt: null },
      userId: input.userId
    }
  });
  const groupIds = memberships.map((membership) => membership.groupId);
  const fullAccess = memberships.some(
    (membership) => membership.group.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
  );

  const optionCache = new Map<string, Promise<LoadedSearchOption | null>>();
  const loadOption = (optionId: string): Promise<LoadedSearchOption | null> => {
    const cached = optionCache.get(optionId);
    if (cached) return cached;
    const pending = db.searchOption.findFirst({
      include: {
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
          orderBy: [{ createdAt: "asc" }, { strategyId: "asc" }],
          where: {
            activeRevisionId: { not: null },
            archivedAt: null,
            enabled: true
          }
        }
      },
      where: {
        archivedAt: null,
        enabled: true,
        optionId
      }
    }) as Promise<LoadedSearchOption | null>;
    optionCache.set(optionId, pending);
    return pending;
  };

  let requestedSearchPreferencePlan = input.searchPreferencePlan;
  if (input.searchPreferenceSource === "personal") {
    if (!input.searchPreferencePlan) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    requestedSearchPreferencePlan = await canonicalSearchPlan(db, input.searchPreferencePlan);
    if (!requestedSearchPreferencePlan) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    const preferenceOptions: LoadedSearchOption[] = [];
    for (const optionId of requestedSearchPreferencePlan.optionIds) {
      const option = await loadOption(optionId);
      if (!option || !supportedSearchOption(option) || option.kind === "none" ||
        !(await hasSearchEntitlement(db, {
          fullAccess,
          groupIds,
          strategyId: optionId,
          userId: input.userId
      }))) {
        throw new ProviderAdmissionError("search_strategy_not_available");
      }
      const routes = option.strategies.flatMap((strategy) => {
        const route = normalizeActiveSearchRoute(strategy);
        return route && routeBelongsToOption(option, route) ? [route] : [];
      });
      if (hasAmbiguousRouteKinds(routes)) {
        throw new ProviderAdmissionError("search_strategy_not_available");
      }
      let ready = routes.some((route) => route.draft.adapterKind === "answer_provider_hosted");
      let readinessError: ProviderAdmissionError | undefined;
      if (!ready) {
        for (const route of routes) {
          try {
            if (await loadClientRouteRole(db, {
              fullAccess,
              groupIds,
              option,
              route,
              userId: input.userId
            })) {
              ready = true;
              break;
            }
          } catch (error) {
            if (!(error instanceof ProviderAdmissionError)) throw error;
            readinessError ??= error;
          }
        }
      }
      if (!ready) {
        if (readinessError) throw readinessError;
        throw new ProviderAdmissionError("search_strategy_not_available");
      }
      preferenceOptions.push(option);
    }
    if (preferenceOptions.length > 1 &&
      preferenceOptions.some((option) => option.kind === "gemini_google_search")) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
  } else if (input.searchPreferenceSource !== undefined &&
    input.searchPreferenceSource !== "organization") {
    throw new ProviderAdmissionError("search_strategy_not_available");
  }
  const answer = await loadRole(db, {
    connectionId: input.providerConnectionId,
    fullAccess,
    groupIds,
    modelId: input.providerModelId,
    requireAnswerSelectable: true,
    requireEntitlement: true,
    userId: input.userId
  });

  const decodedPlan = decodeSearchPlan(input.searchPlan, input.searchStrategyId);
  if (!decodedPlan.ok) throw new ProviderAdmissionError("search_strategy_not_available");
  const requestedSearchPlan = await canonicalSearchPlan(db, decodedPlan.plan);
  if (!requestedSearchPlan) {
    throw new ProviderAdmissionError("search_strategy_not_available");
  }
  const optionIds = requestedSearchPlan.optionIds;
  const searches: NonNullable<ProviderAdmissionPlan["searches"]>[number][] = [];

  // The old singleton wire shape historically validates the explicit Off row.
  // New empty plans do not pretend that Off is an installed engine.
  const strategyIds = input.searchPlan === undefined && optionIds.length === 0
    ? [SEARCH_DISABLED_STRATEGY_ID]
    : [...optionIds];

  for (const [ordinal, optionId] of strategyIds.entries()) {
    const option = await loadOption(optionId);
    if (!option || !supportedSearchOption(option) || !(await hasSearchEntitlement(db, {
      fullAccess,
      groupIds,
      strategyId: optionId,
      userId: input.userId
    }))) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    if (option.kind === "none") continue;
    if (option.kind === "gemini_google_search" && optionIds.length > 1) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }

    const routes = option.strategies.flatMap((strategy) => {
      const route = normalizeActiveSearchRoute(strategy);
      return route ? [route] : [];
    });
    if (hasAmbiguousRouteKinds(routes)) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    let route = routes.find((candidate) => hostedRouteCompatible(option, candidate, answer));
    let role: ProviderAdmissionRole | undefined;
    let routeLoadError: ProviderAdmissionError | undefined;
    if (!route) {
      for (const candidate of routes) {
        if (!clientRouteCompatible(option, candidate, answer, input.providerModelId)) continue;
        try {
          const candidateRole = await loadClientRouteRole(db, {
            fullAccess,
            groupIds,
            option,
            route: candidate,
            userId: input.userId
          });
          if (!candidateRole) continue;
          route = candidate;
          role = candidateRole;
          break;
        } catch (error) {
          if (!(error instanceof ProviderAdmissionError)) throw error;
          routeLoadError ??= error;
        }
      }
    }
    if (!route) {
      if (routeLoadError) throw routeLoadError;
      throw new ProviderAdmissionError("search_strategy_not_available");
    }

    const configuration = searchConfiguration(option, route, answer, role);
    searches.push({
      bindingKey: role ? `search:${optionId}` : null,
      configuration,
      integrationId: route.strategy.id,
      optionId,
      ordinal,
      revisionId: route.revisionId,
      ...(role ? { role } : {})
    });
  }

  if (
    optionIds.length > 1 &&
    requestedSearchPlan.mode === "all_selected" &&
    searches.some((candidate) => candidate.configuration.adapterKind !== "provider_model_client")
  ) {
    throw new ProviderAdmissionError("search_strategy_not_available");
  }
  const hostedCount = searches.filter(
    (candidate) => candidate.configuration.adapterKind === "answer_provider_hosted"
  ).length;
  if (hostedCount > 1) throw new ProviderAdmissionError("search_strategy_not_available");

  const legacySearch = searches.length === 1 ? searches[0] : undefined;
  const search = legacySearch?.role;
  const technicalSearchConfiguration = legacySearch?.configuration;

  const requestedSearchStrategyId = await canonicalSearchOptionId(db, input.searchStrategyId);
  if (!requestedSearchStrategyId) {
    throw new ProviderAdmissionError("search_strategy_not_available");
  }
  const withoutFingerprint = {
    answer,
    requestedSearchStrategyId,
    requestedSearchPlan,
    ...(input.searchPreferenceSource
      ? {
          requestedSearchPreferencePlan: requestedSearchPreferencePlan ?? null,
          requestedSearchPreferenceSource: input.searchPreferenceSource
        }
      : {}),
    ...(search ? { search } : {}),
    ...(technicalSearchConfiguration
      ? { searchConfiguration: technicalSearchConfiguration }
      : {}),
    searches,
    selection: {
      providerConnectionId: input.providerConnectionId,
      providerModelId: input.providerModelId
    },
    userId: input.userId
  };
  return Object.freeze({
    ...withoutFingerprint,
    fingerprint: planFingerprint(withoutFingerprint)
  });
}

export function sameProviderAdmissionPlan(
  left: ProviderAdmissionPlan,
  right: ProviderAdmissionPlan
): boolean {
  return left.fingerprint === right.fingerprint;
}
