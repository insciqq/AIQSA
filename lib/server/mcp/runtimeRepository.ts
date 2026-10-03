import { reportSubsystemFailure, reportSubsystemHealthy } from "../observability";
import { databaseFailureCode, retainDatabaseFailure } from "../observability/databaseFailure";
import { observedFailureCode } from "../providers/providerObservability";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  mcpHeaderValue,
  type McpCredentialSource,
  type McpDraftConfiguration,
  type McpSlotValue
} from "@/lib/contracts/mcp";
import { prisma } from "@/lib/server/prisma";
import {
  mcpRuntimeFingerprint,
  mcpSharedRuntimeFingerprint,
  resolveEffectiveMcpGrant,
  resolveEffectiveMcpValues,
  type EffectiveMcpSlotPlanItem
} from "./access";
import {
  mcpEndpointBinding,
  mcpPublishedToolDefinitions,
  mcpValuesForEndpoint,
  parseMcpEndpointBindings,
  validateMcpDraft,
  validateMcpSlotValue,
  type McpEndpointBinding,
  type McpPublishedToolDefinitions
} from "./definitions";
import {
  decryptMcpEnvelope,
  encryptMcpEnvelope,
  getMcpEncryptionKey,
  mcpPersonalConfigEnvelopeContext,
  mcpRuntimeGenerationEnvelopeContext,
  mcpSharedConfigEnvelopeContext,
  type McpEnvelopeContext
} from "./encryption";
import { buildMcpOAuthPolicy, mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import type {
  McpRuntimeCoordinatorRepository,
  McpRuntimeGenerationLaunch,
  McpRuntimeLaunch
} from "./runtimeCoordinator";

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"] as const;
const RECENT_ACTIVITY_MS = 15 * 60_000;
const DRAIN_GRACE_MS = 60_000;
const INVENTORY_FRESH_MS = 5 * 60_000;

function runtimeConfigurationError(code: "mcp_values_invalid" | "mcp_runtime_fingerprint_collision"): Error {
  return Object.assign(new Error(code), { code });
}

type StoredValues = {
  values: Record<string, McpSlotValue>;
  version: 1;
};

type StoredEffectiveSnapshot = StoredValues & {
  plan: EffectiveMcpSlotPlanItem[];
  /** Frozen ownership boundary for personal remote runtimes. */
  personalRuntime?: boolean;
};

function isSlotValue(value: unknown): value is McpSlotValue {
  return typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

// Launch uses only values entered for the active revision's origin. Unbound
// legacy values belong to it: publication to another origin pins them first.
function storedValues(
  envelope: string | null,
  key: Buffer,
  endpoint: McpEndpointBinding,
  context?: McpEnvelopeContext
): StoredValues {
  if (!envelope) return { values: {}, version: 1 };
  if (!context) throw runtimeConfigurationError("mcp_values_invalid");
  const decoded = decryptMcpEnvelope<unknown>(envelope, key, context);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) ||
    !("version" in decoded) || decoded.version !== 1 || !("values" in decoded) ||
    !decoded.values || typeof decoded.values !== "object" || Array.isArray(decoded.values)) {
    throw runtimeConfigurationError("mcp_values_invalid");
  }
  const bindings = parseMcpEndpointBindings("endpoints" in decoded ? decoded.endpoints : undefined);
  if (!bindings) throw runtimeConfigurationError("mcp_values_invalid");
  const values: Record<string, McpSlotValue> = {};
  for (const [slotKey, value] of Object.entries(decoded.values)) {
    if (!isSlotValue(value)) throw runtimeConfigurationError("mcp_values_invalid");
    values[slotKey] = value;
  }
  return {
    values: mcpValuesForEndpoint({ bindings, implicit: endpoint, target: endpoint, values }),
    version: 1
  };
}

function storedEffectiveSnapshot(
  envelope: string | null,
  key: Buffer,
  context: McpEnvelopeContext
): StoredEffectiveSnapshot {
  if (!envelope) throw runtimeConfigurationError("mcp_values_invalid");
  const decoded = decryptMcpEnvelope<unknown>(envelope, key, context);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) ||
    !("version" in decoded) || decoded.version !== 1 || !("values" in decoded) ||
    !decoded.values || typeof decoded.values !== "object" || Array.isArray(decoded.values) ||
    !("plan" in decoded) || !Array.isArray(decoded.plan)) {
    throw runtimeConfigurationError("mcp_values_invalid");
  }
  const values: Record<string, McpSlotValue> = {};
  for (const [slotKey, value] of Object.entries(decoded.values)) {
    if (!isSlotValue(value)) throw runtimeConfigurationError("mcp_values_invalid");
    values[slotKey] = value;
  }
  const slotKeys = new Set<string>();
  const plan: EffectiveMcpSlotPlanItem[] = [];
  for (const item of decoded.plan) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      !("authorized" in item) || typeof item.authorized !== "boolean" ||
      !("slotKey" in item) || typeof item.slotKey !== "string" || !item.slotKey ||
      !("source" in item) || !["literal", "missing", "personal", "shared"].includes(String(item.source)) ||
      !("valueVersion" in item) || !(item.valueVersion === null ||
        (typeof item.valueVersion === "number" && Number.isInteger(item.valueVersion) &&
          item.valueVersion >= 0)) || slotKeys.has(item.slotKey)) {
      throw runtimeConfigurationError("mcp_values_invalid");
    }
    slotKeys.add(item.slotKey);
    plan.push({
      authorized: item.authorized,
      slotKey: item.slotKey,
      source: item.source as EffectiveMcpSlotPlanItem["source"],
      valueVersion: item.valueVersion
    });
  }
  let personalRuntime: boolean | undefined;
  if ("personalRuntime" in decoded) {
    if (typeof decoded.personalRuntime !== "boolean") {
      throw runtimeConfigurationError("mcp_values_invalid");
    }
    personalRuntime = decoded.personalRuntime;
  }
  return {
    plan,
    values,
    version: 1,
    ...(personalRuntime !== undefined ? { personalRuntime } : {})
  };
}

