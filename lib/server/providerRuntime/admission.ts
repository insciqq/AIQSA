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
  credentialSource: "default" | "group";
  modelConfiguration: RunModelConfiguration;
  snapshot: ProviderExecutionSnapshot;
}>;

export type ProviderAdmissionPlan = Readonly<{
  answer: ProviderAdmissionRole;
  fingerprint: string;
  requestedSearchStrategyId: string;
  search?: ProviderAdmissionRole;
  searchConfiguration?: RunSearchStrategyConfiguration;
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
  | "searchStrategy"
  | "user"
  | "userGroup"
>;

type ActiveMembership = Readonly<{ groupId: string }>;

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
    groupIds: string[];
    modelId: string;
    userId: string;
  }
): Promise<boolean> {
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
  input: { groupIds: string[]; strategyId: string; userId: string }
): Promise<boolean> {
  if (input.strategyId === "search-disabled") return true;
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
    groupIds: string[];
    modelId: string;
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

  const [credentials, assignments] = await Promise.all([
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

  const modelConfig = normalizeProviderModelConfiguration(model.activeConfig);
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
    select: { groupId: true },
    where: {
      group: { archivedAt: null },
      userId: input.userId
    }
  });
  const groupIds = memberships.map((membership) => membership.groupId);
  const answer = await loadRole(db, {
    connectionId: input.providerConnectionId,
    groupIds,
    modelId: input.providerModelId,
    requireEntitlement: true,
    userId: input.userId
  });

  const strategy = await db.searchStrategy.findFirst({
    select: {
      config: true,
      enabled: true,
      kind: true,
      providerModelId: true,
      strategyId: true
    },
    where: { enabled: true, strategyId: input.searchStrategyId }
  });
  if (!strategy || !(await hasSearchEntitlement(db, {
    groupIds,
    strategyId: input.searchStrategyId,
    userId: input.userId
  }))) {
    throw new ProviderAdmissionError("search_strategy_not_available");
  }

  let search: ProviderAdmissionRole | undefined;
  let technicalSearchConfiguration: RunSearchStrategyConfiguration | undefined;
  if (strategy.kind === "openai_native_web_search") {
    if (
      answer.snapshot.model.adapterKind !== "openai_responses_native" ||
      !answer.modelConfiguration.capabilities.nativeSearch
    ) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
  } else if (strategy.kind === "perplexity_tool_search") {
    if (
      !strategy.providerModelId ||
      strategy.providerModelId === input.providerModelId ||
      !answer.modelConfiguration.capabilities.toolCalling
    ) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    const technicalModel = await db.providerModel.findUnique({
      select: { connectionId: true },
      where: { id: strategy.providerModelId }
    });
    if (!technicalModel) throw new ProviderAdmissionError("search_strategy_not_available");
    search = await loadRole(db, {
      connectionId: technicalModel.connectionId,
      groupIds,
      modelId: strategy.providerModelId,
      requireEntitlement: false,
      userId: input.userId
    });
    technicalSearchConfiguration = searchConfiguration(strategy, search);
  } else if (strategy.kind !== "none") {
    throw new ProviderAdmissionError("search_strategy_not_available");
  }

  const withoutFingerprint = {
    answer,
    requestedSearchStrategyId: input.searchStrategyId,
    ...(search ? { search } : {}),
    ...(technicalSearchConfiguration
      ? { searchConfiguration: technicalSearchConfiguration }
      : {}),
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
