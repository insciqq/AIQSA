import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { RunProfileId } from "../../../contracts/runProfiles";
import { defaultProviderModels } from "../../../domain/catalog";
import {
  providerModelTemplateId,
  type ProviderModelTemplateKey
} from "../../../domain/providerTemplates";
import {
  DEFAULT_RUN_PROFILE_CONFIGURATIONS,
  isRunProfileId
} from "../../../domain/runProfiles";
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
  | "runProfile"
  | "user"
  | "userGroup"
  | "userSettings"
>;

type QuickSetupRepositoryOptions = Readonly<{
  exposeFake?: boolean;
}>;

class QuickSetupCatalogUnavailableError extends Error {}

const MAX_QUICK_SETUP_PRESERVED_MODELS = 64;

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

type QuickSetupProfileFill = Readonly<{
  id: RunProfileId;
  reasoningEffort: string;
  reasoningMode: string;
}>;

export function planAdminProviderQuickSetupProfileFills(input: Readonly<{
  mode: "initial" | "recovery" | "replacement";
  profiles: ReadonlyArray<Readonly<{
    enabled: boolean;
    id: string;
    providerModelId: string | null;
    updatedByUserId: string | null;
    version: number;
  }>>;
  templateKey: ProviderModelTemplateKey;
}>): QuickSetupProfileFill[] {
  if (input.mode !== "initial") return [];
  return input.profiles.flatMap((profile) => {
    if (!isRunProfileId(profile.id)) return [];
    const recipe = DEFAULT_RUN_PROFILE_CONFIGURATIONS.find(
      (candidate) => candidate.id === profile.id &&
        candidate.targetTemplateKey === input.templateKey
    );
    if (!recipe || profile.enabled || profile.providerModelId !== null ||
      profile.version !== 1 || profile.updatedByUserId !== null) {
      return [];
    }
    return [{
      id: profile.id,
      reasoningEffort: recipe.reasoningEffort,
      reasoningMode: recipe.reasoningMode
    }];
  });
}

async function loadQuickSetupState(
  db: QuickSetupDb,
  input: AdminProviderQuickSetupActor & Readonly<{
    now: Date;
    provider: "anthropic" | "gemini" | "openai" | "openrouter";
  }>
) {
  const policy = adminProviderQuickSetupPolicy(input.provider);
  const [actor, session, settings, profiles, connections, grants, memberships] = await Promise.all([
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
    db.runProfile.findMany({ orderBy: { id: "asc" } }),
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
    profiles: mode === "initial"
      ? profiles.map((profile) => ({
          description: profile.description,
          enabled: profile.enabled,
          id: profile.id,
          providerModelId: profile.providerModelId,
          reasoningEffort: profile.reasoningEffort,
          reasoningMode: profile.reasoningMode,
          updatedAt: profile.updatedAt,
          updatedByUserId: profile.updatedByUserId,
          version: profile.version
        }))
      : [],
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
    version: 3
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
  return { connection, inspection, profiles, settings };
}

export async function lockAdminProviderQuickSetupState(
  tx: Prisma.TransactionClient,
  plan: AdminProviderQuickSetupCommitPlan | AdminProviderQuickSetupClearPlan
): Promise<void> {
  const policy = adminProviderQuickSetupPolicy(plan.provider);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${plan.actor.userId} FOR UPDATE
  `);
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
    ORDER BY grant_row."id" FOR UPDATE OF grant_row
  `);
  if ("mode" in plan && plan.mode === "initial") {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "RunProfile"
      ORDER BY CASE "id"
        WHEN 'fast' THEN 1
        WHEN 'balanced' THEN 2
        WHEN 'deep' THEN 3
        ELSE 4
      END
      FOR UPDATE
    `);
  }
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
      where: { enabled: true, connection: { enabled: true } }
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

  const eligibleModelIds = await eligibleProviderModelIds(tx, plan.actor.userId, exposeFake);
  if ([...candidateModelIds, ...plan.preservedModels.map(({ id }) => id)].every(
    (modelId) => eligibleModelIds.has(modelId)
  ) === false) {
    throw new QuickSetupCatalogUnavailableError();
  }
  const priorDefault = current.settings?.defaultProviderModelId ?? null;
  const priorDefaultUsable = Boolean(priorDefault && eligibleModelIds.has(priorDefault));
  const defaultChanged = plan.mode !== "replacement" &&
    !priorDefaultUsable && priorDefault !== selectedCandidate.modelId;
  if (plan.mode !== "replacement" && !priorDefaultUsable) {
    await tx.userSettings.update({
      data: { defaultProviderModelId: selectedCandidate.modelId },
      where: { userId: plan.actor.userId }
    });
  }

  const profileFills = planAdminProviderQuickSetupProfileFills({
    mode: plan.mode,
    profiles: current.profiles,
    templateKey: selectedCandidate.templateKey
  });
  const profilesFilled = [] as RunProfileId[];
  for (const profile of profileFills) {
    await tx.runProfile.update({
      data: {
        enabled: true,
        providerModelId: selectedCandidate.modelId,
        reasoningEffort: profile.reasoningEffort,
        reasoningMode: profile.reasoningMode,
        updatedByUserId: plan.actor.userId,
        version: { increment: 1 }
      },
      where: { id: profile.id }
    });
    profilesFilled.push(profile.id);
  }
  return { defaultChanged, profilesFilled, status: "ready" };
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
          activatedAt: { not: null }
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