function revisionConfiguration(value: Prisma.JsonValue): McpDraftConfiguration | null {
  const validated = validateMcpDraft(value);
  return validated.ok ? validated.value : null;
}

/** The stored value as entered; the secret a runtime redacts, whatever header form it is sent in. */
function storedSlotText(value: McpSlotValue): string {
  return (typeof value === "string" ? value : String(value)).trim();
}

type DesiredRecord = Prisma.McpUserServerGetPayload<{
  include: {
    server: {
      include: {
        activeRevision: true;
        grants: true;
        oauthConnections: { include: { oauthClient: { select: { clientId: true } } } };
      };
    };
    user: { select: { groups: { select: { groupId: true } }; id: true } };
  };
}>;

/** A server as its installation-owned Project runtime sees it: no member row. */
type SharedRuntimeServerRecord = Prisma.McpServerGetPayload<{ include: { activeRevision: true } }>;

type RemoteRuntimeFields = {
  allowPrivateNetwork: boolean;
  callTimeoutMs: number;
  effectiveEnvelope: {
    plan: ReturnType<typeof resolveEffectiveMcpValues>["plan"];
    personalRuntime?: boolean;
    values: Record<string, McpSlotValue>;
    version: 1;
  };
  credentialSources: readonly McpCredentialSource[];
  disabledToolNames?: readonly string[];
  externalAccountLabel: string | null;
  fingerprint: string;
  headers: Record<string, string>;
  oauthConnectionId?: string;
  personalRuntime?: boolean;
  publishedTools: McpPublishedToolDefinitions;
  revisionId: string;
  redactionValues: readonly string[];
  startupTimeoutMs: number;
  url: string;
};

type UserRuntimeOwner = { userId: string; userServerId: string };

export type RemoteRuntimeCandidate = RemoteRuntimeFields & UserRuntimeOwner;

/** The Project runtime of a server: shared or no-auth values only, never a member. */
export type SharedRuntimeCandidate = RemoteRuntimeFields & { serverId: string };

type EffectiveRuntimeBase = Readonly<{
  configuration: McpDraftConfiguration;
  credentialSources: readonly McpCredentialSource[];
  effectiveEnvelope: RemoteRuntimeFields["effectiveEnvelope"];
  fingerprint: string;
  externalAccountLabel: string | null;
  oauthConnectionId: string | null;
  personalRuntime?: boolean;
  revision: NonNullable<DesiredRecord["server"]["activeRevision"]>;
}>;

type EffectiveRuntimeCandidate = EffectiveRuntimeBase & Readonly<UserRuntimeOwner>;

function safeCredentialSources(
  configuration: McpDraftConfiguration,
  plan: readonly EffectiveMcpSlotPlanItem[],
  oauth: boolean
): readonly McpCredentialSource[] {
  const sensitiveKeys = new Set(configuration.slots
    .filter((slot) => slot.sensitive)
    .map((slot) => slot.slotKey));
  const sources = new Set<McpCredentialSource>();
  if (oauth) sources.add("oauth");
  for (const item of plan) {
    if (!item.authorized || !sensitiveKeys.has(item.slotKey)) continue;
    if (item.source === "personal") sources.add("personal");
    if (item.source === "literal" || item.source === "shared") sources.add("shared");
  }
  return [...sources].sort();
}

function effectiveRedactionValues(
  configuration: McpDraftConfiguration,
  values: Readonly<Record<string, McpSlotValue>>
): readonly string[] {
  return [...new Set(configuration.slots.flatMap((slot) => {
    if (!slot.sensitive || !Object.hasOwn(values, slot.slotKey)) return [];
    // A bare Authorization token is sent with a scheme; redacting the stored
    // text covers both forms.
    const value = storedSlotText(values[slot.slotKey]!);
    return value ? [value] : [];
  }))];
}

