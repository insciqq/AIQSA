import { admitModelGenerationBudget } from "../providers/modelOutputAllowance";
import { hasVerifiedImageCapability } from "../providers/imageGenerationEvidence";
import { hasVerifiedDedicatedProtocol } from "../providers/systemRoleEvidence";
import { decodeDecisionEvidence } from "../providers/decisionEvidence";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { CatalogAdapterKind } from "../../domain/catalog";
import { resolveProviderCredential } from "../../domain/providerCredentialResolution";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  ProviderConfigurationError,
  type ProviderModelConfiguration
} from "../providers/providerConfiguration";
import { resolveProviderModelCapabilities } from "../providers/providerModelCapabilities";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type {
  RunModelConfiguration,
  RunSearchStrategyConfiguration
} from "../runs/runRepositoryContract";
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "../auth/fullAccessGroup";
import {
  decodeSearchPlan,
  SEARCH_DISABLED_STRATEGY_ID,
  searchPlanEnabled,
  searchSettingPlan,
  type SearchOptionUse,
  type SearchPlan,
  type SearchUnavailableReason
} from "../../domain/search";
import {
  searchExecutionModes,
  technicalSearchModelSupports
} from "../search/configuration";
import {
  loadInstallationSearch,
  routeBelongsToOption,
  type ResolvedSearchRoute as ResolvedSearchRouteRow,
  type SearchEngineOption,
  type SearchOptionRouteRow
} from "../search/engineResolution";
import { DEEPSEEK_SEARCH_API_MODEL_ID } from "../providers/deepSeekSearchApi";
import type { SearchProbeBinding } from "../search/probeBinding";
import { hasVerifiedStructuredOutput } from "../providers/structuredOutputEvidence";
import { hasVerifiedToolChoiceMode } from "../providers/forcedToolCallEvidence";
import { hasVerifiedPdfInput } from "../providers/pdfInputEvidence";
import { hasVerifiedVisionInput } from "../providers/visionInputEvidence";

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
  verifiedVisionInput?: true;
  verifiedStructuredOutput?: true;
  verifiedForcedToolCall?: true;
  authority?: SearchProbeBinding | null;
  credentialSource: "default" | "group" | "user";
  modelConfiguration: RunModelConfiguration;
  snapshot: ProviderExecutionSnapshot;
}>;

export type EmbeddingProviderAdmissionRole = Readonly<{
  authority: SearchProbeBinding;
  configuration: ProviderModelConfiguration;
  credentialSource: "default" | "group" | "user";
  provider: string;
  snapshot: ProviderExecutionSnapshot;
}>;

export type RerankerProviderAdmissionRole = Readonly<{
  authority: SearchProbeBinding;
  configuration: ProviderModelConfiguration;
  credentialSource: "default" | "group" | "user";
  provider: string;
  snapshot: ProviderExecutionSnapshot;
}>;

export type ImageProviderAdmissionRole = RerankerProviderAdmissionRole;
export type DecisionProviderAdmissionRole = RerankerProviderAdmissionRole;

export type ProviderAdmissionPlan = Readonly<{
  answer: ProviderAdmissionRole;
  fingerprint: string;
  requiresClientToolCoexistence?: true;
  /** Search on or off as admitted (`SEARCH_ON_PLAN` or `SEARCH_OFF_PLAN`). */
  requestedSearchPlan: SearchPlan;
  /** In-answer search first, then the installation's engine and its backup, in the order a request uses them. */
  searches: readonly Readonly<{
    bindingKey: string | null;
    configuration: RunSearchStrategyConfiguration;
    integrationId: string;
    optionId: string;
    ordinal: number;
    revisionId: string;
    role?: ProviderAdmissionRole;
    use: SearchOptionUse;
  }>[];
  /** Search was on but no engine could be bound for the run, and why. */
  searchUnavailable?: SearchUnavailableReason;
  selection: Readonly<{
    providerConnectionId: string;
    providerModelId: string;
  }>;
  userId: string;
}>;

export type AdmissionPrisma = Pick<
  Prisma.TransactionClient,
  | "accessGrant"
  | "providerCredential"
  | "providerGroupCredentialAssignment"
  | "providerModel"
  | "providerModelCredentialCheck"
  | "providerUserCredentialAssignment"
  | "searchOption"
  | "searchPolicy"
  | "searchStrategy"
  | "user"
  | "userGroup"
