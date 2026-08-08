import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { defaultProviderModels } from "../../../domain/catalog";
import {
  ANTHROPIC_PROVIDER_SEARCH_INTEGRATION_ID,
  ANTHROPIC_PROVIDER_SEARCH_STRATEGY_ID,
  GEMINI_PROVIDER_SEARCH_INTEGRATION_ID,
  GEMINI_PROVIDER_SEARCH_STRATEGY_ID,
  OPENAI_PROVIDER_SEARCH_INTEGRATION_ID,
  OPENAI_PROVIDER_SEARCH_STRATEGY_ID
} from "../../../domain/search";
import {
  providerModelTemplateId,
  type ProviderModelTemplateKey
} from "../../../domain/providerTemplates";
import {
  filterAvailableProviderModels,
  filterExposedProviderModels,
  type CatalogProviderModelRow
} from "../../catalog/prismaCatalogData";
import { resolveEntitlements } from "../../auth/entitlements";
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "../../auth/fullAccessGroup";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";
import {
  searchValidationFingerprint
} from "../../search/probeBinding";
import {
  adminProviderQuickSetupPolicy,
  providerModelConfigurationFromCatalogEntry
} from "./quickSetupPolicy";
import type {
  AdminProviderQuickSetupActor,
  AdminProviderQuickSetupClearPlan,
  AdminProviderQuickSetupCommitPlan,
  AdminProviderQuickSetupCommitResult,
  AdminProviderQuickSetupInspection,
  AdminProviderQuickSetupRepository
} from "./quickSetupRepositoryContract";

type QuickSetupDb = Pick<
  Prisma.TransactionClient,
  | "accessGrant"
  | "authSession"
  | "providerConnection"
  | "providerCredential"
  | "providerCredentialVersion"
  | "providerDraftCheck"
  | "providerModel"
  | "providerModelCredentialCheck"
  | "providerUserCredentialAssignment"
  | "searchIntegrationRevision"
  | "searchOption"
  | "searchStrategy"
  | "user"
  | "userGroup"
  | "userSettings"
>;

type QuickSetupRepositoryOptions = Readonly<{
  exposeFake?: boolean;
}>;

class QuickSetupCatalogUnavailableError extends Error {}

const MAX_QUICK_SETUP_PRESERVED_MODELS = 64;
const ANTHROPIC_SEARCH_OPTION_DATABASE_ID = "00000000-0000-4000-8000-000000001405";
const ANTHROPIC_SEARCH_OPTION_ID = "anthropic-web-search";
const OPENAI_SEARCH_OPTION_DATABASE_ID = "00000000-0000-4000-8000-000000001402";
const OPENAI_SEARCH_OPTION_ID = "openai-native-web-search";
const OPENAI_SEARCH_OPTION_TEMPLATE_KEY = "search:openai";
const OPENAI_PROVIDER_SEARCH_DISPLAY_NAME = "OpenAI Search";
const OPENAI_PROVIDER_SEARCH_DESCRIPTION =
  "Web search provided by OpenAI.";
const OPENAI_PROVIDER_SEARCH_FALLBACK_ID =
  `openai-search-client:${adminProviderQuickSetupPolicy("openai").connection.id}`;

type QuickSetupSearchSpec = Readonly<{
  clientKind: "gemini_google_search" | "provider_model_web_search";
  description: string;
  displayName: string;
  fallbackId: string;
  hostedKind: "anthropic_native_web_search" | "gemini_google_search" | "openai_native_web_search";
  integrationId: string;
  optionDatabaseId: string;
  optionId: string;
  optionKind: "gemini_google_search" | "web_search";
  optionTemplateKey: string;
  protocol: "anthropic_web_search" | "gemini_google_search" | "openai_responses_web_search";
  provider: "anthropic" | "gemini" | "openai";
  strategyId: string;
}>;

function quickSetupSearchSpec(
  provider: AdminProviderQuickSetupCommitPlan["provider"]
): QuickSetupSearchSpec | null {
  if (provider === "anthropic") {
    return {
      clientKind: "provider_model_web_search",
      description: "Web search provided by Anthropic.",
      displayName: "Anthropic Search",
      fallbackId: `anthropic-search-client:${adminProviderQuickSetupPolicy("anthropic").connection.id}`,
      hostedKind: "anthropic_native_web_search",
      integrationId: ANTHROPIC_PROVIDER_SEARCH_INTEGRATION_ID,
      optionDatabaseId: ANTHROPIC_SEARCH_OPTION_DATABASE_ID,
      optionId: ANTHROPIC_SEARCH_OPTION_ID,
      optionKind: "web_search",
      optionTemplateKey: "search:anthropic",
      protocol: "anthropic_web_search",
      provider: "anthropic",
      strategyId: ANTHROPIC_PROVIDER_SEARCH_STRATEGY_ID
    };
  }
  if (provider === "openai") {
    return {
      clientKind: "provider_model_web_search",
      description: OPENAI_PROVIDER_SEARCH_DESCRIPTION,
      displayName: OPENAI_PROVIDER_SEARCH_DISPLAY_NAME,
      fallbackId: OPENAI_PROVIDER_SEARCH_FALLBACK_ID,
      hostedKind: "openai_native_web_search",
      integrationId: OPENAI_PROVIDER_SEARCH_INTEGRATION_ID,
      optionDatabaseId: OPENAI_SEARCH_OPTION_DATABASE_ID,
      optionId: OPENAI_SEARCH_OPTION_ID,
      optionKind: "web_search",
      optionTemplateKey: OPENAI_SEARCH_OPTION_TEMPLATE_KEY,
      protocol: "openai_responses_web_search",
      provider: "openai",
      strategyId: OPENAI_PROVIDER_SEARCH_STRATEGY_ID
    };
  }
  if (provider === "gemini") {
    return {
      clientKind: "gemini_google_search",
      description: "Google Search grounding for eligible Gemini models.",
      displayName: "Google Search",
      fallbackId: `gemini-search-client:${adminProviderQuickSetupPolicy("gemini").connection.id}`,
      hostedKind: "gemini_google_search",
      integrationId: GEMINI_PROVIDER_SEARCH_INTEGRATION_ID,
      optionDatabaseId: "00000000-0000-4000-8000-000000001403",
      optionId: "gemini-google-search",
      optionKind: "gemini_google_search",
      optionTemplateKey: "search:gemini-google",
      protocol: "gemini_google_search",
      provider: "gemini",
      strategyId: GEMINI_PROVIDER_SEARCH_STRATEGY_ID
    };
  }
  return null;
}

function isSerializationConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  return error.code === "P2034" || (
    error.code === "P2010" &&
    error.meta?.code === "40001"
  );
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalConnectionConfig(value: unknown, expected: unknown): boolean {
  try {
    return sameJson(
      normalizeProviderConnectionConfiguration(value),
      normalizeProviderConnectionConfiguration(expected)
    );
  } catch {
    return false;
  }
}

function canonicalModelConfig(value: unknown, expected: ProviderModelConfiguration): boolean {
  try {
    return sameJson(
      normalizeProviderModelConfiguration(value),
      normalizeProviderModelConfiguration(expected)
    );
  } catch {
    return false;
  }
}