function effectiveRuntimeCandidate(input: {
  key: Buffer;
  oauthRedirectUri?: (serverId: string) => string;
  record: DesiredRecord;
}): EffectiveRuntimeCandidate | null {
  if (!input.record.enabled || !input.record.server.enabled || input.record.server.archivedAt) return null;
  // A personal server is usable only by its exact owner. Grants are
  // installation-owned access rows and must never make another user eligible
  // for a personal endpoint, even if a malformed row grants it.
  if (input.record.server.ownerUserId != null &&
    input.record.server.ownerUserId !== input.record.userId) return null;
  const revision = input.record.server.activeRevision;
  if (!revision) return null;
  const configuration = revisionConfiguration(revision.configuration);
  if (!configuration) return null;
  const groupIds = input.record.user.groups.map((membership) => membership.groupId);
  const direct = input.record.server.grants.find((grant) => grant.userId === input.record.userId) ?? null;
  const groups = input.record.server.grants.filter((grant) => grant.groupId && groupIds.includes(grant.groupId));
  const access = resolveEffectiveMcpGrant({ direct, groups });
  if (!access.canUse) return null;
  const endpoint = mcpEndpointBinding(configuration);
  const shared = storedValues(
    input.record.server.sharedConfigEnvelope,
    input.key,
    endpoint,
    input.record.server.sharedConfigEnvelope
      ? mcpSharedConfigEnvelopeContext(
          input.record.server.id,
          input.record.server.sharedConfigVersion
        )
      : undefined
  );
  const personal = storedValues(
    input.record.personalConfigEnvelope,
    input.key,
    endpoint,
    input.record.personalConfigEnvelope
      ? mcpPersonalConfigEnvelopeContext(input.record.id, input.record.personalConfigVersion)
      : undefined
  );
  const effective = resolveEffectiveMcpValues({
    personalSlotKeys: access.personalSlotKeys,
    personalValues: personal.values,
    personalVersion: input.record.personalConfigVersion,
    sharedValues: shared.values,
    sharedVersion: input.record.server.sharedConfigVersion,
    slots: configuration.slots
  });
  if (effective.invalidSlotKeys.length || effective.missingSlotKeys.length) return null;
  // A personal runtime keeps the full upstream inventory; the owner's
  // switched-off tools are filtered from projections, never from the runtime.
  const personalRuntime = input.record.server.ownerUserId === input.record.userId;
  let oauthConnectionId: string | null = null;
  let externalAccountLabel: string | null = null;
  if (configuration.auth.mode === "oauth") {
    if (!input.oauthRedirectUri) return null;
    let policy;
    try {
      policy = buildMcpOAuthPolicy({
        configurationIdentity: revision.id,
        draft: configuration,
        purpose: "user",
        redirectUri: input.oauthRedirectUri(input.record.serverId),
        serverId: input.record.serverId,
        userId: input.record.userId
      });
      reportSubsystemHealthy("mcp", "preflight", input.record.id);
    } catch (error) {
      reportSubsystemFailure({ subsystem: "mcp", stage: "preflight", scope_id: input.record.id,
        code: observedFailureCode(error), action: "skip" });
      return null;
    }
    const connection = input.record.server.oauthConnections.find((candidate) =>
      candidate.userId === input.record.userId && candidate.purpose === "user" &&
      candidate.state === "ready" && candidate.tokenEnvelope && candidate.oauthClient &&
      candidate.policyFingerprint === mcpOAuthPolicyFingerprint(policy, candidate.oauthClient.clientId)
    );
    if (!connection) return null;
    oauthConnectionId = connection.id;
    externalAccountLabel = connection.externalAccountLabel;
  }
  const fingerprint = mcpRuntimeFingerprint({
    oauthConnectionRevision: oauthConnectionId,
    plan: effective.plan,
    revisionId: revision.id,
    userId: input.record.userId
  });
  return {
    configuration,
    credentialSources: safeCredentialSources(configuration, effective.plan, Boolean(oauthConnectionId)),
    effectiveEnvelope: {
      plan: effective.plan,
      values: effective.values,
      version: 1,
      ...(personalRuntime ? { personalRuntime: true } : {})
    },
    externalAccountLabel,
    fingerprint,
    oauthConnectionId,
    ...(personalRuntime ? { personalRuntime: true } : {}),
    revision,
    userId: input.record.userId,
    userServerId: input.record.id
  };
}

function remoteRuntimeFields(base: EffectiveRuntimeBase): RemoteRuntimeFields {
  const { configuration } = base;
  const source = configuration.source;
  const headers: Record<string, string> = {};
  for (const slot of configuration.slots) {
    if (slot.target.kind === "header" && Object.hasOwn(base.effectiveEnvelope.values, slot.slotKey)) {
      headers[slot.target.name] = mcpHeaderValue(slot.target.name, base.effectiveEnvelope.values[slot.slotKey]!);
    }
  }
  return {
    allowPrivateNetwork: source.allowPrivateNetwork === true,
    callTimeoutMs: configuration.runtime.callTimeoutMs,
    credentialSources: base.credentialSources,
    ...(configuration.disabledToolNames?.length
      ? { disabledToolNames: configuration.disabledToolNames }
      : {}),
    effectiveEnvelope: base.effectiveEnvelope,
    externalAccountLabel: base.externalAccountLabel,
    fingerprint: base.fingerprint,
    headers,
    ...(base.oauthConnectionId ? { oauthConnectionId: base.oauthConnectionId } : {}),
    ...(base.personalRuntime ? { personalRuntime: true } : {}),
    publishedTools: mcpPublishedToolDefinitions(base.revision.validationEvidence),
    redactionValues: effectiveRedactionValues(configuration, base.effectiveEnvelope.values),
    revisionId: base.revision.id,
    startupTimeoutMs: configuration.runtime.startupTimeoutMs,
    url: source.url
  };
}

export function remoteRuntimeCandidate(input: {
  key: Buffer;
  oauthRedirectUri?: (serverId: string) => string;
  record: DesiredRecord;
}): RemoteRuntimeCandidate | null {
  const base = effectiveRuntimeCandidate(input);
  return base ? { ...remoteRuntimeFields(base), userId: base.userId, userServerId: base.userServerId } : null;
}

/**
 * The installation-owned runtime Project runs use. It is derived from the
 * server alone: shared or literal values, no grant, preference, personal value
 * or OAuth identity, so it is one runtime for every member. Project authority
 * requires a shared value or no authentication, exactly as Project admission.
 */