>;

type ActiveMembership = Readonly<{
  group: Readonly<{ systemRole: "full_access" | null }>;
  groupId: string;
}>;

type RoleCredentialAuthority =
  | Readonly<{ kind: "installation" }>
  | Readonly<{
      fullAccess: boolean;
      groupIds: string[];
      kind: "user";
      userId: string;
    }>;

type SharedRoleInput = Readonly<{
  connectionId: string;
  credentialAuthority: RoleCredentialAuthority;
  modelId: string;
  requireEntitlement: boolean;
}>;

type AnswerRoleInput = SharedRoleInput & Readonly<{
  modelClass: "answer";
  requireAnswerSelectable: boolean;
}>;

type EmbeddingRoleInput = SharedRoleInput & Readonly<{
  modelClass: "embedding";
}>;

type ImageRoleInput = SharedRoleInput & Readonly<{ modelClass: "image" }>;
type DecisionRoleInput = SharedRoleInput & Readonly<{ modelClass: "decision" }>;

type RerankerRoleInput = SharedRoleInput & Readonly<{
  modelClass: "reranker";
}>;

async function activeUserAuthority(
  db: AdmissionPrisma,
  userId: string,
  options: Readonly<{ requireAdmin?: boolean }> = {}
): Promise<{
  fullAccess: boolean;
  groupIds: string[];
}> {
  const user = await db.user.findFirst({
    select: { id: true, role: true },
    where: { id: userId, status: "active" }
  });
  if (!user || options.requireAdmin && user.role !== "admin") {
    throw new ProviderAdmissionError("user_not_available");
  }
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
  options: Readonly<{ nativePdfInput?: boolean }> = {}
): ProviderExecutionSnapshot {
  if (
    snapshot.model.adapterKind !== "fake" &&
    snapshot.model.modelClass !== "answer"
  ) {
    throw new ProviderAdmissionError("model_not_available");
  }
  return normalizeProviderExecutionSnapshot({
    ...snapshot,
    model: {
      ...snapshot.model,
      capabilities: {
        ...resolveProviderModelCapabilities({
          adapterKind: snapshot.model.adapterKind as CatalogAdapterKind,
          capabilities: snapshot.model.capabilities,
          providerFamily: snapshot.providerFamily,
          upstreamModelId: snapshot.model.upstreamModelId
        }),
        nativePdfInput: options.nativePdfInput ?? false
      }
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

/**
 * Whether the user may search. With one installation engine (operator decisions 2026-11-26) a grant of any Search
 * source, the user's or a group's, carries over as the right to search with whatever engine the administrator runs;
 * the protected Full access group has it. Which engine runs is never the grant's.
 */
async function hasSearchEntitlement(
  db: AdmissionPrisma,
  input: { fullAccess: boolean; groupIds: string[]; userId: string }
): Promise<boolean> {
  if (input.fullAccess) return true;
  return (await db.accessGrant.count({
    where: {
      enabled: true,
      searchStrategy: { not: null },
      NOT: { searchStrategy: SEARCH_DISABLED_STRATEGY_ID },
      OR: [
        { userId: input.userId },
        ...(input.groupIds.length ? [{ groupId: { in: input.groupIds } }] : [])
      ]
    }
  })) > 0;
}

async function loadRole(
  db: AdmissionPrisma,
  input: AnswerRoleInput
): Promise<ProviderAdmissionRole>;
async function loadRole(
  db: AdmissionPrisma,
  input: EmbeddingRoleInput
): Promise<EmbeddingProviderAdmissionRole>;
async function loadRole(
  db: AdmissionPrisma,
  input: RerankerRoleInput
): Promise<RerankerProviderAdmissionRole>;
async function loadRole(
  db: AdmissionPrisma,
  input: ImageRoleInput
): Promise<ImageProviderAdmissionRole>;
async function loadRole(
  db: AdmissionPrisma,
  input: DecisionRoleInput
): Promise<DecisionProviderAdmissionRole>;
async function loadRole(
  db: AdmissionPrisma,
  input: AnswerRoleInput | EmbeddingRoleInput | RerankerRoleInput | ImageRoleInput | DecisionRoleInput
): Promise<ProviderAdmissionRole | EmbeddingProviderAdmissionRole |
  RerankerProviderAdmissionRole> {
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
      modelClass: input.modelClass,
      connection: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        enabled: true
      }
    }
  });
  if (!model) throw new ProviderAdmissionError("model_not_available");

  if (input.requireEntitlement) {
    if (input.credentialAuthority.kind !== "user" || !(await hasModelEntitlement(db, {
      connectionId: input.connectionId,
      fullAccess: input.credentialAuthority.fullAccess,
      groupIds: input.credentialAuthority.groupIds,
      modelId: input.modelId,
      userId: input.credentialAuthority.userId
    }))) {
      throw new ProviderAdmissionError("model_not_available");
    }
  }

  const connectionConfig = normalizeProviderConnectionConfiguration(model.connection.activeConfig);
  if (model.connection.family === "fake") {
    if (
      input.modelClass !== "answer" ||
      !isRecord(model.activeConfig) ||
      model.activeConfig.adapterKind !== "fake"
    ) {
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
      })
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
  if (
    modelConfig.modelClass !== input.modelClass ||
    (input.modelClass === "answer" &&
      input.requireAnswerSelectable &&
      !modelConfig.answerSelectable) ||
    (input.modelClass === "embedding" &&
      (modelConfig.adapterKind !== "openai_embeddings_compatible" ||
        !modelConfig.embedding ||
        modelConfig.embedding.providerFamily !== model.connection.family)) ||
    (input.modelClass === "reranker" &&
      (model.connection.family !== "openrouter" ||
        modelConfig.adapterKind !== "openrouter_rerank")) ||
    (input.modelClass === "decision" &&
      (model.connection.family !== "openrouter" || modelConfig.adapterKind !== "openrouter_decisions"))
  ) {
    throw new ProviderAdmissionError("model_not_available");
  }

  const userAuthority = input.credentialAuthority.kind === "user"
    ? input.credentialAuthority
    : null;
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
    userAuthority
      ? db.providerGroupCredentialAssignment.findMany({
          select: { credentialId: true, groupId: true },
          where: {
            connectionId: model.connectionId,
            groupId: { in: userAuthority.groupIds }
          }
        })
      : Promise.resolve([]),
    userAuthority
      ? db.providerUserCredentialAssignment.findUnique({
          select: { credentialId: true },
          where: {
            connectionId_userId: {
              connectionId: model.connectionId,
              userId: userAuthority.userId
            }
          }
        })
      : Promise.resolve(null)
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
    memberships: (userAuthority?.groupIds ?? []).map((groupId) => ({
      archived: false,
      groupId
    })),
    policy: userAuthority ? model.connection.unassignedPolicy : "use_default"
  });
  if (!credential.ok) throw new ProviderAdmissionError(credential.code);

  const check = await db.providerModelCredentialCheck.findFirst({
    select: { evidence: true, id: true },
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
  if (!check || input.modelClass !== "answer" && !hasVerifiedDedicatedProtocol(check.evidence, modelConfig)) {
    throw new ProviderAdmissionError("model_not_available");
  }
  const structuredOutput = input.modelClass === "answer" &&
    hasVerifiedStructuredOutput(check.evidence, modelConfig);
  const forcedToolCalling = input.modelClass === "answer" &&
    hasVerifiedToolChoiceMode(check.evidence, modelConfig, "native");
  const validatedAutoToolCalling = input.modelClass === "answer" &&
    hasVerifiedToolChoiceMode(check.evidence, modelConfig, "validated_auto");
  const nativePdfInput = input.modelClass === "answer" &&
    modelConfig.capabilities.nativePdfInput &&
    hasVerifiedPdfInput(check.evidence, modelConfig);

  const normalizedSnapshot = normalizeProviderExecutionSnapshot({
    connection: connectionConfig,
    connectionDisplayName: model.connection.displayName,
    connectionId: model.connectionId,
    credentialId: credential.credentialId,
    credentialVersionId: credential.credentialVersionId,
    ...(input.modelClass === "decision" ? { decisionVerification:
      decodeDecisionEvidence(isRecord(check.evidence) ? check.evidence.decisions : null) } : {}),
    model: modelConfig,
    modelDisplayName: model.displayName,
    providerFamily: model.connection.family,
    providerModelId: model.id,
    version: 1
  });
  const resolvedSnapshot = input.modelClass === "answer"
    ? withResolvedModelCapabilities(normalizedSnapshot, { nativePdfInput })
    : normalizedSnapshot;
  const snapshot = (structuredOutput || forcedToolCalling || validatedAutoToolCalling) &&
    resolvedSnapshot.model.adapterKind !== "fake"
    ? {
        ...resolvedSnapshot,
        model: {
          ...resolvedSnapshot.model,
          capabilities: {
            ...resolvedSnapshot.model.capabilities,
            ...(forcedToolCalling ? { forcedToolCalling: true } : {}),
            ...(validatedAutoToolCalling ? { validatedAutoToolCalling: true } : {}),
            ...(structuredOutput ? { structuredOutput: true } : {})
          }
        }
      }
    : resolvedSnapshot;
  const resolvedModel = snapshot.model;
  const authority = {
    connectionId: model.connectionId,
    connectionVersion: model.connection.activeVersion,
    credentialId: credential.credentialId,
    credentialVersionId: credential.credentialVersionId,
    modelVersion: model.activeVersion,
    providerModelId: model.id
  } satisfies SearchProbeBinding;
  if (input.modelClass === "image") {
    if (resolvedModel.adapterKind === "fake" || resolvedModel.modelClass !== "image" || !resolvedModel.image) {
      throw new ProviderAdmissionError("model_not_available");
    }
    const family = resolvedModel.image.profile === "codex_lb" ? "openai_compatible" : resolvedModel.image.profile;
    if (family !== model.connection.family) throw new ProviderAdmissionError("model_not_available");
    const configuration = { ...resolvedModel, capabilities: { ...resolvedModel.capabilities,
      imageGeneration: hasVerifiedImageCapability(check.evidence, resolvedModel, "imageGeneration"),
      imageEditing: hasVerifiedImageCapability(check.evidence, resolvedModel, "imageEditing") } };
    return { authority, configuration, credentialSource: credential.source, provider: model.provider,
      snapshot: { ...snapshot, model: configuration } };
  }
  if (input.modelClass === "embedding") {
    if (
      resolvedModel.adapterKind === "fake" ||
      resolvedModel.modelClass !== "embedding" ||
      resolvedModel.adapterKind !== "openai_embeddings_compatible" ||
      !resolvedModel.embedding
    ) {
      throw new ProviderAdmissionError("model_not_available");
    }
    return {
      authority,
      configuration: resolvedModel,
      credentialSource: credential.source,
      provider: model.provider,
      snapshot
    };
  }
  if (input.modelClass === "reranker" || input.modelClass === "decision") {
    if (
      resolvedModel.adapterKind === "fake" ||
      resolvedModel.modelClass !== input.modelClass ||
      resolvedModel.adapterKind !== (input.modelClass === "reranker" ? "openrouter_rerank" : "openrouter_decisions")
    ) {
      throw new ProviderAdmissionError("model_not_available");
    }
    return {
      authority,
      configuration: resolvedModel,
      credentialSource: credential.source,
      provider: model.provider,
      snapshot
    };
  }
  if (
    resolvedModel.adapterKind === "fake" ||
    resolvedModel.modelClass !== "answer"
  ) {
    throw new ProviderAdmissionError("model_not_available");
  }

  return {
    authority,
    credentialSource: credential.source,
    ...(structuredOutput ? { verifiedStructuredOutput: true as const } : {}),
    ...(forcedToolCalling || validatedAutoToolCalling ? { verifiedForcedToolCall: true as const } : {}),
    ...(hasVerifiedVisionInput(check.evidence, resolvedModel)
      ? { verifiedVisionInput: true as const } : {}),
    modelConfiguration: {
      adapterKind: resolvedModel.adapterKind as CatalogAdapterKind,
      capabilities: resolvedModel.capabilities,
      defaultParams: resolvedModel.defaultParams,
      ...(resolvedModel.reasoningRequestMapping
        ? { reasoningRequestMapping: resolvedModel.reasoningRequestMapping }
        : {})
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
    credentialAuthority: {
      fullAccess: authority.fullAccess,
      groupIds: authority.groupIds,
      kind: "user",
      userId: input.userId
    },
    modelClass: "answer",
    modelId: input.providerModelId,
    requireAnswerSelectable: false,
    requireEntitlement: false
  });
}

/** Resolve an entitled embedding deployment through the exact same active
 * user, grant, credential-precedence, and availability tuple as answer
 * admission. Adapter construction and per-request secret use remain in the
 * embedding runtime. */
export async function loadEmbeddingProviderRole(
  db: AdmissionPrisma,
  input: { providerModelId: string; userId: string }
): Promise<EmbeddingProviderAdmissionRole> {
  const authority = await activeUserAuthority(db, input.userId);
  const model = await db.providerModel.findUnique({
    select: { connectionId: true },
    where: { id: input.providerModelId }
  });
  if (!model) throw new ProviderAdmissionError("model_not_available");
  return loadRole(db, {
    connectionId: model.connectionId,
    credentialAuthority: {
      fullAccess: authority.fullAccess,
      groupIds: authority.groupIds,
      kind: "user",
      userId: input.userId
    },
    modelClass: "embedding",
    modelId: input.providerModelId,
    requireEntitlement: true
  });
}

/** Installation-owned embedding work uses the connection's installation
 * credential. Personal grants and credential assignments are deliberately not
 * consulted. */
export async function loadInstallationEmbeddingProviderRole(
  db: AdmissionPrisma,
  input: { providerModelId: string }
): Promise<EmbeddingProviderAdmissionRole> {
  const model = await db.providerModel.findUnique({
    select: {
      connection: { select: { family: true } },
      connectionId: true
    },
    where: { id: input.providerModelId }
  });
  if (!model || model.connection.family === "fake") {
    throw new ProviderAdmissionError("model_not_available");
  }
  return loadRole(db, {
    connectionId: model.connectionId,
    credentialAuthority: { kind: "installation" },
    modelClass: "embedding",
    modelId: input.providerModelId,
    requireEntitlement: false
  });
}

/** Resolve installation-owned internal answer work through the connection's
 * explicit default credential. The policy author is audit metadata only, and
 * ordinary user/group credential precedence is intentionally not consulted. */
export async function loadInstallationAnswerProviderRole(
  db: AdmissionPrisma,
  input: { providerModelId: string }
): Promise<ProviderAdmissionRole> {
  const model = await db.providerModel.findUnique({
    select: { connectionId: true },
    where: { id: input.providerModelId }
  });
  if (!model) throw new ProviderAdmissionError("model_not_available");
  try {
    return await loadRole(db, {
      connectionId: model.connectionId,
      credentialAuthority: { kind: "installation" },
      modelClass: "answer",
      modelId: input.providerModelId,
      requireAnswerSelectable: false,
      requireEntitlement: false
    });
  } catch (error) {
    if (error instanceof ProviderConfigurationError ||
      error instanceof Error && error.message === "provider_execution_snapshot_invalid") {
      throw new ProviderAdmissionError("model_not_available");
    }
    throw error;
  }
}

/** The image role is shared installation authority, independent of the chat model/key. */
export async function loadInstallationImageProviderRole(db: AdmissionPrisma, input: { providerModelId: string }): Promise<ImageProviderAdmissionRole> {
  const model = await db.providerModel.findUnique({ select: { connectionId: true }, where: { id: input.providerModelId } });
  if (!model) throw new ProviderAdmissionError("model_not_available");
  try {
    return await loadRole(db, { connectionId: model.connectionId, credentialAuthority: { kind: "installation" },
      modelClass: "image", modelId: input.providerModelId, requireEntitlement: false });
  } catch (error) {
    if (error instanceof ProviderConfigurationError || error instanceof Error && error.message === "provider_execution_snapshot_invalid") {
      throw new ProviderAdmissionError("model_not_available");
    }
    throw error;
  }
}

/** Resolve the installation-owned reranker role (Knowledge retrieval
 * reranking and Memory semantic sorting) through the connection's exact
 * default credential. It is deliberately a distinct model class and can
 * never enter answer or embedding admission. */
export async function loadInstallationRerankerProviderRole(
  db: AdmissionPrisma,
  input: { providerModelId: string }
): Promise<RerankerProviderAdmissionRole> {
  const model = await db.providerModel.findUnique({
    select: { connectionId: true },
    where: { id: input.providerModelId }
  });
  if (!model) throw new ProviderAdmissionError("model_not_available");
  try {
    return await loadRole(db, {
      connectionId: model.connectionId,
      credentialAuthority: { kind: "installation" },
      modelClass: "reranker",
      modelId: input.providerModelId,
      requireEntitlement: false
    });
  } catch (error) {
    if (error instanceof ProviderConfigurationError ||
      error instanceof Error && error.message === "provider_execution_snapshot_invalid") {
      throw new ProviderAdmissionError("model_not_available");
    }
    throw error;
  }
}

/** Optional semantic judgments have their own installation model/key and
 * verified protocol. Selecting a Memory or answer model grants no authority. */
export async function loadInstallationDecisionProviderRole(
  db: AdmissionPrisma, input: { providerModelId: string }
): Promise<DecisionProviderAdmissionRole> {
  const model = await db.providerModel.findUnique({ select: { connectionId: true }, where: { id: input.providerModelId } });
  if (!model) throw new ProviderAdmissionError("model_not_available");
  try {
    return await loadRole(db, { connectionId: model.connectionId, credentialAuthority: { kind: "installation" },
      modelClass: "decision", modelId: input.providerModelId, requireEntitlement: false });
  } catch (error) {
    if (error instanceof ProviderConfigurationError || error instanceof Error && error.message === "provider_execution_snapshot_invalid") {
      throw new ProviderAdmissionError("model_not_available");
    }
    throw error;
  }
}

type LoadedSearchOption = SearchOptionRouteRow;
type ResolvedSearchRoute = ResolvedSearchRouteRow;

/**
 * OpenAI's hosted search inside an OpenAI-protocol answer model's own request: on the answer's own connection, with
 * the model's verified hosted search, beside its function tools.
 */
function inAnswerSearchUsable(answer: ProviderAdmissionRole): boolean {
  return answer.modelConfiguration.capabilities.nativeSearch === true &&
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
  // Results reach any tool-calling answer model; a technical model only runs the search. Perplexity Sonar, a chat
  // model, never searches for itself.
  return route.draft.protocol !== "openrouter_perplexity_chat" || route.draft.providerModelId !== answerModelId;
}

async function loadClientRouteRole(
  db: AdmissionPrisma,
  input: {
    credentialAuthority?: RoleCredentialAuthority;
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
    credentialAuthority: input.credentialAuthority ?? {
      fullAccess: input.fullAccess,
      groupIds: input.groupIds,
      kind: "user",
      userId: input.userId
    },
    modelClass: "answer",
    modelId: providerModelId,
    requireAnswerSelectable: false,
    requireEntitlement: false
  });
  return role.authority &&
    role.snapshot.connectionId === input.option.sourceConnectionId &&
    technicalSearchModelSupports(input.route.draft.protocol, {
      adapterKind: role.snapshot.model.adapterKind,
      nativeSearch: role.modelConfiguration.capabilities.nativeSearch
    })
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
      generationBudget: admitModelGenerationBudget((role ?? answer).snapshot, route.draft.maxOutputTokens),
      ...(role
        ? {
            modelCapabilities: role.modelConfiguration.capabilities,
            // An OpenRouter technical model brings its routing and data collection.
            ...(route.draft.protocol === "openrouter_perplexity_chat" || route.draft.protocol === "openrouter_web_search"
              ? { modelDefaultParams: role.modelConfiguration.defaultParams }
              : {})
          }
        : {})
    },
    credentialMode: route.draft.credentialMode,
    displayName: option.displayName,
    executionModes: searchExecutionModes(route.draft.adapterKind),
    kind: route.strategy.kind,
    // The raw results API names itself in usage and evidence, not the model
    // whose connection key it borrows.
    modelId: route.draft.protocol === "deepseek_search_api" && role
      ? DEEPSEEK_SEARCH_API_MODEL_ID
      : role?.snapshot.model.upstreamModelId ?? null,
    protocol: route.draft.protocol,
    provider: role?.snapshot.providerFamily ?? answer.snapshot.providerFamily,
    providerModelId: route.draft.providerModelId,
    revisionId: route.revisionId,
    searchStrategyRowId: route.strategy.id,
    strategyId: option.optionId
  };
}

