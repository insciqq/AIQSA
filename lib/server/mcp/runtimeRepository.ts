import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  McpCredentialSource,
  McpDraftConfiguration,
  McpSlotValue
} from "@/lib/contracts/mcp";
import { prisma } from "@/lib/server/prisma";
import {
  mcpRuntimeFingerprint,
  resolveEffectiveMcpGrant,
  resolveEffectiveMcpValues,
  type EffectiveMcpSlotPlanItem
} from "./access";
import { validateMcpDraft, validateMcpSlotValue } from "./definitions";
import {
  decryptMcpEnvelope,
  encryptMcpEnvelope,
  getMcpEncryptionKey,
  mcpPersonalConfigEnvelopeContext,
  mcpRuntimeGenerationEnvelopeContext,
  mcpSharedConfigEnvelopeContext,
  type McpEnvelopeContext
} from "./encryption";
import { parseMcpLocalResolvedArtifact } from "./localArtifact";
import { buildMcpOAuthPolicy, mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import type {
  McpRuntimeCoordinatorRepository,
  McpRuntimeLaunch
} from "./runtimeCoordinator";

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"] as const;
const RECENT_ACTIVITY_MS = 15 * 60_000;
const DRAIN_GRACE_MS = 60_000;
const INVENTORY_FRESH_MS = 5 * 60_000;

type StoredValues = {
  values: Record<string, McpSlotValue>;
  version: 1;
};

type StoredEffectiveSnapshot = StoredValues & {
  plan: EffectiveMcpSlotPlanItem[];
};

function isSlotValue(value: unknown): value is McpSlotValue {
  return typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function storedValues(
  envelope: string | null,
  key: Buffer,
  context?: McpEnvelopeContext
): StoredValues {
  if (!envelope) return { values: {}, version: 1 };
  if (!context) throw new Error("mcp_values_invalid");
  const decoded = decryptMcpEnvelope<unknown>(envelope, key, context);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) ||
    !("version" in decoded) || decoded.version !== 1 || !("values" in decoded) ||
    !decoded.values || typeof decoded.values !== "object" || Array.isArray(decoded.values)) {
    throw new Error("mcp_values_invalid");
  }
  const values: Record<string, McpSlotValue> = {};
  for (const [slotKey, value] of Object.entries(decoded.values)) {
    if (!isSlotValue(value)) throw new Error("mcp_values_invalid");
    values[slotKey] = value;
  }
  return { values, version: 1 };
}

function storedEffectiveSnapshot(
  envelope: string | null,
  key: Buffer,
  context: McpEnvelopeContext
): StoredEffectiveSnapshot {
  if (!envelope) throw new Error("mcp_values_invalid");
  const decoded = decryptMcpEnvelope<unknown>(envelope, key, context);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) ||
    !("version" in decoded) || decoded.version !== 1 || !("values" in decoded) ||
    !decoded.values || typeof decoded.values !== "object" || Array.isArray(decoded.values) ||
    !("plan" in decoded) || !Array.isArray(decoded.plan)) {
    throw new Error("mcp_values_invalid");
  }
  const values: Record<string, McpSlotValue> = {};
  for (const [slotKey, value] of Object.entries(decoded.values)) {
    if (!isSlotValue(value)) throw new Error("mcp_values_invalid");
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
      throw new Error("mcp_values_invalid");
    }
    slotKeys.add(item.slotKey);
    plan.push({
      authorized: item.authorized,
      slotKey: item.slotKey,
      source: item.source as EffectiveMcpSlotPlanItem["source"],
      valueVersion: item.valueVersion
    });
  }
  return { plan, values, version: 1 };
}

function revisionConfiguration(value: Prisma.JsonValue): McpDraftConfiguration | null {
  const validated = validateMcpDraft(value);
  return validated.ok ? validated.value : null;
}

