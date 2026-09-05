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
  type SearchPlan
} from "../../domain/search";
import {
  compatibleTechnicalAdapter,
  searchStrategyKind,
  normalizeSearchDraft,
  searchExecutionModes
} from "../search/configuration";
import type { SearchProbeBinding } from "../search/probeBinding";
import { hasVerifiedStructuredOutput } from "../providers/structuredOutputEvidence";
import { hasVerifiedForcedToolCall } from "../providers/forcedToolCallEvidence";
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

export type ProviderAdmissionPlan = Readonly<{
  answer: ProviderAdmissionRole;
  /** `project` means installation/shared authority; it never consults the
   * initiating user's provider grants or credential assignments. */
  executionScope?: "personal" | "project";
  fingerprint: string;
  requiresClientToolCoexistence?: true;
  requestedSearchPlan: SearchPlan;
  requestedSearchPreferencePlan?: SearchPlan | null;
  requestedSearchPreferenceSource?: "organization" | "personal";
  searches: readonly Readonly<{
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

export type AdmissionPrisma = Pick<
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
  input: AnswerRoleInput | EmbeddingRoleInput | RerankerRoleInput
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
        modelConfig.adapterKind !== "openrouter_rerank"))
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
  if (!check) throw new ProviderAdmissionError("model_not_available");
  const structuredOutput = input.modelClass === "answer" &&
    hasVerifiedStructuredOutput(check.evidence, modelConfig);
  const forcedToolCalling = input.modelClass === "answer" &&
    hasVerifiedForcedToolCall(check.evidence, modelConfig);
  const nativePdfInput = input.modelClass === "answer" &&
    modelConfig.capabilities.nativePdfInput &&
    hasVerifiedPdfInput(check.evidence, modelConfig);

  const normalizedSnapshot = normalizeProviderExecutionSnapshot({
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
  });
  const resolvedSnapshot = input.modelClass === "answer"
    ? withResolvedModelCapabilities(normalizedSnapshot, { nativePdfInput })
    : normalizedSnapshot;
  const snapshot = (structuredOutput || forcedToolCalling) &&
    resolvedSnapshot.model.adapterKind !== "fake"
    ? {
        ...resolvedSnapshot,
        model: {
          ...resolvedSnapshot.model,
          capabilities: {
            ...resolvedSnapshot.model.capabilities,
            ...(forcedToolCalling ? { forcedToolCalling: true } : {}),
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
  if (input.modelClass === "reranker") {
    if (
      resolvedModel.adapterKind === "fake" ||
      resolvedModel.modelClass !== "reranker" ||
      resolvedModel.adapterKind !== "openrouter_rerank"
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
    ...(hasVerifiedVisionInput(check.evidence, resolvedModel)
      ? { verifiedVisionInput: true as const } : {}),
    modelConfiguration: {
      adapterKind: resolvedModel.adapterKind as CatalogAdapterKind,
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

/** Project Knowledge retrieval uses the installation/shared embedding
 * deployment selected by the Project authority.  Personal grants and
 * credential assignments are deliberately not consulted. */
export async function loadProjectEmbeddingProviderRole(
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
      requireAnswerSelectable: true,
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

type ResolvedSearchRouteCandidate = Readonly<{
  option: LoadedSearchOption;
  ordinal: number;
  role?: ProviderAdmissionRole;
  route: ResolvedSearchRoute;
}>;

function supportedSearchOption(option: LoadedSearchOption): boolean {
  if (!option.enabled || option.archivedAt !== null) return false;
  if (option.kind === "none") return false;
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
    strategy.kind !== searchStrategyKind(draft.protocol, draft.adapterKind)
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
  if (route.draft.protocol === "anthropic_web_search") {
    return option.kind === "web_search" &&
      answer.snapshot.providerFamily === "anthropic" &&
      answer.snapshot.model.adapterKind === "anthropic_messages";
  }
  if (route.draft.protocol === "deepseek_responses_web_search") {
    return option.kind === "web_search" &&
      answer.snapshot.providerFamily === "deepseek" &&
      answer.snapshot.model.adapterKind === "deepseek_responses_native";
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
    return route.draft.protocol === "anthropic_web_search" ||
      route.draft.protocol === "deepseek_responses_web_search" ||
      route.draft.protocol === "openai_responses_web_search";
  }
  if (option.kind === "gemini_google_search") {
    return route.draft.protocol === "gemini_google_search";
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
    return route.draft.protocol === "anthropic_web_search" ||
      route.draft.protocol === "deepseek_responses_web_search" ||
      route.draft.protocol === "openai_responses_web_search";
  }
  if (option.kind === "gemini_google_search") {
    return route.draft.protocol === "gemini_google_search";
  }
  return option.kind === "perplexity_search" &&
    route.draft.adapterKind === "provider_model_client" &&
    route.draft.protocol === "openrouter_perplexity_chat";
}

function hostedRouteSupportsClientTools(candidate: ResolvedSearchRouteCandidate): boolean {
  return candidate.route.draft.adapterKind === "answer_provider_hosted" &&
    (candidate.route.draft.protocol === "deepseek_responses_web_search" ||
      candidate.route.draft.protocol === "openai_responses_web_search");
}

function validCompleteRouteAssignment(input: Readonly<{
  assignment: readonly ResolvedSearchRouteCandidate[];
  mode: SearchPlan["mode"];
  requiresClientToolCoexistence: boolean;
}>): boolean {
  const hosted = input.assignment.filter((candidate) =>
    candidate.route.draft.adapterKind === "answer_provider_hosted"
  );
  if (hosted.length > 1) return false;
  // A singleton logical source has no fan-out distinction, so its existing
  // same-connection hosted behavior remains preferred in either UI mode.
  if (
    input.assignment.length > 1 &&
    input.mode === "all_selected" &&
    hosted.length > 0
  ) {
    return false;
  }
  if (hosted.length === 0) return true;
  const mustCoexistWithClientTools = input.requiresClientToolCoexistence ||
    input.assignment.some((candidate) =>
      candidate.route.draft.adapterKind === "provider_model_client"
    );
  return !mustCoexistWithClientTools || hostedRouteSupportsClientTools(hosted[0]!);
}

function firstCompleteRouteAssignment(input: Readonly<{
  candidates: readonly (readonly ResolvedSearchRouteCandidate[])[];
  mode: SearchPlan["mode"];
  requiresClientToolCoexistence: boolean;
}>): ResolvedSearchRouteCandidate[] | null {
  const assignment: ResolvedSearchRouteCandidate[] = [];
  function visit(index: number): ResolvedSearchRouteCandidate[] | null {
    if (index === input.candidates.length) {
      return validCompleteRouteAssignment({
        assignment,
        mode: input.mode,
        requiresClientToolCoexistence: input.requiresClientToolCoexistence
      })
        ? [...assignment]
        : null;
    }
    for (const candidate of input.candidates[index] ?? []) {
      assignment.push(candidate);
      const complete = visit(index + 1);
      assignment.pop();
      if (complete) return complete;
    }
    return null;
  }
  return visit(0);
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
    executionScope?: "personal" | "project";
    requiresClientToolCoexistence?: boolean;
    searchPlan: SearchPlan;
    searchPreferencePlan?: SearchPlan | null;
    searchPreferenceSource?: "organization" | "personal";
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
  const projectScope = input.executionScope === "project";
  if (projectScope && input.searchPreferenceSource === "personal") {
    // A Project run never imports a member's personal Search preference.  The
    // caller may still select an explicitly Project-eligible option through
    // the canonical Project defaults, but a personal preference is an
    // authority boundary violation even when the option happens to be
    // installation-safe.
    throw new ProviderAdmissionError("search_strategy_not_available");
  }
  const projectModel = projectScope
    ? await db.providerModel.findFirst({
        select: {
          connection: { select: { family: true } }
        },
        where: { id: input.providerModelId }
      })
    : null;
  if (projectScope && !projectModel) {
    throw new ProviderAdmissionError("model_not_available");
  }

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
    requestedSearchPreferencePlan = input.searchPreferencePlan;
    const preferenceOptions: LoadedSearchOption[] = [];
    for (const optionId of requestedSearchPreferencePlan.optionIds) {
      const option = await loadOption(optionId);
      if (!option || !supportedSearchOption(option) || option.kind === "none" ||
        (!projectScope && !(await hasSearchEntitlement(db, {
          fullAccess,
          groupIds,
          strategyId: optionId,
          userId: input.userId
        })))) {
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
              userId: input.userId,
              ...(projectScope ? { credentialAuthority: { kind: "installation" as const } } : {})
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
  } else if (input.searchPreferenceSource !== undefined &&
    input.searchPreferenceSource !== "organization") {
    throw new ProviderAdmissionError("search_strategy_not_available");
  }
  const answer = await loadRole(db, {
    connectionId: input.providerConnectionId,
    credentialAuthority: projectScope
      ? { kind: "installation" }
      : { fullAccess, groupIds, kind: "user", userId: input.userId },
    modelClass: "answer",
    modelId: input.providerModelId,
    requireAnswerSelectable: true,
    requireEntitlement: !projectScope
  });

  const decodedPlan = decodeSearchPlan(input.searchPlan);
  if (!decodedPlan.ok) throw new ProviderAdmissionError("search_strategy_not_available");
  const requestedSearchPlan = decodedPlan.plan;
  const optionIds = requestedSearchPlan.optionIds;
  const searches: NonNullable<ProviderAdmissionPlan["searches"]>[number][] = [];
  const routeCandidates: ResolvedSearchRouteCandidate[][] = [];
  let routeLoadError: ProviderAdmissionError | undefined;

  const strategyIds = [...optionIds];

  for (const [ordinal, optionId] of strategyIds.entries()) {
    const option = await loadOption(optionId);
    if (!option || !supportedSearchOption(option) ||
      (!projectScope && !(await hasSearchEntitlement(db, {
      fullAccess,
      groupIds,
      strategyId: optionId,
      userId: input.userId
      })))) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    if (option.kind === "none") continue;

    const routes = option.strategies.flatMap((strategy) => {
      const route = normalizeActiveSearchRoute(strategy);
      return route && routeBelongsToOption(option, route) ? [route] : [];
    });
    if (hasAmbiguousRouteKinds(routes)) {
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    const candidates: ResolvedSearchRouteCandidate[] = routes
      .filter((route) => hostedRouteCompatible(option, route, answer))
      .map((route) => ({ option, ordinal, route }));
    const clientRouteRequired = candidates.length === 0 || optionIds.length > 1 ||
      input.requiresClientToolCoexistence === true;
    for (const route of clientRouteRequired ? routes : []) {
      if (!clientRouteCompatible(option, route, answer, input.providerModelId)) continue;
      try {
        const role = await loadClientRouteRole(db, {
          fullAccess,
          groupIds,
          option,
          route,
          userId: input.userId,
          ...(projectScope ? { credentialAuthority: { kind: "installation" as const } } : {})
        });
        if (role) candidates.push({ option, ordinal, role, route });
      } catch (error) {
        if (!(error instanceof ProviderAdmissionError)) throw error;
        routeLoadError ??= error;
      }
    }
    if (candidates.length === 0) {
      if (routeLoadError) throw routeLoadError;
      throw new ProviderAdmissionError("search_strategy_not_available");
    }
    routeCandidates.push(candidates);
  }

  const assignment = firstCompleteRouteAssignment({
    candidates: routeCandidates,
    mode: requestedSearchPlan.mode,
    requiresClientToolCoexistence: input.requiresClientToolCoexistence === true
  });
  if (!assignment) {
    if (routeLoadError) throw routeLoadError;
    throw new ProviderAdmissionError("search_strategy_not_available");
  }
  for (const candidate of assignment) {
    const { option, ordinal, role, route } = candidate;
    const configuration = searchConfiguration(option, route, answer, role);
    searches.push({
      bindingKey: role ? `search:${option.optionId}` : null,
      configuration,
      integrationId: route.strategy.id,
      optionId: option.optionId,
      ordinal,
      revisionId: route.revisionId,
      ...(role ? { role } : {})
    });
  }

  const withoutFingerprint = {
    answer,
    ...(input.executionScope ? { executionScope: input.executionScope } : {}),
    ...(input.requiresClientToolCoexistence ? { requiresClientToolCoexistence: true as const } : {}),
    requestedSearchPlan,
    ...(input.searchPreferenceSource
      ? {
          requestedSearchPreferencePlan: requestedSearchPreferencePlan ?? null,
          requestedSearchPreferenceSource: input.searchPreferenceSource
        }
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