export function sharedRuntimeCandidate(input: {
  key: Buffer;
  server: SharedRuntimeServerRecord;
}): SharedRuntimeCandidate | null {
  const { server } = input;
  // Only an explicit owner marks a server as personal.
  if (!server.enabled || server.archivedAt || server.ownerUserId != null) return null;
  const revision = server.activeRevision;
  if (!revision) return null;
  const configuration = revisionConfiguration(revision.configuration);
  if (!configuration || configuration.auth.mode === "oauth" ||
    (!server.sharedConfigEnvelope && configuration.auth.mode !== "none")) return null;
  const shared = storedValues(
    server.sharedConfigEnvelope,
    input.key,
    mcpEndpointBinding(configuration),
    server.sharedConfigEnvelope
      ? mcpSharedConfigEnvelopeContext(server.id, server.sharedConfigVersion)
      : undefined
  );
  const effective = resolveEffectiveMcpValues({
    personalSlotKeys: new Set(),
    personalValues: {},
    personalVersion: 0,
    sharedValues: shared.values,
    sharedVersion: server.sharedConfigVersion,
    slots: configuration.slots
  });
  if (effective.invalidSlotKeys.length || effective.missingSlotKeys.length) return null;
  const base: EffectiveRuntimeBase = {
    configuration,
    credentialSources: safeCredentialSources(configuration, effective.plan, false),
    effectiveEnvelope: { plan: effective.plan, values: effective.values, version: 1 },
    externalAccountLabel: null,
    fingerprint: mcpSharedRuntimeFingerprint({ plan: effective.plan, revisionId: revision.id }),
    oauthConnectionId: null,
    revision
  };
  return { ...remoteRuntimeFields(base), serverId: server.id };
}

function generationLaunch(
  candidate: RemoteRuntimeFields,
  generation: Readonly<{ id: string; inventoryUpdatedAt: Date | null; retryAt: Date | null }>,
  now: Date
): McpRuntimeGenerationLaunch {
  return {
    callTimeoutMs: candidate.callTimeoutMs,
    ...(candidate.disabledToolNames?.length
      ? { disabledToolNames: candidate.disabledToolNames }
      : {}),
    fingerprint: candidate.fingerprint,
    generationId: generation.id,
    headers: candidate.headers,
    inventoryRefreshRequired: !generation.inventoryUpdatedAt ||
      now.getTime() - generation.inventoryUpdatedAt.getTime() >= INVENTORY_FRESH_MS,
    publishedTools: candidate.publishedTools,
    redactionValues: candidate.redactionValues,
    retryAt: generation.retryAt,
    startupTimeoutMs: candidate.startupTimeoutMs,
    allowPrivateNetwork: candidate.allowPrivateNetwork,
    ...(candidate.oauthConnectionId
      ? { oauthConnectionId: candidate.oauthConnectionId }
      : {}),
    ...(candidate.personalRuntime ? { personalRuntime: true } : {}),
    url: candidate.url
  };
}

function sameCredentialSources(stored: readonly string[], candidate: readonly McpCredentialSource[]): boolean {
  return stored.length === candidate.length &&
    stored.every((source) => candidate.includes(source as McpCredentialSource));
}

