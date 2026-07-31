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
  SEARCH_DISABLED_STRATEGY_ID,
  type SearchPlan
} from "../../domain/search";
import {
  builtInSearchDraft,
  normalizeSearchDraft,
  searchExecutionModes
} from "../search/configuration";

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

function searchConfiguration(
  strategy: {
    config: unknown;
    kind: string;
    strategyId: string;
  },
  role: ProviderAdmissionRole
): RunSearchStrategyConfiguration {
  const model = role.snapshot.model;
  if (model.adapterKind === "fake") throw new ProviderAdmissionError("search_strategy_not_available");
  return {
    config: isRecord(strategy.config) ? { ...strategy.config } : {},
    kind: strategy.kind,
    modelId: model.upstreamModelId,
    provider: role.snapshot.providerFamily,
    strategyId: strategy.strategyId
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
  if (input.searchPreferenceSource === "personal") {
    if (!input.searchPreferencePlan) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    const preferenceStrategies: Array<{
      adapterKind: string;
      executionModes: readonly string[];
      protocol: string;
    }> = [];
    for (const optionId of input.searchPreferencePlan.optionIds) {
      const strategy = await db.searchStrategy.findFirst({
        include: { activeRevision: true },
        where: {
          activeRevisionId: { not: null },
          archivedAt: null,
          enabled: true,
          strategyId: optionId
        }
      });
      if (!strategy || !(await hasSearchEntitlement(db, {
        fullAccess,
        groupIds,
        strategyId: optionId,
        userId: input.userId
      })) || !strategy.activeRevision) {
        throw new ProviderAdmissionError("search_strategy_not_available");
      }
      let draft;
      try {
        draft = normalizeSearchDraft(strategy.activeRevision.configuration);
      } catch {
        throw new ProviderAdmissionError("search_strategy_not_available");
      }
      preferenceStrategies.push({
        adapterKind: draft.adapterKind,
        executionModes: searchExecutionModes(draft.adapterKind),
        protocol: draft.protocol
      });
    }
    if (preferenceStrategies.length > 1 && (
      preferenceStrategies.some((strategy) => strategy.protocol === "gemini_google_search") ||
      preferenceStrategies.filter((strategy) =>
        strategy.adapterKind === "answer_provider_hosted").length > 1 ||
      (input.searchPreferencePlan.mode === "all_selected" &&
        preferenceStrategies.some((strategy) => !strategy.executionModes.includes("all_selected")))
    )) {
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
  const requestedSearchPlan = decodedPlan.plan;
  const optionIds = requestedSearchPlan.optionIds;
  const searches: NonNullable<ProviderAdmissionPlan["searches"]>[number][] = [];

  // The old singleton wire shape historically validates the explicit Off row.
  // New empty plans do not pretend that Off is an installed engine.
  const strategyIds = input.searchPlan === undefined && optionIds.length === 0
    ? [SEARCH_DISABLED_STRATEGY_ID]
    : [...optionIds];

  for (const [ordinal, optionId] of strategyIds.entries()) {
    const strategy = await db.searchStrategy.findFirst({
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
      where: {
        ...(input.searchPlan === undefined ? {} : { activeRevisionId: { not: null }, archivedAt: null }),
        enabled: true,
        strategyId: optionId
      }
    });
    if (!strategy || !(await hasSearchEntitlement(db, {
      fullAccess,
      groupIds,
      strategyId: optionId,
      userId: input.userId
    }))) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    if (strategy.kind === "none") continue;

    const revision = strategy.activeRevision ?? {
      adapterKind: strategy.kind === "perplexity_tool_search"
        ? "provider_model_client"
        : "answer_provider_hosted",
      configuration: builtInSearchDraft({
        config: strategy.config,
        kind: strategy.kind,
        providerModelId: strategy.providerModelId
      }),
      credentialMode: strategy.kind === "perplexity_tool_search"
        ? "provider_model"
        : "answer_provider",
      id: `legacy:${strategy.id}`,
      providerModelId: strategy.providerModelId
    };
    let draft;
    try {
      draft = normalizeSearchDraft(revision.configuration);
    } catch {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    if (
      revision.adapterKind !== draft.adapterKind ||
      revision.credentialMode !== draft.credentialMode ||
      revision.providerModelId !== draft.providerModelId
    ) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }

    let role: ProviderAdmissionRole | undefined;
    if (draft.adapterKind === "answer_provider_hosted") {
      if (draft.protocol === "openai_responses_web_search") {
        if (
          (answer.snapshot.model.adapterKind !== "openai_responses_native" &&
            answer.snapshot.model.adapterKind !== "openai_responses_compatible") ||
          !answer.modelConfiguration.capabilities.nativeSearch
        ) {
          throw new ProviderAdmissionError("search_strategy_not_available");
        }
      } else if (draft.protocol === "gemini_google_search") {
        if (
          answer.snapshot.providerFamily !== "gemini" ||
          answer.snapshot.model.adapterKind !== "gemini_interactions_native" ||
          !answer.modelConfiguration.capabilities.nativeSearch ||
          optionIds.length > 1
        ) {
          throw new ProviderAdmissionError("search_strategy_not_available");
        }
      } else {
        throw new ProviderAdmissionError("search_strategy_not_available");
      }
    } else {
      if (
        !draft.providerModelId ||
        draft.providerModelId === input.providerModelId ||
        !answer.modelConfiguration.capabilities.toolCalling
      ) {
        throw new ProviderAdmissionError("search_strategy_not_available");
      }
      role = await loadTechnicalProviderRole(db, {
        providerModelId: draft.providerModelId,
        userId: input.userId
      });
    }

    const configuration: RunSearchStrategyConfiguration = {
      adapterKind: draft.adapterKind,
      config: {
        ...draft,
        ...(role
          ? {
              modelCapabilities: role.modelConfiguration.capabilities,
              modelDefaultParams: role.modelConfiguration.defaultParams
            }
          : {})
      },
      credentialMode: draft.credentialMode,
      displayName: strategy.displayName,
      executionModes: searchExecutionModes(draft.adapterKind),
      kind: strategy.kind,
      modelId: role?.snapshot.model.upstreamModelId ?? null,
      protocol: draft.protocol,
      provider: role?.snapshot.providerFamily ?? answer.snapshot.providerFamily,
      providerModelId: draft.providerModelId,
      revisionId: revision.id,
      searchStrategyRowId: strategy.id,
      strategyId: optionId
    };
    searches.push({
      bindingKey: role ? `search:${optionId}` : null,
      configuration,
      integrationId: strategy.id,
      optionId,
      ordinal,
      revisionId: revision.id,
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

  const withoutFingerprint = {
    answer,
    requestedSearchStrategyId: input.searchStrategyId,
    requestedSearchPlan,
    ...(input.searchPreferenceSource
      ? {
          requestedSearchPreferencePlan: input.searchPreferencePlan ?? null,
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