/**
 * Admits the run's answer model and, with Search on, the installation's Search (operator decisions 2026-11-26): an
 * OpenAI-protocol answer model with verified hosted search searches inside its own answer while the administrator's
 * switch is on, and the run always binds the installation's client engine and its backup, which every request
 * without in-answer search (another model, a sub-agent, a researcher) searches with through `web_search`. Search is on
 * when `searchPlan` names any source; the sources it names are the browser's, never which engine runs. An engine that
 * cannot be used is never replaced: the plan carries the reason (`searchUnavailable`) and admission still succeeds.
 */
export async function loadProviderAdmissionPlan(
  db: AdmissionPrisma,
  input: {
    providerConnectionId: string;
    providerModelId: string;
    requiresClientToolCoexistence?: boolean;
    searchPlan: SearchPlan;
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
  const answer = await loadRole(db, {
    connectionId: input.providerConnectionId,
    credentialAuthority: { fullAccess, groupIds, kind: "user", userId: input.userId },
    modelClass: "answer",
    modelId: input.providerModelId,
    requireAnswerSelectable: true,
    requireEntitlement: true
  });

  const decodedPlan = decodeSearchPlan(input.searchPlan);
  if (!decodedPlan.ok) throw new ProviderAdmissionError("search_strategy_not_available");
  const searchEnabled = searchPlanEnabled(decodedPlan.plan);
  const searches: NonNullable<ProviderAdmissionPlan["searches"]>[number][] = [];
  let searchUnavailable: SearchUnavailableReason | undefined;

  if (searchEnabled && !(await hasSearchEntitlement(db, { fullAccess, groupIds, userId: input.userId }))) {
    searchUnavailable = "search_not_granted";
  } else if (searchEnabled) {
    const installation = await loadInstallationSearch(db);
    const hosted = installation.policy.inAnswerSearch && inAnswerSearchUsable(answer)
      ? installation.hosted.get(answer.snapshot.connectionId) ?? null
      : null;
    if (hosted) {
      searches.push({
        bindingKey: null,
        configuration: searchConfiguration(hosted.option, hosted.route, answer, undefined),
        integrationId: hosted.route.strategy.id,
        optionId: hosted.option.optionId,
        ordinal: searches.length,
        revisionId: hosted.route.revisionId,
        use: "in_answer"
      });
    }
    const bind = async (candidate: SearchEngineOption, use: "backup" | "engine"): Promise<boolean> => {
      const route = candidate.route;
      if (!route || !clientRouteCompatible(candidate.option, route, answer, input.providerModelId)) return false;
      let role: ProviderAdmissionRole | null;
      try {
        role = await loadClientRouteRole(db, {
          fullAccess, groupIds, option: candidate.option, route, userId: input.userId
        });
      } catch (error) {
        if (!(error instanceof ProviderAdmissionError)) throw error;
        role = null;
      }
      if (!role) return false;
      searches.push({
        bindingKey: `search:${candidate.optionId}`,
        configuration: searchConfiguration(candidate.option, route, answer, role),
        integrationId: route.strategy.id,
        optionId: candidate.optionId,
        ordinal: searches.length,
        revisionId: route.revisionId,
        role,
        use
      });
      return true;
    };
    const { backup, engine, reason } = installation.resolution;
    if (!engine) {
      searchUnavailable = reason ?? "search_engine_not_configured";
    } else if (!(await bind(engine, "engine"))) {
      // This user's credentials or this answer model cannot reach the engine: no other engine stands in.
      searchUnavailable = "search_engine_unavailable";
    } else if (backup) {
      await bind(backup, "backup");
    }
  }

  const withoutFingerprint = {
    answer,
    ...(input.requiresClientToolCoexistence ? { requiresClientToolCoexistence: true as const } : {}),
    requestedSearchPlan: searchSettingPlan(searchEnabled),
    searches,
    ...(searchUnavailable ? { searchUnavailable } : {}),
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