export function createPrismaMcpRuntimeRepository(input: {
  encryptionKey?: () => Buffer;
  generationId?: () => string;
  oauthRedirectUri?: (serverId: string) => string;
  prisma?: PrismaClient;
  reconcileOAuthConnections?: () => Promise<void>;
} = {}): McpRuntimeCoordinatorRepository {
  const client = input.prisma ?? prisma;
  const encryptionKey = input.encryptionKey ?? getMcpEncryptionKey;
  const generationId = input.generationId ?? randomUUID;

  return {
    loadAcceptedGeneration: async (generationId, now) => {
      const generation = await client.mcpRuntimeGeneration.findFirst({
        include: {
          revision: {
            select: { configuration: true, id: true, serverId: true, validationEvidence: true }
          },
          userServer: {
            select: { serverId: true, userId: true }
          }
        },
        where: {
          id: generationId,
          runBindings: {
            some: { modelRun: { status: { in: [...ACTIVE_RUN_STATUSES] } } }
          }
        }
      }).catch(retainDatabaseFailure);
      if (!generation) return null;
      // A member's generation or the server's shared Project generation; the
      // latter proves its identity without any user.
      const owner = generation.userServer
        ? { serverId: generation.userServer.serverId, userId: generation.userServer.userId }
        : generation.sharedServerId !== null
          ? { serverId: generation.sharedServerId, userId: null }
          : null;
      if (!owner || generation.revision.serverId !== owner.serverId) return null;
      const configuration = revisionConfiguration(generation.revision.configuration);
      if (!configuration || (configuration.auth.mode === "oauth") !== Boolean(generation.oauthConnectionId)) {
        return null;
      }
      try {
        const snapshot = storedEffectiveSnapshot(
          generation.effectiveConfigEnvelope,
          encryptionKey(),
          mcpRuntimeGenerationEnvelopeContext(generation.id, generation.fingerprint)
        );
        if (owner.userId === null && snapshot.personalRuntime) return null;
        const configuredSlotKeys = new Set(configuration.slots.map((slot) => slot.slotKey));
        if (snapshot.plan.length !== configuration.slots.length ||
          Object.keys(snapshot.values).length !== configuration.slots.length ||
          snapshot.plan.some((item) => !configuredSlotKeys.has(item.slotKey)) ||
          configuration.slots.some((slot) => !Object.hasOwn(snapshot.values, slot.slotKey) ||
            !validateMcpSlotValue(slot, snapshot.values[slot.slotKey]))) return null;
        const fingerprint = owner.userId === null
          ? snapshot.plan.some((item) => item.source === "personal")
            ? null
            : mcpSharedRuntimeFingerprint({ plan: snapshot.plan, revisionId: generation.revision.id })
          : mcpRuntimeFingerprint({
              oauthConnectionRevision: generation.oauthConnectionId,
              plan: snapshot.plan,
              revisionId: generation.revision.id,
              userId: owner.userId
            });
        if (fingerprint !== generation.fingerprint) return null;
        const commonLaunch = {
          callTimeoutMs: configuration.runtime.callTimeoutMs,
          ...(configuration.disabledToolNames?.length
            ? { disabledToolNames: configuration.disabledToolNames }
            : {}),
          fingerprint: generation.fingerprint,
          generationId: generation.id,
          headers: {},
          inventoryRefreshRequired: !generation.inventoryUpdatedAt ||
            now.getTime() - generation.inventoryUpdatedAt.getTime() >= INVENTORY_FRESH_MS,
          // The accepted revision, not the active one, bounds what this generation offers.
          publishedTools: mcpPublishedToolDefinitions(generation.revision.validationEvidence),
          ...(snapshot.personalRuntime ? { personalRuntime: true } : {}),
          redactionValues: effectiveRedactionValues(configuration, snapshot.values),
          retryAt: generation.retryAt,
          startupTimeoutMs: configuration.runtime.startupTimeoutMs
        };
        const headers: Record<string, string> = {};
        for (const slot of configuration.slots) {
          if (slot.target.kind === "header") {
            headers[slot.target.name] = mcpHeaderValue(slot.target.name, snapshot.values[slot.slotKey]!);
          }
        }
        reportSubsystemHealthy("mcp", "recovery", generation.id);
        return {
          ...commonLaunch,
          allowPrivateNetwork: configuration.source.allowPrivateNetwork === true,
          headers,
          ...(generation.oauthConnectionId
            ? { oauthConnectionId: generation.oauthConnectionId }
            : {}),
          url: configuration.source.url
        };
      } catch (error) {
        reportSubsystemFailure({ subsystem: "mcp", stage: "recovery", scope_id: generation.id,
          code: observedFailureCode(error), prisma_code: databaseFailureCode(error), action: "wait" });
        return null;
      }
    },

    synchronizeDesired: async ({ now, onDemand = false, serverIds, userId }) => {
      if (input.reconcileOAuthConnections) {
        try {
          await input.reconcileOAuthConnections();
          reportSubsystemHealthy("mcp", "reconcile", "oauth_reconcile");
        } catch (error) {
          reportSubsystemFailure({ subsystem: "mcp", stage: "reconcile", scope_id: "oauth_reconcile",
            code: observedFailureCode(error), prisma_code: databaseFailureCode(error), action: "retry" });
        }
      }
      const recentActivityCutoff = new Date(now.getTime() - RECENT_ACTIVITY_MS);
      if (!userId) {
        // Eviction is observed runtime state, not a user preference mutation.
        // Keep McpUserServer.updatedAt as the enable/config-change timestamp;
        // an enabled server remains available for a later on-demand start.
        await client.$executeRaw`
          UPDATE "McpUserServer" AS preference
          SET "desiredRuntimeGenerationId" = NULL
          WHERE preference."desiredRuntimeGenerationId" IS NOT NULL
            AND preference."enabled" = true
            AND NOT EXISTS (
              SELECT 1
              FROM "AuthSession" AS session
              WHERE session."userId" = preference."userId"
                AND session."expiresAt" > ${now}
                AND session."lastSeenAt" >= ${recentActivityCutoff}
                AND session."revokedAt" IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "InboundMcpOAuthGrant" AS hub_grant
              WHERE hub_grant."userId" = preference."userId"
                AND hub_grant."resourcePath" = '/mcp/hub'
                AND hub_grant."capability" = 'mcp:hub'
                AND hub_grant."state" = 'ACTIVE'
                AND hub_grant."lastUsedAt" >= ${recentActivityCutoff}
            )
        `.catch(retainDatabaseFailure);
      }
      const records = await client.mcpUserServer.findMany({
        include: {
          server: {
            include: {
              activeRevision: true,
              grants: true,
              oauthConnections: {
                include: { oauthClient: { select: { clientId: true } } },
                orderBy: { createdAt: "desc" }
              }
            }
          },
          user: {
            select: {
              groups: {
                select: { groupId: true },
                where: { group: { archivedAt: null } }
              },
              id: true
            }
          }
        },
        where: {
          ...(onDemand
            ? { serverId: { in: [...(serverIds ?? [])] } }
            : { desiredRuntimeGenerationId: { not: null } }),
          enabled: true,
          server: {
            activeRevisionId: { not: null },
            archivedAt: null,
            enabled: true,
            ...(userId ? { OR: [{ ownerUserId: null }, { ownerUserId: userId }] } : {})
          },
          user: {
            status: "active",
            ...(userId ? { id: userId } : {
              OR: [
                { authSessions: { some: {
                  expiresAt: { gt: now }, lastSeenAt: { gte: recentActivityCutoff }, revokedAt: null
                } } },
                { inboundMcpOAuthGrants: { some: {
                  resourcePath: "/mcp/hub", capability: "mcp:hub", state: "ACTIVE",
                  lastUsedAt: { gte: recentActivityCutoff }
                } } }
              ]
            })
          }
        }
      }).catch(retainDatabaseFailure);
      const key = encryptionKey();
      const launches: McpRuntimeGenerationLaunch[] = [];
      for (const record of records) {
        const candidate = remoteRuntimeCandidate({
          key,
          record,
          ...(input.oauthRedirectUri ? { oauthRedirectUri: input.oauthRedirectUri } : {})
        });
        if (!candidate) {
          await client.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null },
            where: { id: record.id }
          }).catch(retainDatabaseFailure);
          continue;
        }
        const generation = await client.$transaction(async (tx) => {
          const existing = await tx.mcpRuntimeGeneration.findUnique({
            where: { fingerprint: candidate.fingerprint }
          });
          const selectedGenerationId = generationId();
          const selected = existing ?? await tx.mcpRuntimeGeneration.create({
            data: {
              credentialSources: [...candidate.credentialSources],
              effectiveConfigEnvelope: encryptMcpEnvelope(
                candidate.effectiveEnvelope,
                key,
                mcpRuntimeGenerationEnvelopeContext(selectedGenerationId, candidate.fingerprint)
              ),
              externalAccountLabel: candidate.externalAccountLabel,
              fingerprint: candidate.fingerprint,
              id: selectedGenerationId,
              oauthConnectionId: candidate.oauthConnectionId ?? null,
              revisionId: candidate.revisionId,
              state: "starting",
              userServerId: candidate.userServerId
            }
          });
          if (selected.userServerId !== candidate.userServerId ||
            selected.revisionId !== candidate.revisionId ||
            (selected.oauthConnectionId ?? null) !== (candidate.oauthConnectionId ?? null)) {
            throw runtimeConfigurationError("mcp_runtime_fingerprint_collision");
          }
          if (!sameCredentialSources(selected.credentialSources, candidate.credentialSources)) {
            throw runtimeConfigurationError("mcp_runtime_fingerprint_collision");
          }
          if (selected.externalAccountLabel !== candidate.externalAccountLabel) {
            await tx.mcpRuntimeGeneration.update({
              data: { externalAccountLabel: candidate.externalAccountLabel },
              where: { id: selected.id }
            });
          }
          const accepted = await tx.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: selected.id },
            where: {
              enabled: true,
              id: candidate.userServerId,
              // A sync that read the row before a value replacement never
              // re-desires the generation of the replaced values.
              personalConfigVersion: record.personalConfigVersion,
              server: {
                activeRevisionId: candidate.revisionId,
                archivedAt: null,
                enabled: true,
                ...(candidate.personalRuntime ? { ownerUserId: candidate.userId } : {}),
                ...(candidate.oauthConnectionId ? {
                  oauthConnections: {
                    some: {
                      id: candidate.oauthConnectionId,
                      state: "ready",
                      userId: candidate.userId
                    }
                  }
                } : {})
              }
            }
          });
          return accepted.count ? selected : null;
        }).catch(retainDatabaseFailure);
        if (!generation) continue;
        launches.push(generationLaunch(candidate, generation, now));
      }
      return launches;
    },

    synchronizeShared: async ({ now, onDemand = false, serverIds }) => {
      const recentDemandCutoff = new Date(now.getTime() - RECENT_ACTIVITY_MS);
      if (!onDemand) {
        // Project demand, not member activity, keeps a shared runtime desired.
        // An idle or no longer eligible one drains; the next Project run starts
        // it again on demand.
        await client.mcpSharedRuntime.updateMany({
          data: { desiredRuntimeGenerationId: null },
          where: {
            desiredRuntimeGenerationId: { not: null },
            OR: [
              { requestedAt: { lt: recentDemandCutoff } },
              { server: { OR: [
                { enabled: false },
                { archivedAt: { not: null } },
                { activeRevisionId: null },
                { projectBindings: { none: {} } }
              ] } }
            ]
          }
        }).catch(retainDatabaseFailure);
      }
      const servers = await client.mcpServer.findMany({
        include: { activeRevision: true },
        where: {
          activeRevisionId: { not: null },
          archivedAt: null,
          enabled: true,
          ownerUserId: null,
          projectBindings: { some: {} },
          ...(onDemand
            ? { id: { in: [...(serverIds ?? [])] } }
            : { sharedRuntime: { is: { desiredRuntimeGenerationId: { not: null } } } })
        }
      }).catch(retainDatabaseFailure);
      const key = encryptionKey();
      const launches: McpRuntimeGenerationLaunch[] = [];
      for (const server of servers) {
        let candidate: SharedRuntimeCandidate | null;
        try {
          candidate = sharedRuntimeCandidate({ key, server });
          reportSubsystemHealthy("mcp", "preflight", server.id);
        } catch (error) {
          reportSubsystemFailure({ subsystem: "mcp", stage: "preflight", scope_id: server.id,
            code: observedFailureCode(error), action: "skip" });
          candidate = null;
        }
        if (!candidate) {
          await client.mcpSharedRuntime.updateMany({
            data: { desiredRuntimeGenerationId: null },
            where: { serverId: server.id }
          }).catch(retainDatabaseFailure);
          continue;
        }
        const shared = candidate;
        const generation = await client.$transaction(async (tx) => {
          // Concurrent Project runs of several members converge on one row
          // and one generation instead of failing on a unique fingerprint.
          await tx.mcpSharedRuntime.createMany({
            data: [{ requestedAt: now, serverId: shared.serverId }],
            skipDuplicates: true
          });
          const selectedGenerationId = generationId();
          await tx.mcpRuntimeGeneration.createMany({
            data: [{
              credentialSources: [...shared.credentialSources],
              effectiveConfigEnvelope: encryptMcpEnvelope(
                shared.effectiveEnvelope,
                key,
                mcpRuntimeGenerationEnvelopeContext(selectedGenerationId, shared.fingerprint)
              ),
              externalAccountLabel: null,
              fingerprint: shared.fingerprint,
              id: selectedGenerationId,
              oauthConnectionId: null,
              revisionId: shared.revisionId,
              sharedServerId: shared.serverId,
              state: "starting"
            }],
            skipDuplicates: true
          });
          const selected = await tx.mcpRuntimeGeneration.findUnique({
            where: { fingerprint: shared.fingerprint }
          });
          if (!selected || selected.sharedServerId !== shared.serverId || selected.userServerId !== null ||
            selected.revisionId !== shared.revisionId || selected.oauthConnectionId !== null ||
            !sameCredentialSources(selected.credentialSources, shared.credentialSources)) {
            throw runtimeConfigurationError("mcp_runtime_fingerprint_collision");
          }
          // Shared values rotated since they were read make this generation stale.
          const accepted = await tx.mcpSharedRuntime.updateMany({
            data: {
              desiredRuntimeGenerationId: selected.id,
              ...(onDemand ? { requestedAt: now } : {})
            },
            where: {
              server: {
                activeRevisionId: shared.revisionId,
                archivedAt: null,
                enabled: true,
                sharedConfigVersion: server.sharedConfigVersion
              },
              serverId: shared.serverId
            }
          });
          return accepted.count ? selected : null;
        }).catch(retainDatabaseFailure);
        if (!generation) continue;
        launches.push(generationLaunch(shared, generation, now));
      }
      return launches;
    },

    markStarting: async ({ fingerprint, generationId, now }) => {
      const count = await client.$executeRaw`
        UPDATE "McpRuntimeGeneration" AS generation
        SET "state" = 'starting'::"McpRuntimeState",
            "errorCode" = NULL,
            "readinessCheckedAt" = ${now},
            "updatedAt" = ${now}
        WHERE generation."id" = ${generationId}
          AND generation."fingerprint" = ${fingerprint}
          AND (
            EXISTS (
              SELECT 1
              FROM "McpUserServer" AS preference
              JOIN "McpServer" AS server ON server."id" = preference."serverId"
              WHERE preference."desiredRuntimeGenerationId" = generation."id"
                AND preference."enabled" = true
                AND server."enabled" = true
                AND server."archivedAt" IS NULL
                AND server."activeRevisionId" = generation."revisionId"
            )
            OR EXISTS (
              SELECT 1
              FROM "McpSharedRuntime" AS shared
              JOIN "McpServer" AS server ON server."id" = shared."serverId"
              WHERE shared."desiredRuntimeGenerationId" = generation."id"
                AND server."enabled" = true
                AND server."archivedAt" IS NULL
                AND server."activeRevisionId" = generation."revisionId"
            )
            OR EXISTS (
              SELECT 1
              FROM "McpRunBinding" AS binding
              JOIN "ModelRun" AS run ON run."id" = binding."modelRunId"
              WHERE binding."runtimeGenerationId" = generation."id"
                AND run."status" IN ('preparing', 'queued', 'streaming', 'in_progress')
            )
          )
      `.catch(retainDatabaseFailure);
      return count === 1;
    },

    markReady: async ({ discoveredInventory, fingerprint, generationId, inventory, now }) => {
      const inventoryJson = JSON.stringify(inventory);
      const count = await client.$executeRaw`
        UPDATE "McpRuntimeGeneration" AS generation
        SET "state" = 'ready'::"McpRuntimeState",
            "inventory" = ${inventoryJson}::jsonb,
            "inventoryUpdatedAt" = ${now},
            "readinessCheckedAt" = ${now},
            "errorCode" = NULL,
            "retryAt" = NULL,
            "attemptCount" = 0,
            "updatedAt" = ${now}
        WHERE generation."id" = ${generationId}
          AND generation."fingerprint" = ${fingerprint}
          AND (
            EXISTS (
              SELECT 1
              FROM "McpUserServer" AS preference
              JOIN "McpServer" AS server ON server."id" = preference."serverId"
              WHERE preference."desiredRuntimeGenerationId" = generation."id"
                AND preference."enabled" = true
                AND server."enabled" = true
                AND server."archivedAt" IS NULL
                AND server."activeRevisionId" = generation."revisionId"
            )
            OR EXISTS (
              SELECT 1
              FROM "McpSharedRuntime" AS shared
              JOIN "McpServer" AS server ON server."id" = shared."serverId"
              WHERE shared."desiredRuntimeGenerationId" = generation."id"
                AND server."enabled" = true
                AND server."archivedAt" IS NULL
                AND server."activeRevisionId" = generation."revisionId"
            )
            OR EXISTS (
              SELECT 1
              FROM "McpRunBinding" AS binding
              JOIN "ModelRun" AS run ON run."id" = binding."modelRunId"
              WHERE binding."runtimeGenerationId" = generation."id"
                AND run."status" IN ('preparing', 'queued', 'streaming', 'in_progress')
            )
          )
      `.catch(retainDatabaseFailure);
      if (count === 1 && discoveredInventory) {
        const discoveredJson = JSON.stringify(discoveredInventory);
        // Catalog evidence survives idle generation deletion. Only the current
        // personal generation may replace it; accepted historical runs cannot
        // republish metadata from an old OAuth identity into future discovery.
        await client.$executeRaw`
          UPDATE "McpUserServer" AS preference
          SET "discoveredInventory" = ${discoveredJson}::jsonb,
              "discoveredRevisionId" = generation."revisionId",
              "discoveredOAuthConnectionId" = generation."oauthConnectionId"
          FROM "McpRuntimeGeneration" AS generation
          JOIN "McpServer" AS server ON server."activeRevisionId" = generation."revisionId"
          WHERE generation."id" = ${generationId}
            AND generation."fingerprint" = ${fingerprint}
            AND generation."state" = 'ready'::"McpRuntimeState"
            AND preference."id" = generation."userServerId"
            AND preference."desiredRuntimeGenerationId" = generation."id"
            AND preference."serverId" = server."id"
            AND preference."userId" = server."ownerUserId"
            AND preference."enabled" = true
            AND server."enabled" = true
            AND server."archivedAt" IS NULL
            AND (
              generation."oauthConnectionId" IS NULL
              OR EXISTS (
                SELECT 1 FROM "McpOAuthConnection" AS connection
                WHERE connection."id" = generation."oauthConnectionId"
                  AND connection."serverId" = server."id"
                  AND connection."userId" = preference."userId"
                  AND connection."purpose" = 'user'::"McpOAuthPurpose"
                  AND connection."state" = 'ready'::"McpOAuthConnectionState"
                  AND connection."disconnectRequestedAt" IS NULL
              )
            )
        `.catch(retainDatabaseFailure);
      }
      return count === 1;
    },

    markFailed: async ({ errorCode, fingerprint, generationId, now }) => {
      const rows = await client.$queryRaw<Array<{ retryAt: Date }>>`
        UPDATE "McpRuntimeGeneration" AS generation
        SET "state" = 'failed'::"McpRuntimeState",
            "errorCode" = ${errorCode},
            "readinessCheckedAt" = ${now},
            "retryAt" = ${now} + make_interval(
              secs => LEAST(300, (5 * power(2, LEAST(generation."attemptCount", 6)))::integer)
            ),
            "attemptCount" = LEAST(generation."attemptCount" + 1, 10),
            "updatedAt" = ${now}
        WHERE generation."id" = ${generationId}
          AND generation."fingerprint" = ${fingerprint}
          AND (
            EXISTS (
              SELECT 1
              FROM "McpUserServer" AS preference
              WHERE preference."desiredRuntimeGenerationId" = generation."id"
                AND preference."enabled" = true
            )
            OR EXISTS (
              SELECT 1
              FROM "McpSharedRuntime" AS shared
              WHERE shared."desiredRuntimeGenerationId" = generation."id"
            )
            OR EXISTS (
              SELECT 1
              FROM "McpRunBinding" AS binding
              JOIN "ModelRun" AS run ON run."id" = binding."modelRunId"
              WHERE binding."runtimeGenerationId" = generation."id"
                AND run."status" IN ('preparing', 'queued', 'streaming', 'in_progress')
            )
          )
        RETURNING generation."retryAt"
      `.catch(retainDatabaseFailure);
      return { applied: rows.length === 1, retryAt: rows.length === 1 ? rows[0]!.retryAt : null };
    },

    listDrainedGenerationIds: async () => {
      const rows = await client.mcpRuntimeGeneration.findMany({
        select: { id: true },
        where: {
          createdAt: { lt: new Date(Date.now() - DRAIN_GRACE_MS) },
          desiredFor: null,
          runBindings: {
            none: { modelRun: { status: { in: [...ACTIVE_RUN_STATUSES] } } }
          },
          sharedDesiredFor: null
        }
      }).catch(retainDatabaseFailure);
      return rows.map((row) => row.id);
    },

    deleteDrainedGeneration: async (generationId) => {
      const deleted = await client.mcpRuntimeGeneration.deleteMany({
        where: {
          id: generationId,
          desiredFor: null,
          runBindings: {
            none: { modelRun: { status: { in: [...ACTIVE_RUN_STATUSES] } } }
          },
          sharedDesiredFor: null
        }
      }).catch(retainDatabaseFailure);
      return deleted.count === 1;
    },

    finalizeDeletedServers: async () => client.$transaction(async (tx) => {
      // A stored token, whatever its state, waits for revocation or the
      // revocation bound; deleting the server would cascade it away.
      const tokensSettled = { none: { tokenEnvelope: { not: null } } } satisfies Prisma.McpOAuthConnectionListRelationFilter;
      const candidates = await tx.mcpServer.findMany({
        orderBy: { archivedAt: "asc" },
        select: { id: true },
        take: 100,
        where: {
          archivedAt: { not: null },
          oauthConnections: tokensSettled,
          revisions: { none: { runtimeGenerations: { some: {} } } }
        }
      });
      const serverIds = candidates.map((candidate) => candidate.id);
      if (!serverIds.length) return 0;

      const oauthConnections = await tx.mcpOAuthConnection.findMany({
        select: { oauthClientId: true },
        where: { oauthClientId: { not: null }, serverId: { in: serverIds } }
      });
      const oauthClientIds = [...new Set(oauthConnections.flatMap((connection) =>
        connection.oauthClientId ? [connection.oauthClientId] : []
      ))];

      await tx.mcpServer.updateMany({
        data: { activeRevisionId: null },
        where: {
          archivedAt: { not: null },
          id: { in: serverIds },
          revisions: { none: { runtimeGenerations: { some: {} } } }
        }
      });
      await tx.mcpRevision.deleteMany({
        where: {
          runtimeGenerations: { none: {} },
          serverId: { in: serverIds }
        }
      });
      const deleted = await tx.mcpServer.deleteMany({
        where: {
          archivedAt: { not: null },
          id: { in: serverIds },
          oauthConnections: tokensSettled,
          revisions: { none: {} }
        }
      });
      if (oauthClientIds.length) {
        await tx.mcpOAuthClient.deleteMany({
          where: { connections: { none: {} }, id: { in: oauthClientIds } }
        });
      }
      return deleted.count;
    }).catch(retainDatabaseFailure),

    touchLastUsed: async (generationId, now) => {
      await client.mcpRuntimeGeneration.updateMany({
        data: { lastUsedAt: now },
        where: { id: generationId }
      }).catch(retainDatabaseFailure);
    }
  };
}