function codeOwnedModel(templateKey: string, provider: string) {
  const id = providerModelTemplateId(templateKey);
  if (!id) return null;
  const [templateProvider, ...modelParts] = templateKey.split(":");
  if (templateProvider !== provider) return null;
  const upstreamModelId = modelParts.join(":");
  const model = defaultProviderModels.find(
    (candidate) => candidate.provider === provider && candidate.modelId === upstreamModelId
  );
  if (!model || model.adapterKind === "fake") return null;
  return {
    configuration: providerModelConfigurationFromCatalogEntry(model),
    id,
    model,
    templateKey: templateKey as ProviderModelTemplateKey
  };
}

function modelLegacyFields(configuration: ProviderModelConfiguration) {
  return {
    capabilities: json(configuration.capabilities),
    contextWindow: configuration.capabilities.contextWindow ?? 1,
    defaultParams: json(configuration.defaultParams),
    modelId: configuration.upstreamModelId,
    supportsNativeSearch: configuration.capabilities.nativeSearch,
    supportsPdf: configuration.capabilities.pdf,
    supportsReasoning: configuration.capabilities.reasoning,
    supportsVision: configuration.capabilities.vision
  };
}

function quickSetupCredentialLabel(credentialId: string): string {
  return `Quick setup · ${credentialId}`;
}