function headerValue(value: McpSlotValue): string {
  return typeof value === "string" ? value : String(value);
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

export type RemoteRuntimeCandidate = {
  allowPrivateNetwork: boolean;
  callTimeoutMs: number;
  effectiveEnvelope: {
    plan: ReturnType<typeof resolveEffectiveMcpValues>["plan"];
    values: Record<string, McpSlotValue>;
    version: 1;
  };
  credentialSources: readonly McpCredentialSource[];
  disabledToolNames?: readonly string[];
  externalAccountLabel: string | null;
  fingerprint: string;
  headers: Record<string, string>;
  oauthConnectionId?: string;
  revisionId: string;
  redactionValues: readonly string[];
  startupTimeoutMs: number;
  url: string;
  userId: string;
  userServerId: string;
};

export type LocalRuntimeCandidate = {
  callTimeoutMs: number;
  effectiveEnvelope: {
    plan: ReturnType<typeof resolveEffectiveMcpValues>["plan"];
    values: Record<string, McpSlotValue>;
    version: 1;
  };
  credentialSources: readonly McpCredentialSource[];
  disabledToolNames?: readonly string[];
  externalAccountLabel: null;
  fingerprint: string;
  oauthConnectionId?: undefined;
  revisionId: string;
  redactionValues: readonly string[];
  startupTimeoutMs: number;
  toolHive: NonNullable<McpRuntimeLaunch["toolHive"]>;
  userId: string;
  userServerId: string;
};

type EffectiveRuntimeCandidate = Readonly<{
  configuration: McpDraftConfiguration;
  credentialSources: readonly McpCredentialSource[];
  effectiveEnvelope: RemoteRuntimeCandidate["effectiveEnvelope"];
  fingerprint: string;
  externalAccountLabel: string | null;
  oauthConnectionId: string | null;
  revision: NonNullable<DesiredRecord["server"]["activeRevision"]>;
  userId: string;
  userServerId: string;
}>;

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
    const value = headerValue(values[slot.slotKey]!);
    return value ? [value] : [];
  }))];
}

function effectiveRuntimeCandidate(input: {
  key: Buffer;
  oauthRedirectUri?: (serverId: string) => string;
  record: DesiredRecord;
}): EffectiveRuntimeCandidate | null {
  if (!input.record.enabled || !input.record.server.enabled || input.record.server.archivedAt) return null;
  const revision = input.record.server.activeRevision;
  if (!revision) return null;
  const configuration = revisionConfiguration(revision.configuration);
  if (!configuration) return null;
  const groupIds = input.record.user.groups.map((membership) => membership.groupId);
  const direct = input.record.server.grants.find((grant) => grant.userId === input.record.userId) ?? null;
  const groups = input.record.server.grants.filter((grant) => grant.groupId && groupIds.includes(grant.groupId));
  const access = resolveEffectiveMcpGrant({ direct, groups });
  if (!access.canUse) return null;
  const shared = storedValues(
    input.record.server.sharedConfigEnvelope,
    input.key,
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
    } catch {
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
    effectiveEnvelope: { plan: effective.plan, values: effective.values, version: 1 },
    externalAccountLabel,
    fingerprint,
    oauthConnectionId,
    revision,
    userId: input.record.userId,
    userServerId: input.record.id
  };
}

export function remoteRuntimeCandidate(input: {
  key: Buffer;
  oauthRedirectUri?: (serverId: string) => string;
  record: DesiredRecord;
}): RemoteRuntimeCandidate | null {
  const base = effectiveRuntimeCandidate(input);
  if (!base) return null;
  const { configuration } = base;
  const source = configuration.source;
  if (source.kind !== "remote") return null;
  const headers: Record<string, string> = {};
  for (const slot of configuration.slots) {
    if (slot.target.kind === "header" && Object.hasOwn(base.effectiveEnvelope.values, slot.slotKey)) {
      headers[slot.target.name] = headerValue(base.effectiveEnvelope.values[slot.slotKey]!);
    }
  }
  return {
    allowPrivateNetwork: source.allowPrivateNetwork === true,
    callTimeoutMs: configuration.runtime.callTimeoutMs,
    credentialSources: base.credentialSources,
    ...(base.configuration.disabledToolNames?.length
      ? { disabledToolNames: base.configuration.disabledToolNames }
      : {}),
    effectiveEnvelope: base.effectiveEnvelope,
    externalAccountLabel: base.externalAccountLabel,
    fingerprint: base.fingerprint,
    headers,
    ...(base.oauthConnectionId ? { oauthConnectionId: base.oauthConnectionId } : {}),
    redactionValues: effectiveRedactionValues(configuration, base.effectiveEnvelope.values),
    revisionId: base.revision.id,
    startupTimeoutMs: configuration.runtime.startupTimeoutMs,
    url: source.url,
    userId: base.userId,
    userServerId: base.userServerId
  };
}

export function localRuntimeCandidate(input: {
  key: Buffer;
  record: DesiredRecord;
}): LocalRuntimeCandidate | null {
  const base = effectiveRuntimeCandidate(input);
  if (!base || base.configuration.source.kind === "remote") return null;
  const artifact = parseMcpLocalResolvedArtifact(
    base.revision.resolvedArtifact,
    base.configuration.source
  );
  if (!artifact) return null;
  const envVars: Record<string, string> = {};
  for (const slot of base.configuration.slots) {
    if (slot.target.kind !== "environment" ||
      !Object.hasOwn(base.effectiveEnvelope.values, slot.slotKey)) return null;
    envVars[slot.target.name] = headerValue(base.effectiveEnvelope.values[slot.slotKey]!);
  }
  return {
    callTimeoutMs: base.configuration.runtime.callTimeoutMs,
    credentialSources: base.credentialSources,
    ...(base.configuration.disabledToolNames?.length
      ? { disabledToolNames: base.configuration.disabledToolNames }
      : {}),
    effectiveEnvelope: base.effectiveEnvelope,
    externalAccountLabel: null,
    fingerprint: base.fingerprint,
    redactionValues: effectiveRedactionValues(base.configuration, base.effectiveEnvelope.values),
    revisionId: base.revision.id,
    startupTimeoutMs: base.configuration.runtime.startupTimeoutMs,
    toolHive: {
      cmdArguments: base.configuration.source.args,
      envVars,
      generationToken: base.fingerprint,
      image: artifact.imageRef
    },
    userId: base.userId,
    userServerId: base.userServerId
  };
}