async function loadQuickSetupState(
  db: QuickSetupDb,
  input: AdminProviderQuickSetupActor & Readonly<{
    now: Date;
    provider: "anthropic" | "gemini" | "openai" | "openrouter";
  }>
) {
  const policy = adminProviderQuickSetupPolicy(input.provider);
  const [actor, session, settings, connections, grants, memberships] = await Promise.all([
    db.user.findUnique({
      select: { id: true, role: true, status: true, updatedAt: true },
      where: { id: input.userId }
    }),
    db.authSession.findUnique({
      select: { expiresAt: true, id: true, revokedAt: true, userId: true },
      where: { id: input.sessionId }
    }),
    db.userSettings.findUnique({
      select: { defaultProviderModelId: true, id: true, updatedAt: true },
      where: { userId: input.userId }
    }),
    db.providerConnection.findMany({
      include: {
        credentials: {
          include: {
            activeVersion: {
              select: {
                id: true,
                revokedAt: true,
                secretEnvelope: true,
                testedAt: true,
                version: true
              }
            },
            groupAssignments: {
              orderBy: [{ groupId: "asc" }, { credentialId: "asc" }],
              select: { connectionId: true, credentialId: true, groupId: true, updatedAt: true }
            },
            userAssignments: {
              orderBy: [{ userId: "asc" }, { credentialId: "asc" }],
              select: { connectionId: true, credentialId: true, updatedAt: true, userId: true }
            },
            versions: {
              orderBy: [{ version: "asc" }, { id: "asc" }],
              select: {
                activatedAt: true,
                credentialId: true,
                id: true,
                revokedAt: true,
                secretEnvelope: true,
                testedAt: true,
                version: true
              }
            }
          },
          orderBy: { id: "asc" }
        },
        models: {
          include: {
            activeCredentialChecks: {
              orderBy: [{ checkedAt: "desc" }, { id: "asc" }],
              select: {
                checkedAt: true,
                connectionId: true,
                connectionVersion: true,
                credentialId: true,
                credentialVersionId: true,
                id: true,
                modelVersion: true,
                providerModelId: true,
                status: true
              }
            },
            draftChecks: {
              orderBy: { id: "asc" },
              select: {
                checkedAt: true,
                connectionDraftVersion: true,
                connectionId: true,
                credentialDraftVersion: true,
                credentialId: true,
                credentialVersionId: true,
                evidence: true,
                fingerprint: true,
                id: true,
                modelDraftVersion: true,
                providerModelId: true,
                status: true
              }
            }
          },
          orderBy: { id: "asc" }
        }
      },
      orderBy: { id: "asc" },
      where: {
        OR: [
          { family: policy.provider },
          { id: policy.connection.id },
          { templateKey: policy.connection.templateKey }
        ]
      }
    }),
    db.accessGrant.findMany({
      orderBy: { id: "asc" },
      where: {
        OR: [
          { providerConnection: { family: policy.provider } },
          { providerModel: { connection: { family: policy.provider } } }
        ]
      }
    }),
    db.userGroup.findMany({
      include: { group: { select: { archivedAt: true, systemRole: true } } },
      orderBy: [{ groupId: "asc" }, { userId: "asc" }],
      where: { userId: input.userId }
    })
  ]);

  const canonicalMatches = connections.filter((candidate) =>
    candidate.id === policy.connection.id ||
    candidate.templateKey === policy.connection.templateKey
  );
  const exactCanonicalConnections = canonicalMatches.filter((candidate) =>
    candidate.id === policy.connection.id &&
    candidate.templateKey === policy.connection.templateKey &&
    candidate.family === policy.provider
  );
  const connection = exactCanonicalConnections.length === 1
    ? exactCanonicalConnections[0]
    : null;
  let advancedReason: "ambiguous" | "custom" | null =
    canonicalMatches.length !== exactCanonicalConnections.length ||
    exactCanonicalConnections.length > 1
      ? "ambiguous"
      : null;

  const connectionHasActiveTuple = Boolean(
    connection?.activeConfig !== null ||
    connection?.activeVersion !== 0 ||
    connection?.activatedAt !== null
  );
  const connectionActiveCanonical = Boolean(
    connection && connection.activeConfig !== null && connection.activeVersion > 0 &&
    connection.activatedAt !== null &&
    canonicalConnectionConfig(connection.activeConfig, policy.connection.configuration)
  );
  if (connection && (
    (connectionHasActiveTuple && !connectionActiveCanonical) ||
    (!connectionHasActiveTuple &&
      !canonicalConnectionConfig(connection.draftConfig, policy.connection.configuration))
  )) {
    advancedReason = "custom";
  }

  const credentials = connection?.credentials ?? [];
  const actorAssignments = credentials.flatMap((credential) =>
    (credential.userAssignments ?? []).filter(
      (assignment) => assignment.userId === input.userId
    )
  );
  if (actorAssignments.length > 1) advancedReason = "ambiguous";
  const actorAssignment = actorAssignments.length === 1 ? actorAssignments[0] : null;
  const assignedCredential = actorAssignment
    ? credentials.find((credential) => credential.id === actorAssignment.credentialId) ?? null
    : null;

  const reusableQuickSetupCredential = assignedCredential &&
    assignedCredential.label === quickSetupCredentialLabel(assignedCredential.id) &&
    assignedCredential.groupAssignments.length === 0 &&
    (assignedCredential.userAssignments ?? []).length === 1 &&
    assignedCredential.userAssignments?.[0]?.userId === input.userId &&
    connection?.defaultCredentialId !== assignedCredential.id &&
    assignedCredential.draftSecretEnvelope === null &&
    Number.isSafeInteger(assignedCredential.draftVersion) &&
    assignedCredential.draftVersion >= 0 &&
    assignedCredential.versions.length === assignedCredential.draftVersion &&
    assignedCredential.versions.every((version, index) =>
      version.credentialId === assignedCredential.id &&
      version.version === index + 1 &&
      version.secretEnvelope !== null
    ) && (
      assignedCredential.activeVersion === null
        ? assignedCredential.activeVersionId === null && assignedCredential.draftVersion === 0
        : assignedCredential.activeVersionId === assignedCredential.activeVersion.id &&
          assignedCredential.activeVersion.version === assignedCredential.draftVersion
    )
      ? assignedCredential
      : null;

  const candidateByIdentity = new Map(
    policy.candidates.flatMap((candidate) => [
      [candidate.modelId, candidate] as const,
      [candidate.templateKey, candidate] as const
    ])
  );
  for (const candidateConnection of connections) {
    if (candidateConnection.id === policy.connection.id) continue;
    if (candidateConnection.models.some((model) =>
      candidateByIdentity.has(model.id) ||
      Boolean(model.templateKey && candidateByIdentity.has(model.templateKey))
    )) {
      advancedReason = "ambiguous";
    }
  }
  const activePolicyModels = [] as Array<{
    checkedAt: Date | null;
    displayName: string;
    enabled: boolean;
    id: string;
    templateKey: ProviderModelTemplateKey;
  }>;
  for (const model of connection?.models ?? []) {
    const candidate = candidateByIdentity.get(model.id) ??
      (model.templateKey ? candidateByIdentity.get(model.templateKey) : undefined);
    if (!candidate) continue;
    if (
      model.id !== candidate.modelId || model.templateKey !== candidate.templateKey ||
      model.provider !== policy.provider
    ) {
      advancedReason = "ambiguous";
      continue;
    }
    const hasActiveTuple = model.activeConfig !== null || model.activeVersion !== 0 ||
      model.activatedAt !== null;
    const activeCanonical = model.activeConfig !== null && model.activeVersion > 0 &&
      model.activatedAt !== null &&
      canonicalModelConfig(model.activeConfig, candidate.configuration);
    if (
      (hasActiveTuple && !activeCanonical) ||
      (!hasActiveTuple && !canonicalModelConfig(model.draftConfig, candidate.configuration))
    ) {
      advancedReason = "custom";
      continue;
    }
    if (!activeCanonical) continue;
    const matchingCheck = assignedCredential?.activeVersion
      ? model.activeCredentialChecks.find((check) =>
          check.status === "available" &&
          check.connectionId === connection?.id &&
          check.providerModelId === model.id &&
          check.credentialId === assignedCredential.id &&
          check.credentialVersionId === assignedCredential.activeVersion?.id &&
          check.connectionVersion === connection?.activeVersion &&
          check.modelVersion === model.activeVersion
        )
      : null;
    activePolicyModels.push({
      checkedAt: matchingCheck?.checkedAt ?? null,
      displayName: model.displayName,
      enabled: model.enabled,
      id: model.id,
      templateKey: candidate.templateKey
    });
  }

  const activeMemberships = memberships.filter(
    (membership) => !membership.group.archivedAt
  );
  const groupIds = activeMemberships.map((membership) => membership.groupId);
  const fullAccess = activeMemberships.some(
    (membership) => membership.group.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
  );
  const actingUserGrants = grants.filter(
    (grant) => grant.userId === input.userId && grant.groupId === null
  );
  const directGrantedModelIds = new Set(
    actingUserGrants
      .filter((grant) => grant.providerModelId !== null)
      .map((grant) => grant.providerModelId as string)
  );
  const fullAccessModel = fullAccess
    ? policy.candidates.map((candidate) =>
        activePolicyModels.find((model) =>
          model.id === candidate.modelId && model.enabled && model.checkedAt
        )
      ).find((model) => Boolean(model)) ??
      activePolicyModels.find((model) => model.enabled && model.checkedAt) ??
      activePolicyModels.find((model) => model.enabled) ??
      activePolicyModels[0] ?? null
    : null;
  const selectedModel = activePolicyModels.find(
    (model) => model.id === settings?.defaultProviderModelId &&
      directGrantedModelIds.has(model.id)
  ) ?? policy.candidates.map((candidate) =>
    activePolicyModels.find((model) =>
      model.id === candidate.modelId && directGrantedModelIds.has(model.id)
    )
  ).find((model) => Boolean(model)) ??
    activePolicyModels.find((model) => model.id === settings?.defaultProviderModelId) ??
    fullAccessModel;
  const directModelGrants = selectedModel
    ? actingUserGrants.filter((grant) => grant.providerModelId === selectedModel.id)
    : [];
  const directGrantReady = directModelGrants.some((grant) => grant.enabled);
  const credentialReady = Boolean(
    assignedCredential?.enabled && assignedCredential.activeVersion &&
    !assignedCredential.activeVersion.revokedAt && assignedCredential.activeVersion.secretEnvelope
  );
  const ready = Boolean(
    connection?.enabled && connectionActiveCanonical && selectedModel?.checkedAt &&
    selectedModel.enabled && credentialReady && (fullAccess || directGrantReady)
  );
  const configured = Boolean(actorAssignment || selectedModel || directModelGrants.length);
  const actorAuthorized = actor?.role === "admin" && actor.status === "active" &&
    session?.userId === input.userId && !session.revokedAt && session.expiresAt > input.now;
  const modelConnectionIds = new Map(connections.flatMap((candidateConnection) =>
    candidateConnection.models.map((model) => [model.id, candidateConnection.id] as const)
  ));
  const entitlements = resolveEntitlements(input.userId, groupIds, grants.map((grant) => ({
    ...grant,
    providerModelConnectionId: grant.providerModelId
      ? modelConnectionIds.get(grant.providerModelId) ?? null
      : null
  })), { fullAccess });
  const catalogRows = connections.flatMap((candidateConnection) =>
    candidateConnection.models.map((model) => ({
      ...model,
      connection: candidateConnection
    } as unknown as CatalogProviderModelRow))
  );
  const exposedModels = filterExposedProviderModels({
    entitlements,
    models: filterAvailableProviderModels({
      exposeFake: false,
      memberships,
      models: catalogRows,
      userId: input.userId
    })
  });
  const availableCanonicalModels = exposedModels.filter(
    (model) => model.connectionId === policy.connection.id
  );
  if (availableCanonicalModels.length > MAX_QUICK_SETUP_PRESERVED_MODELS) {
    advancedReason = "custom";
  }
  const preservedModels = availableCanonicalModels
    .slice(0, MAX_QUICK_SETUP_PRESERVED_MODELS)
    .flatMap((model) => {
      try {
        return [{
          id: model.id,
          upstreamModelId: normalizeProviderModelConfiguration(model.activeConfig).upstreamModelId
        }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const state = advancedReason
    ? "advanced_required" as const
    : ready
      ? "ready" as const
      : configured && connection?.enabled === false
        ? "disabled" as const
        : configured
          ? "needs_attention" as const
          : "not_configured" as const;

  const globallyPristine = !connections.some((candidate) =>
    candidate.id !== policy.connection.id ||
    candidate.enabled || candidate.activeVersion > 0 || candidate.credentials.length > 0 ||
    candidate.models.some((model) =>
      model.enabled || model.activeVersion > 0 || model.activeCredentialChecks.length > 0 ||
      model.draftChecks.length > 0
    )
  ) && grants.length === 0;
  const mode = advancedReason || !actorAuthorized || !settings
    ? null
    : ready
      ? "replacement" as const
      : globallyPristine
        ? "initial" as const
        : "recovery" as const;

  const safeFingerprint = fingerprint({
    actor: actor ? {
      id: actor.id,
      role: actor.role,
      status: actor.status,
      updatedAt: actor.updatedAt
    } : null,
    connections: connections.map((candidateConnection) => ({
      activeConfig: candidateConnection.activeConfig,
      activeVersion: candidateConnection.activeVersion,
      activatedAt: candidateConnection.activatedAt,
      credentials: candidateConnection.credentials.map((credential) => ({
        activeVersion: credential.activeVersion ? {
          id: credential.activeVersion.id,
          revokedAt: credential.activeVersion.revokedAt,
          secretEnvelopeFingerprint: credential.activeVersion.secretEnvelope === null
            ? null
            : fingerprint(credential.activeVersion.secretEnvelope),
          testedAt: credential.activeVersion.testedAt,
          version: credential.activeVersion.version
        } : null,
        activeVersionId: credential.activeVersionId,
        draftSecretConfigured: credential.draftSecretEnvelope !== null,
        draftVersion: credential.draftVersion,
        enabled: credential.enabled,
        groupAssignments: credential.groupAssignments,
        id: credential.id,
        label: credential.label,
        updatedAt: credential.updatedAt,
        userAssignments: credential.userAssignments ?? [],
        versions: credential.versions.map((version) => ({
          activatedAt: version.activatedAt,
          credentialId: version.credentialId,
          id: version.id,
          revokedAt: version.revokedAt,
          secretEnvelopeFingerprint: version.secretEnvelope === null
            ? null
            : fingerprint(version.secretEnvelope),
          testedAt: version.testedAt,
          version: version.version
        }))
      })),
      defaultCredentialId: candidateConnection.defaultCredentialId,
      displayName: candidateConnection.displayName,
      draftConfig: candidateConnection.draftConfig,
      draftVersion: candidateConnection.draftVersion,
      enabled: candidateConnection.enabled,
      family: candidateConnection.family,
      id: candidateConnection.id,
      models: candidateConnection.models.map((model) => ({
        activeChecks: model.activeCredentialChecks,
        activeConfig: model.activeConfig,
        activeVersion: model.activeVersion,
        activatedAt: model.activatedAt,
        displayName: model.displayName,
        draftConfig: model.draftConfig,
        draftVersion: model.draftVersion,
        enabled: model.enabled,
        id: model.id,
        draftChecks: model.draftChecks.map((check) => ({
          checkedAt: check.checkedAt,
          connectionDraftVersion: check.connectionDraftVersion,
          connectionId: check.connectionId,
          credentialDraftVersion: check.credentialDraftVersion,
          credentialId: check.credentialId,
          credentialVersionId: check.credentialVersionId,
          evidenceFingerprint: check.evidence === null ? null : fingerprint(check.evidence),
          fingerprint: check.fingerprint,
          id: check.id,
          modelDraftVersion: check.modelDraftVersion,
          providerModelId: check.providerModelId,
          status: check.status
        })),
        templateKey: model.templateKey,
        updatedAt: model.updatedAt
      })),
      templateKey: candidateConnection.templateKey,
      unassignedPolicy: candidateConnection.unassignedPolicy,
      updatedAt: candidateConnection.updatedAt
    })),
    grants: grants.map((grant) => ({
      enabled: grant.enabled,
      groupId: grant.groupId,
      id: grant.id,
      providerConnectionId: grant.providerConnectionId,
      providerModelId: grant.providerModelId,
      updatedAt: grant.updatedAt,
      userId: grant.userId
    })),
    memberships: memberships.map((membership) => ({
      archivedAt: membership.group.archivedAt,
      groupId: membership.groupId,
      systemRole: membership.group.systemRole,
      userId: membership.userId
    })),
    preservedModels,
    provider: input.provider,
    session: session ? {
      expiresAt: session.expiresAt,
      id: session.id,
      revokedAt: session.revokedAt,
      userId: session.userId
    } : null,
    settings: settings ? {
      defaultProviderModelId: settings.defaultProviderModelId,
      id: settings.id
    } : null,
    version: 4
  });

  const inspection: AdminProviderQuickSetupInspection = {
    actingUserDefault: Boolean(selectedModel && settings?.defaultProviderModelId === selectedModel.id),
    authorized: Boolean(actorAuthorized),
    configured,
    fingerprint: safeFingerprint,
    mode,
    model: selectedModel,
    preservedModels,
    quickSetupAssignment: actorAssignment
      ? { credentialId: actorAssignment.credentialId }
      : null,
    quickSetupCredential: reusableQuickSetupCredential
      ? {
          draftVersion: reusableQuickSetupCredential.draftVersion,
          id: reusableQuickSetupCredential.id
        }
      : null,
    provider: input.provider,
    state: advancedReason || !actorAuthorized || !settings ? "advanced_required" : state
  };
  return { connection, inspection, settings };
}

export async function lockAdminProviderQuickSetupState(
  tx: Prisma.TransactionClient,
  plan: AdminProviderQuickSetupCommitPlan | AdminProviderQuickSetupClearPlan
): Promise<void> {
  const policy = adminProviderQuickSetupPolicy(plan.provider);
  const searchSpec = quickSetupSearchSpec(plan.provider);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${plan.actor.userId} FOR UPDATE
  `);
  if (searchSpec) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "SearchOption"
      WHERE "optionId" = ${searchSpec.optionId}
         OR "id" = ${searchSpec.optionDatabaseId}
      ORDER BY "id"
      FOR UPDATE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "SearchStrategy"
      WHERE "strategyId" = ${searchSpec.strategyId}
         OR "id" = ${searchSpec.integrationId}
         OR "strategyId" = ${searchSpec.fallbackId}
         OR "id" = ${searchSpec.fallbackId}
      ORDER BY "id"
      FOR UPDATE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT revision."id" FROM "SearchIntegrationRevision" AS revision
      JOIN "SearchStrategy" AS strategy ON strategy."id" = revision."searchStrategyId"
      WHERE strategy."strategyId" = ${searchSpec.strategyId}
      ORDER BY revision."revisionNumber", revision."id"
      FOR UPDATE OF revision
    `);
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "UserSettings" WHERE "userId" = ${plan.actor.userId} FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "AuthSession" WHERE "id" = ${plan.actor.sessionId} FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "ProviderConnection"
    WHERE "family" = ${policy.provider}
       OR "id" = ${policy.connection.id}
       OR "templateKey" = ${policy.connection.templateKey}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT credential."id" FROM "ProviderCredential" AS credential
    JOIN "ProviderConnection" AS connection ON connection."id" = credential."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY credential."id" FOR UPDATE OF credential
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT version."id" FROM "ProviderCredentialVersion" AS version
    JOIN "ProviderCredential" AS credential ON credential."id" = version."credentialId"
    JOIN "ProviderConnection" AS connection ON connection."id" = credential."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY version."id" FOR UPDATE OF version
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT model."id" FROM "ProviderModel" AS model
    JOIN "ProviderConnection" AS connection ON connection."id" = model."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY model."id" FOR UPDATE OF model
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT check_row."id" FROM "ProviderModelCredentialCheck" AS check_row
    JOIN "ProviderConnection" AS connection ON connection."id" = check_row."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY check_row."id" FOR UPDATE OF check_row
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT check_row."id" FROM "ProviderDraftCheck" AS check_row
    JOIN "ProviderConnection" AS connection ON connection."id" = check_row."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY check_row."id" FOR UPDATE OF check_row
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT assignment."connectionId", assignment."groupId"
    FROM "ProviderGroupCredentialAssignment" AS assignment
    JOIN "ProviderConnection" AS connection ON connection."id" = assignment."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY assignment."connectionId", assignment."groupId"
    FOR UPDATE OF assignment
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT assignment."connectionId", assignment."userId"
    FROM "ProviderUserCredentialAssignment" AS assignment
    JOIN "ProviderConnection" AS connection ON connection."id" = assignment."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY assignment."connectionId", assignment."userId"
    FOR UPDATE OF assignment
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT grant_row."id" FROM "AccessGrant" AS grant_row
    LEFT JOIN "ProviderModel" AS model ON model."id" = grant_row."providerModelId"
    LEFT JOIN "ProviderConnection" AS connection
      ON connection."id" = grant_row."providerConnectionId"
    WHERE connection."family" = ${policy.provider}
       OR model."connectionId" IN (
         SELECT "id" FROM "ProviderConnection" WHERE "family" = ${policy.provider}
       )
       OR (${plan.provider === "anthropic"} AND
         grant_row."searchStrategy" = ${ANTHROPIC_SEARCH_OPTION_ID})
       OR (${plan.provider === "openai"} AND
         grant_row."searchStrategy" = ${OPENAI_SEARCH_OPTION_ID})
       OR (${plan.provider === "gemini"} AND
         grant_row."searchStrategy" = 'gemini-google-search')
    ORDER BY grant_row."id" FOR UPDATE OF grant_row
  `);
}

async function synchronizeQuickSetupSearch(
  tx: Prisma.TransactionClient,
  plan: AdminProviderQuickSetupCommitPlan
): Promise<"needs_attention" | "ready" | null> {
  const search = plan.search;
  if (!search) return null;
  const spec = quickSetupSearchSpec(plan.provider);
  if (
    !spec ||
    search.draft.adapterKind !== "provider_model_client" ||
    search.draft.credentialMode !== "provider_model" ||
    search.draft.protocol !== spec.protocol ||
    search.draft.providerModelId !== plan.candidate.modelId ||
    search.evidence.method !== "configuration" ||
    search.evidence.protocol !== spec.protocol ||
    search.evidence.status !== "available" ||
    search.evidence.normalizedSourceCount !== 0 ||
    search.integrationId !== spec.integrationId
  ) {
    return "needs_attention";
  }
  const sourceConnectionId = adminProviderQuickSetupPolicy(spec.provider).connection.id;
  const storedEvidence = search.evidence;
  const validationFingerprint = searchValidationFingerprint(storedEvidence);

  const optionOwner = await tx.searchOption.findUnique({
    where: { optionId: spec.optionId }
  });
  const optionIdOwner = optionOwner?.id === spec.optionDatabaseId
    ? optionOwner
    : await tx.searchOption.findUnique({
        where: { id: spec.optionDatabaseId }
      });
  if (
    (optionOwner && optionOwner.id !== spec.optionDatabaseId) ||
    (optionIdOwner && optionIdOwner.optionId !== spec.optionId)
  ) {
    return "needs_attention";
  }
  const currentOption = optionOwner ?? optionIdOwner;
  if (currentOption && (
    currentOption.kind !== spec.optionKind ||
    currentOption.templateKey !== spec.optionTemplateKey ||
    currentOption.sourceConnectionId !== sourceConnectionId
  )) {
    return "needs_attention";
  }
  const option = currentOption ?? await tx.searchOption.create({
    data: {
      description: spec.description,
      displayName: spec.displayName,
      enabled: true,
      id: spec.optionDatabaseId,
      kind: spec.optionKind,
      optionId: spec.optionId,
      sourceConnectionId,
      templateKey: spec.optionTemplateKey
    }
  });
  await tx.searchOption.update({
    data: {
      archivedAt: null,
      description: spec.description,
      displayName: spec.displayName,
      enabled: true,
      sourceConnectionId
    },
    where: { id: option.id }
  });

  const hosted = await tx.searchStrategy.findUnique({
    where: { strategyId: spec.optionId }
  });
  if (hosted) {
    if (
      hosted.archivedAt !== null ||
      hosted.adapterKind !== "answer_provider_hosted" ||
      hosted.credentialMode !== "answer_provider" ||
      hosted.provider !== spec.provider ||
      hosted.providerModelId !== null ||
      hosted.searchOptionId !== option.id ||
      hosted.kind !== spec.hostedKind
    ) {
      return "needs_attention";
    }
    if (hosted.displayName !== spec.displayName ||
      hosted.description !== spec.description) {
      await tx.searchStrategy.update({
        data: {
          description: spec.description,
          displayName: spec.displayName
        },
        where: { id: hosted.id }
      });
    }
  }

  const strategyOwner = await tx.searchStrategy.findUnique({
    include: { activeRevision: true },
    where: { strategyId: spec.strategyId }
  });
  const idOwner = strategyOwner?.id === spec.integrationId
    ? strategyOwner
    : await tx.searchStrategy.findUnique({
        include: { activeRevision: true },
        where: { id: spec.integrationId }
      });
  const preferredOwned = strategyOwner?.id === spec.integrationId &&
    idOwner?.strategyId === spec.strategyId &&
    strategyOwner.searchOptionId === option.id
    ? strategyOwner
    : null;
  const preferredFree = !strategyOwner && !idOwner;
  const fallbackStrategyOwner = await tx.searchStrategy.findUnique({
    include: { activeRevision: true },
    where: { strategyId: spec.fallbackId }
  });
  const fallbackIdOwner = fallbackStrategyOwner?.id === spec.fallbackId
    ? fallbackStrategyOwner
    : await tx.searchStrategy.findUnique({
        include: { activeRevision: true },
        where: { id: spec.fallbackId }
      });
  const fallbackOwned = fallbackStrategyOwner?.id === spec.fallbackId &&
    fallbackIdOwner?.strategyId === spec.fallbackId &&
    fallbackStrategyOwner.searchOptionId === option.id
    ? fallbackStrategyOwner
    : null;
  const fallbackFree = !fallbackStrategyOwner && !fallbackIdOwner;
  const currentPreferred = preferredOwned?.archivedAt === null ? preferredOwned : null;
  const currentFallback = fallbackOwned?.archivedAt === null ? fallbackOwned : null;
  const unarchivedClientRoute = await tx.searchStrategy.findFirst({
    select: { id: true },
    where: {
      adapterKind: "provider_model_client",
      archivedAt: null,
      searchOptionId: option.id
    }
  });
  if (unarchivedClientRoute &&
    unarchivedClientRoute.id !== currentPreferred?.id &&
    unarchivedClientRoute.id !== currentFallback?.id) {
    // An operator-owned draft or route already occupies the one client slot
    // for this logical source. Quick setup must leave it untouched and finish
    // provider setup with Search requiring explicit administrator attention.
    return "needs_attention";
  }
  const usePreferred = Boolean(currentPreferred || (!currentFallback && preferredFree));
  if (!currentPreferred && !currentFallback && !preferredFree && !fallbackFree) {
    return "needs_attention";
  }
  const current = currentPreferred ?? currentFallback;
  const routeIdentity = usePreferred
    ? {
        id: spec.integrationId,
        strategyId: spec.strategyId
      }
    : {
        id: spec.fallbackId,
        strategyId: spec.fallbackId
      };
  if (current && (
    current.archivedAt !== null ||
    current.searchOptionId !== option.id ||
    current.kind !== spec.clientKind ||
    current.adapterKind !== "provider_model_client" ||
    current.credentialMode !== "provider_model" ||
    current.provider !== spec.provider
  )) {
    return "needs_attention";
  }

  const stored = current ?? await tx.searchStrategy.create({
    data: {
      adapterKind: search.draft.adapterKind,
      config: json({}),
      credentialMode: search.draft.credentialMode,
      description: spec.description,
      displayName: spec.displayName,
      draft: json(search.draft),
      draftTestEvidence: json(storedEvidence),
      enabled: false,
      id: routeIdentity.id,
      kind: spec.clientKind,
      modelId: plan.candidate.configuration.upstreamModelId,
      provider: spec.provider,
      providerModelId: plan.candidate.modelId,
      searchOptionId: option.id,
      strategyId: routeIdentity.strategyId,
      testedDraftHash: search.draftHash
    }
  });

  await tx.searchStrategy.update({
    data: {
      draft: json(search.draft),
      draftTestEvidence: json(storedEvidence),
      description: spec.description,
      displayName: spec.displayName,
      ...(current && !sameJson(current.draft, search.draft)
        ? { draftVersion: { increment: 1 } }
        : {}),
      enabled: true,
      searchOptionId: option.id,
      ...(stored.activeRevisionId
        ? {}
        : {
            adapterKind: search.draft.adapterKind,
            credentialMode: search.draft.credentialMode,
            kind: spec.clientKind,
            modelId: plan.candidate.configuration.upstreamModelId,
            provider: spec.provider,
            providerModelId: plan.candidate.modelId
          }),
      testedDraftHash: search.draftHash
    },
    where: { id: stored.id }
  });

  const directGrants = await tx.accessGrant.findMany({
    orderBy: { id: "asc" },
    where: {
      groupId: null,
      providerConnectionId: null,
      providerModelId: null,
      searchStrategy: spec.optionId,
      userId: plan.actor.userId
    }
  });
  if (directGrants[0]) {
    if (!directGrants[0].enabled) {
      await tx.accessGrant.update({
        data: { enabled: true },
        where: { id: directGrants[0].id }
      });
    }
  } else {
    await tx.accessGrant.create({
      data: {
        enabled: true,
        groupId: null,
        id: search.grantId,
        providerConnectionId: null,
        providerModelId: null,
        searchStrategy: spec.optionId,
        userId: plan.actor.userId
      }
    });
  }

  const existingRevision = await tx.searchIntegrationRevision.findUnique({
    where: {
      searchStrategyId_draftHash_validationFingerprint: {
        draftHash: search.draftHash,
        searchStrategyId: stored.id,
        validationFingerprint
      }
    }
  });
  const latestRevision = existingRevision
    ? null
    : await tx.searchIntegrationRevision.findFirst({
        orderBy: { revisionNumber: "desc" },
        where: { searchStrategyId: stored.id }
      });
  const revision = existingRevision ?? await tx.searchIntegrationRevision.create({
    data: {
      adapterKind: search.draft.adapterKind,
      configuration: json(search.draft),
      credentialMode: search.draft.credentialMode,
      draftHash: search.draftHash,
      id: search.revisionId,
      providerModelId: plan.candidate.modelId,
      revisionNumber: (latestRevision?.revisionNumber ?? 0) + 1,
      searchStrategyId: stored.id,
      validationEvidence: json(storedEvidence),
      validationFingerprint
    }
  });
  await tx.searchStrategy.update({
    data: {
      activatedAt: plan.now,
      activeRevisionId: revision.id,
      adapterKind: search.draft.adapterKind,
      config: json(search.draft),
      credentialMode: search.draft.credentialMode,
      enabled: true,
      kind: spec.clientKind,
      modelId: plan.candidate.configuration.upstreamModelId,
      provider: spec.provider,
      providerModelId: plan.candidate.modelId
    },
    where: { id: stored.id }
  });
  return "ready";
}

async function eligibleProviderModelIds(
  tx: Prisma.TransactionClient,
  userId: string,
  exposeFake: boolean
): Promise<Set<string>> {
  const [memberships, grants, models] = await Promise.all([
    tx.userGroup.findMany({
      include: { group: { select: { archivedAt: true, systemRole: true } } },
      where: { userId }
    }),
    tx.accessGrant.findMany({
      include: { providerModel: { select: { connectionId: true } } },
      where: {
        OR: [
          { userId },
          { group: { archivedAt: null, users: { some: { userId } } } }
        ]
      }
    }),
    tx.providerModel.findMany({
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
                activeVersion: { select: { id: true, revokedAt: true } },
                enabled: true,
                groupAssignments: { select: { credentialId: true, groupId: true } },
                id: true,
                userAssignments: {
                  select: { credentialId: true, userId: true },
                  where: { userId }
                }
              }
            }
          }
        }
      },
      where: { enabled: true, modelClass: "answer", connection: { enabled: true } }
    })
  ]);
  const activeMemberships = memberships.filter(
    (membership) => !membership.group.archivedAt
  );
  const groupIds = activeMemberships.map((membership) => membership.groupId);
  const fullAccess = activeMemberships.some(
    (membership) => membership.group.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
  );
  const entitlements = resolveEntitlements(userId, groupIds, grants.map((grant) => ({
    ...grant,
    providerModelConnectionId: grant.providerModel?.connectionId ?? null
  })), { fullAccess });
  const available = filterAvailableProviderModels({
    exposeFake,
    memberships,
    models: models as CatalogProviderModelRow[],
    userId
  });
  return new Set(filterExposedProviderModels({ entitlements, models: available }).map(({ id }) => id));
}

async function applyQuickSetupPlan(
  tx: Prisma.TransactionClient,
  plan: AdminProviderQuickSetupCommitPlan,
  exposeFake: boolean
): Promise<Exclude<AdminProviderQuickSetupCommitResult, "catalog_unavailable">> {
  await lockAdminProviderQuickSetupState(tx, plan);
  const current = await loadQuickSetupState(tx, {
    ...plan.actor,
    now: plan.now,
    provider: plan.provider
  });
  if (!current.inspection.authorized) return "advanced_required";
  if (current.inspection.mode === null || current.inspection.state === "advanced_required") {
    return "advanced_required";
  }
  if (current.inspection.fingerprint !== plan.expectedFingerprint) return "stale";
  const policy = adminProviderQuickSetupPolicy(plan.provider);
  const canonicalCandidates = plan.candidates.flatMap((planned) => {
    const canonical = policy.candidates.find(
      ({ candidateId }) => candidateId === planned.candidateId
    );
    return canonical && canonical.provider === planned.provider &&
      canonical.modelId === planned.modelId &&
      canonical.templateKey === planned.templateKey &&
      canonical.displayName === planned.displayName &&
      canonicalJson(canonical.configuration) === canonicalJson(planned.configuration)
      ? [canonical]
      : [];
  });
  const candidateModelIds = canonicalCandidates.map(({ modelId }) => modelId);
  const selectedCandidate = canonicalCandidates.find(
    ({ candidateId }) => candidateId === plan.candidate.candidateId
  );
  const grantIds = plan.grants.map(({ id }) => id);
  const grantModelIds = plan.grants.map(({ modelId }) => modelId);
  if (
    plan.candidates.length < 1 || plan.candidates.length > policy.candidates.length ||
    canonicalCandidates.length !== plan.candidates.length ||
    new Set(candidateModelIds).size !== candidateModelIds.length ||
    !selectedCandidate ||
    selectedCandidate.modelId !== plan.candidate.modelId ||
    plan.grants.length !== canonicalCandidates.length ||
    new Set(grantIds).size !== grantIds.length || grantIds.some((id) => !id) ||
    new Set(grantModelIds).size !== grantModelIds.length ||
    grantModelIds.some((modelId) => !candidateModelIds.includes(modelId))
  ) {
    return "stale";
  }
  if (
    current.inspection.mode !== plan.mode ||
    (current.inspection.quickSetupCredential === null) !== plan.credential.isNew ||
    (!plan.credential.isNew && (
      current.inspection.quickSetupCredential?.id !== plan.credential.id ||
      current.inspection.quickSetupCredential.draftVersion + 1 !== plan.credential.draftVersion
    )) ||
    (current.inspection.mode !== "initial" && current.inspection.model &&
      current.inspection.model?.templateKey !== selectedCandidate.templateKey)
  ) {
    return "stale";
  }
  if (plan.preservedModels.length > MAX_QUICK_SETUP_PRESERVED_MODELS ||
    new Set(plan.preservedModels.map(({ id }) => id)).size !== plan.preservedModels.length ||
    canonicalJson(plan.preservedModels) !== canonicalJson(current.inspection.preservedModels)) {
    return "stale";
  }

  const preservedTargets = new Map<string, Readonly<{
    configuration: ProviderModelConfiguration;
    modelVersion: number;
  }>>();
  for (const preserved of plan.preservedModels) {
    const model = current.connection?.models.find(({ id }) => id === preserved.id);
    if (!model || !model.enabled || model.activeVersion < 1 || !model.activatedAt ||
      model.activeConfig === null) {
      return "stale";
    }
    let configuration: ProviderModelConfiguration;
    try {
      configuration = normalizeProviderModelConfiguration(model.activeConfig);
    } catch {
      return "stale";
    }
    if (configuration.upstreamModelId !== preserved.upstreamModelId) return "stale";
    preservedTargets.set(model.id, {
      configuration,
      modelVersion: model.activeVersion
    });
  }

  const directGrants = await tx.accessGrant.findMany({
    where: {
      groupId: null,
      providerConnectionId: null,
      providerModelId: { in: candidateModelIds },
      searchStrategy: null,
      userId: plan.actor.userId
    }
  });
  const existingModels = new Map((await Promise.all(
    canonicalCandidates.map(async (candidate) => [
      candidate.modelId,
      await tx.providerModel.findUnique({ where: { id: candidate.modelId } })
    ] as const)
  )));
  for (const candidate of canonicalCandidates) {
    const existingModel = existingModels.get(candidate.modelId) ?? null;
    if (plan.mode === "replacement" && candidate.modelId === selectedCandidate.modelId &&
      !existingModel) {
      return "stale";
    }
    if (existingModel && (
      existingModel.connectionId !== policy.connection.id ||
      existingModel.provider !== policy.provider ||
      existingModel.templateKey !== candidate.templateKey ||
      (existingModel.activeConfig === null
        ? existingModel.draftVersion < 1 ||
          !canonicalModelConfig(existingModel.draftConfig, candidate.configuration)
        : existingModel.activeVersion < 1 ||
          !canonicalModelConfig(existingModel.activeConfig, candidate.configuration))
    )) {
      return "advanced_required";
    }
  }
  if (!current.connection) {
    await tx.providerConnection.create({
      data: {
        activeConfig: json(policy.connection.configuration),
        activeVersion: 1,
        activatedAt: plan.now,
        defaultCredentialId: null,
        displayName: policy.connection.displayName,
        draftConfig: json(policy.connection.configuration),
        draftVersion: 1,
        enabled: true,
        family: policy.provider,
        id: policy.connection.id,
        templateKey: policy.connection.templateKey,
        unassignedPolicy: "use_default"
      }
    });
  } else if (current.connection.activeConfig === null) {
    await tx.providerConnection.update({
      data: {
        activeConfig: json(policy.connection.configuration),
        activeVersion: current.connection.draftVersion,
        activatedAt: plan.now,
        enabled: true
      },
      where: { id: policy.connection.id }
    });
  } else if (!current.connection.enabled) {
    await tx.providerConnection.update({
      data: { enabled: true },
      where: { id: policy.connection.id }
    });
  }
  const connectionVersion = current.connection?.activeConfig === null
    ? current.connection.draftVersion
    : current.connection?.activeVersion ?? 1;

  const modelVersions = new Map<string, number>();
  for (const candidate of canonicalCandidates) {
    const existingModel = existingModels.get(candidate.modelId) ?? null;
    if (!existingModel) {
      await tx.providerModel.create({
        data: {
          activeConfig: json(candidate.configuration),
          activeVersion: 1,
          activatedAt: plan.now,
          connectionId: policy.connection.id,
          displayName: candidate.displayName,
          draftConfig: json(candidate.configuration),
          draftVersion: 1,
          enabled: true,
          id: candidate.modelId,
          inputTokenPriceMicros: candidate.model.inputTokenPriceMicros,
          outputTokenPriceMicros: candidate.model.outputTokenPriceMicros,
          provider: policy.provider,
          templateKey: candidate.templateKey,
          ...modelLegacyFields(candidate.configuration)
        }
      });
    } else if (existingModel.activeConfig === null) {
      await tx.providerModel.update({
        data: {
          activeConfig: json(candidate.configuration),
          activeVersion: existingModel.draftVersion,
          activatedAt: plan.now,
          enabled: true,
          ...modelLegacyFields(candidate.configuration)
        },
        where: { id: candidate.modelId }
      });
    } else if (!existingModel.enabled) {
      await tx.providerModel.update({
        data: { enabled: true },
        where: { id: candidate.modelId }
      });
    }
    modelVersions.set(
      candidate.modelId,
      existingModel?.activeConfig === null
        ? existingModel.draftVersion
        : existingModel?.activeVersion ?? 1
    );
  }

  if (plan.credential.isNew) {
    await tx.providerCredential.create({
      data: {
        connectionId: policy.connection.id,
        draftSecretEnvelope: null,
        draftVersion: plan.credential.draftVersion,
        enabled: true,
        id: plan.credential.id,
        label: quickSetupCredentialLabel(plan.credential.id)
      }
    });
  }
  await tx.providerCredentialVersion.create({
    data: {
      activatedAt: plan.now,
      credentialId: plan.credential.id,
      id: plan.credential.versionId,
      secretEnvelope: plan.credential.versionEnvelope,
      testEvidence: json({
        method: "models_catalog",
        policyVersion: policy.version,
        version: 1
      }),
      testedAt: plan.checkedAt,
      version: plan.credential.draftVersion
    }
  });
  await tx.providerCredential.update({
    data: {
      activatedAt: plan.now,
      activeVersionId: plan.credential.versionId,
      draftSecretEnvelope: null,
      draftVersion: plan.credential.draftVersion,
      enabled: true,
      testedAt: plan.checkedAt
    },
    where: { id: plan.credential.id }
  });
  await tx.providerUserCredentialAssignment.upsert({
    create: {
      connectionId: policy.connection.id,
      credentialId: plan.credential.id,
      userId: plan.actor.userId
    },
    update: { credentialId: plan.credential.id },
    where: {
      connectionId_userId: {
        connectionId: policy.connection.id,
        userId: plan.actor.userId
      }
    }
  });
  for (const candidate of canonicalCandidates) {
    preservedTargets.set(candidate.modelId, {
      configuration: candidate.configuration,
      modelVersion: modelVersions.get(candidate.modelId) ?? 1
    });
  }
  for (const [providerModelId, target] of [...preservedTargets.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    await tx.providerModelCredentialCheck.create({
      data: {
        checkedAt: plan.checkedAt,
        connectionId: policy.connection.id,
        connectionVersion,
        credentialId: plan.credential.id,
        credentialVersionId: plan.credential.versionId,
        evidence: json({
          detail: "ok",
          method: "models_catalog",
          selectedProviders: target.configuration.openRouterRouting?.providers ?? [],
          upstreamModelId: target.configuration.upstreamModelId
        }),
        modelVersion: target.modelVersion,
        providerModelId,
        status: "available"
      }
    });
  }

  const grantIdByModelId = new Map(plan.grants.map(({ id, modelId }) => [modelId, id]));
  for (const candidate of canonicalCandidates) {
    const candidateGrants = directGrants.filter(
      ({ providerModelId }) => providerModelId === candidate.modelId
    );
    const enabledDirectGrant = candidateGrants.find((grant) => grant.enabled);
    if (!enabledDirectGrant && candidateGrants[0]) {
      await tx.accessGrant.update({
        data: { enabled: true },
        where: { id: candidateGrants[0].id }
      });
    } else if (!enabledDirectGrant) {
      await tx.accessGrant.create({
        data: {
          enabled: true,
          groupId: null,
          id: grantIdByModelId.get(candidate.modelId)!,
          providerConnectionId: null,
          providerModelId: candidate.modelId,
          searchStrategy: null,
          userId: plan.actor.userId
        }
      });
    }
  }

  const search = await synchronizeQuickSetupSearch(tx, plan);

  const eligibleModelIds = await eligibleProviderModelIds(tx, plan.actor.userId, exposeFake);
  if ([...candidateModelIds, ...plan.preservedModels.map(({ id }) => id)].every(
    (modelId) => eligibleModelIds.has(modelId)
  ) === false) {
    throw new QuickSetupCatalogUnavailableError();
  }
  return {
    defaultChanged: false,
    ...(plan.search ? { search } : {}),
    status: "ready"
  };
}

async function applyQuickSetupClearPlan(
  tx: Prisma.TransactionClient,
  plan: AdminProviderQuickSetupClearPlan
) {
  await lockAdminProviderQuickSetupState(tx, plan);
  const current = await loadQuickSetupState(tx, {
    ...plan.actor,
    now: plan.now,
    provider: plan.provider
  });
  if (!current.inspection.authorized) return "advanced_required" as const;
  if (current.inspection.fingerprint !== plan.expectedFingerprint ||
    !current.inspection.quickSetupAssignment) {
    return "stale" as const;
  }
  const deleted = await tx.providerUserCredentialAssignment.deleteMany({
    where: {
      connectionId: adminProviderQuickSetupPolicy(plan.provider).connection.id,
      credentialId: current.inspection.quickSetupAssignment.credentialId,
      userId: plan.actor.userId
    }
  });
  return deleted.count === 1
    ? { status: "cleared" as const }
    : "stale" as const;
}

export function createPrismaAdminProviderQuickSetupRepository(
  prisma: PrismaClient,
  options: QuickSetupRepositoryOptions = {}
): AdminProviderQuickSetupRepository {
  const exposeFake = options.exposeFake ?? false;
  return {
    async clearAssignment(plan) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await prisma.$transaction(
            (tx) => applyQuickSetupClearPlan(tx, plan),
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10_000,
              timeout: 30_000
            }
          );
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            (error.code === "P2002" || error.code === "P2025" ||
              isSerializationConflict(error))
          ) {
            if (isSerializationConflict(error) && attempt < 2) continue;
            return "stale";
          }
          throw error;
        }
      }
      return "stale";
    },

    async inspect(input) {
      return (await loadQuickSetupState(prisma as unknown as QuickSetupDb, input)).inspection;
    },

    async listConfiguredConnections(input) {
      const [actor, session] = await Promise.all([
        prisma.user.findUnique({
          select: { role: true, status: true },
          where: { id: input.userId }
        }),
        prisma.authSession.findUnique({
          select: { expiresAt: true, revokedAt: true, userId: true },
          where: { id: input.sessionId }
        })
      ]);
      if (actor?.role !== "admin" || actor.status !== "active" ||
        !session || session.userId !== input.userId || session.revokedAt ||
        session.expiresAt <= input.now) {
        return [];
      }
      const connections = await prisma.providerConnection.findMany({
        orderBy: [{ displayName: "asc" }, { id: "asc" }],
        select: {
          displayName: true,
          enabled: true,
          family: true,
          id: true,
          models: {
            select: { id: true },
            where: {
              activeConfig: { not: Prisma.DbNull },
              activeVersion: { gt: 0 },
              activatedAt: { not: null },
              enabled: true
            }
          }
        },
        where: {
          activeConfig: { not: Prisma.DbNull },
          activeVersion: { gt: 0 },
          activatedAt: { not: null },
          family: { not: "fake" }
        }
      });
      return connections.map((connection) => ({
        activeModelCount: connection.models.length,
        displayName: connection.displayName,
        enabled: connection.enabled,
        family: connection.family,
        id: connection.id
      }));
    },

    async commit(plan) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await prisma.$transaction(
            (tx) => applyQuickSetupPlan(tx, plan, exposeFake),
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10_000,
              timeout: 30_000
            }
          );
        } catch (error) {
          if (error instanceof QuickSetupCatalogUnavailableError) {
            return "catalog_unavailable";
          }
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            (error.code === "P2002" || error.code === "P2025" ||
              isSerializationConflict(error))
          ) {
            if (isSerializationConflict(error) && attempt < 2) continue;
            return "stale";
          }
          throw error;
        }
      }
      return "stale";
    }
  };
}