function runtimeCandidate(input: {
  key: Buffer;
  oauthRedirectUri?: (serverId: string) => string;
  record: DesiredRecord;
}): LocalRuntimeCandidate | RemoteRuntimeCandidate | null {
  const revision = input.record.server.activeRevision;
  const configuration = revision && revisionConfiguration(revision.configuration);
  return configuration?.source.kind === "remote"
    ? remoteRuntimeCandidate(input)
    : localRuntimeCandidate(input);
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
            select: { configuration: true, id: true, resolvedArtifact: true, serverId: true }
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
      });
      if (!generation || generation.revision.serverId !== generation.userServer.serverId) return null;
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
        const configuredSlotKeys = new Set(configuration.slots.map((slot) => slot.slotKey));
        if (snapshot.plan.length !== configuration.slots.length ||
          Object.keys(snapshot.values).length !== configuration.slots.length ||
          snapshot.plan.some((item) => !configuredSlotKeys.has(item.slotKey)) ||
          configuration.slots.some((slot) => !Object.hasOwn(snapshot.values, slot.slotKey) ||
            !validateMcpSlotValue(slot, snapshot.values[slot.slotKey]))) return null;
        const fingerprint = mcpRuntimeFingerprint({
          oauthConnectionRevision: generation.oauthConnectionId,
          plan: snapshot.plan,
          revisionId: generation.revision.id,
          userId: generation.userServer.userId
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
          redactionValues: effectiveRedactionValues(configuration, snapshot.values),
          retryAt: generation.retryAt,
          startupTimeoutMs: configuration.runtime.startupTimeoutMs
        };
        if (configuration.source.kind === "remote") {
          const headers: Record<string, string> = {};
          for (const slot of configuration.slots) {
            if (slot.target.kind === "header") {
              headers[slot.target.name] = headerValue(snapshot.values[slot.slotKey]!);
            }
          }
          return {
            ...commonLaunch,
            allowPrivateNetwork: configuration.source.allowPrivateNetwork === true,
            headers,
            ...(generation.oauthConnectionId
              ? { oauthConnectionId: generation.oauthConnectionId }
              : {}),
            url: configuration.source.url
          };
        }
        const artifact = parseMcpLocalResolvedArtifact(
          generation.revision.resolvedArtifact,
          configuration.source
        );
        if (!artifact) return null;
        const envVars: Record<string, string> = {};
        for (const slot of configuration.slots) {
          if (slot.target.kind !== "environment") return null;
          envVars[slot.target.name] = headerValue(snapshot.values[slot.slotKey]!);
        }
        return {
          ...commonLaunch,
          toolHive: {
            cmdArguments: configuration.source.args,
            envVars,
            generationToken: generation.fingerprint,
            image: artifact.imageRef
          }
        };
      } catch {
        return null;
      }
    },

    synchronizeDesired: async ({ now, userId }) => {
      await input.reconcileOAuthConnections?.().catch(() => undefined);
      const recentActivityCutoff = new Date(now.getTime() - RECENT_ACTIVITY_MS);
      if (!userId) {
        // Eviction is observed runtime state, not a user preference mutation.
        // Keep McpUserServer.updatedAt as the enable/config-change timestamp so
        // the catalog can distinguish a fresh queued change from an old idle one.
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
        `;
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
          enabled: true,
          server: { activeRevisionId: { not: null }, archivedAt: null, enabled: true },
          user: {
            status: "active",
            ...(userId ? { id: userId } : {
              authSessions: {
                some: {
                  expiresAt: { gt: now },
                  lastSeenAt: { gte: recentActivityCutoff },
                  revokedAt: null
                }
              }
            })
          }
        }
      });
      const key = encryptionKey();
      const launches: McpRuntimeLaunch[] = [];
      for (const record of records) {
        const candidate = runtimeCandidate({
          key,
          record,
          ...(input.oauthRedirectUri ? { oauthRedirectUri: input.oauthRedirectUri } : {})
        });
        if (!candidate) {
          await client.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null },
            where: { id: record.id }
          });
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
            throw new Error("mcp_runtime_fingerprint_collision");
          }
          if (selected.credentialSources.some((source) =>
            !candidate.credentialSources.includes(source as McpCredentialSource)) ||
            selected.credentialSources.length !== candidate.credentialSources.length) {
            throw new Error("mcp_runtime_fingerprint_collision");
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
              server: {
                activeRevisionId: candidate.revisionId,
                archivedAt: null,
                enabled: true,
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
        });
        if (!generation) continue;
        const commonLaunch = {
          callTimeoutMs: candidate.callTimeoutMs,
          ...(candidate.disabledToolNames?.length
            ? { disabledToolNames: candidate.disabledToolNames }
            : {}),
          fingerprint: candidate.fingerprint,
          generationId: generation.id,
          headers: {},
          inventoryRefreshRequired: !generation.inventoryUpdatedAt ||
            now.getTime() - generation.inventoryUpdatedAt.getTime() >= INVENTORY_FRESH_MS,
          redactionValues: candidate.redactionValues,
          retryAt: generation.retryAt,
          startupTimeoutMs: candidate.startupTimeoutMs
        };
        launches.push("url" in candidate
          ? {
              ...commonLaunch,
              allowPrivateNetwork: candidate.allowPrivateNetwork,
              headers: candidate.headers,
              ...(candidate.oauthConnectionId
                ? { oauthConnectionId: candidate.oauthConnectionId }
                : {}),
              url: candidate.url
            }
          : { ...commonLaunch, toolHive: candidate.toolHive });
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
              FROM "McpRunBinding" AS binding
              JOIN "ModelRun" AS run ON run."id" = binding."modelRunId"
              WHERE binding."runtimeGenerationId" = generation."id"
                AND run."status" IN ('preparing', 'queued', 'streaming', 'in_progress')
            )
          )
      `;
      return count === 1;
    },

    markReady: async ({ fingerprint, generationId, inventory, now }) => {
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
              FROM "McpRunBinding" AS binding
              JOIN "ModelRun" AS run ON run."id" = binding."modelRunId"
              WHERE binding."runtimeGenerationId" = generation."id"
                AND run."status" IN ('preparing', 'queued', 'streaming', 'in_progress')
            )
          )
      `;
      return count === 1;
    },

    markFailed: async ({ errorCode, fingerprint, generationId, now }) => {
      const count = await client.$executeRaw`
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
              FROM "McpRunBinding" AS binding
              JOIN "ModelRun" AS run ON run."id" = binding."modelRunId"
              WHERE binding."runtimeGenerationId" = generation."id"
                AND run."status" IN ('preparing', 'queued', 'streaming', 'in_progress')
            )
          )
      `;
      return count === 1;
    },

    listGenerationFingerprints: async () => {
      const [generations, activations] = await Promise.all([
        client.mcpRuntimeGeneration.findMany({ select: { fingerprint: true } }),
        client.mcpActivationJob.findMany({
          select: { workloadToken: true },
          where: {
            stage: {
              in: [
                "queued",
                "resolving",
                "preparing_runtime",
                "connecting",
                "discovering_tools",
                "publishing"
              ]
            }
          }
        })
      ]);
      return [
        ...generations.map((row) => row.fingerprint),
        ...activations.map((row) => row.workloadToken)
      ];
    },

    listDrainedGenerationIds: async () => {
      const rows = await client.mcpRuntimeGeneration.findMany({
        select: { id: true },
        where: {
          createdAt: { lt: new Date(Date.now() - DRAIN_GRACE_MS) },
          desiredFor: null,
          runBindings: {
            none: { modelRun: { status: { in: [...ACTIVE_RUN_STATUSES] } } }
          }
        }
      });
      return rows.map((row) => row.id);
    },

    deleteDrainedGeneration: async (generationId) => {
      const deleted = await client.mcpRuntimeGeneration.deleteMany({
        where: {
          id: generationId,
          desiredFor: null,
          runBindings: {
            none: { modelRun: { status: { in: [...ACTIVE_RUN_STATUSES] } } }
          }
        }
      });
      return deleted.count === 1;
    },

    finalizeDeletedServers: async () => client.$transaction(async (tx) => {
      const candidates = await tx.mcpServer.findMany({
        orderBy: { archivedAt: "asc" },
        select: { id: true },
        take: 100,
        where: {
          archivedAt: { not: null },
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
          revisions: { none: {} }
        }
      });
      if (oauthClientIds.length) {
        await tx.mcpOAuthClient.deleteMany({
          where: { connections: { none: {} }, id: { in: oauthClientIds } }
        });
      }
      return deleted.count;
    }),

    touchLastUsed: async (generationId, now) => {
      await client.mcpRuntimeGeneration.updateMany({
        data: { lastUsedAt: now },
        where: { id: generationId }
      });
    }
  };
}
