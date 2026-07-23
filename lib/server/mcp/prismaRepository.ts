import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminMcpServer,
  McpConfigurationSlot,
  McpDraftConfiguration,
  McpDraftTestSummary,
  McpJsonObject,
  McpJsonValue,
  McpRevisionSummary,
  McpSlotValue,
  McpToolInventoryEntry,
  McpValidationEvidence,
  McpValidationIssue,
  UserMcpConfigurationField,
  UserMcpServer
} from "@/lib/contracts/mcp";
import { prisma } from "@/lib/server/prisma";
import { resolveEffectiveMcpGrant, resolveEffectiveMcpValues } from "./access";
import {
  hashCanonicalMcpValue,
  validateMcpDraft,
  validateMcpSlotIdentityLineage,
  validateMcpSlotValue
} from "./definitions";
import type { McpDraftValidator } from "./draftValidator";
import { unavailableMcpDraftValidator } from "./draftValidator";
import { decryptMcpEnvelope, encryptMcpEnvelope, getMcpEncryptionKey } from "./encryption";
import { buildMcpOAuthPolicy, mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import { parseMcpLocalResolvedArtifact } from "./localArtifact";
import type { McpRepository, McpRepositoryResult } from "./repositoryContract";

const adminServerInclude = {
  activeRevision: {
    select: {
      configuration: true,
      createdAt: true,
      draftHash: true,
      id: true,
      resolvedArtifact: true,
      revisionNumber: true,
      runtimeGenerations: {
        orderBy: { updatedAt: "desc" as const },
        select: { errorCode: true, state: true },
        take: 1
      },
      validationEvidence: true
    }
  },
  grants: {
    include: {
      group: { select: { id: true, name: true } },
      user: { select: { displayName: true, id: true } }
    },
    orderBy: { createdAt: "asc" as const }
  },
  oauthConnections: {
    orderBy: { updatedAt: "desc" as const },
    select: {
      createdAt: true,
      externalAccountLabel: true,
      oauthClient: { select: { clientId: true } },
      policyFingerprint: true,
      state: true,
      userId: true
    },
    where: { purpose: "validation" as const }
  },
  revisions: {
    orderBy: { revisionNumber: "desc" as const },
    select: {
      configuration: true,
      createdAt: true,
      draftHash: true,
      id: true,
      resolvedArtifact: true,
      revisionNumber: true,
      runtimeGenerations: {
        orderBy: { updatedAt: "desc" as const },
        select: { errorCode: true, state: true },
        take: 1
      },
      validationEvidence: true
    }
  }
} satisfies Prisma.McpServerInclude;

const MCP_QUEUE_GRACE_MS = 2 * 60_000;

type AdminServerRecord = Prisma.McpServerGetPayload<{ include: typeof adminServerInclude }>;
type McpDataClient = Pick<
  Prisma.TransactionClient,
  "group" | "mcpGrant" | "mcpServer" | "mcpUserServer" | "user"
>;

type StoredValues = {
  updatedAt: Record<string, string>;
  values: Record<string, McpSlotValue>;
  version: 1;
};

function emptyStoredValues(): StoredValues {
  return { updatedAt: {}, values: {}, version: 1 };
}

function isSlotValue(value: unknown): value is McpSlotValue {
  return typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function readStoredValues(envelope: string | null, key: Buffer): StoredValues {
  if (!envelope) return emptyStoredValues();
  const decoded = decryptMcpEnvelope<unknown>(envelope, key);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("mcp_values_invalid");
  }
  const candidate = decoded as Partial<StoredValues>;
  if (candidate.version !== 1 || !candidate.values || typeof candidate.values !== "object" ||
    Array.isArray(candidate.values) || !candidate.updatedAt || typeof candidate.updatedAt !== "object" ||
    Array.isArray(candidate.updatedAt)) {
    throw new Error("mcp_values_invalid");
  }
  const values: Record<string, McpSlotValue> = {};
  for (const [slotKey, value] of Object.entries(candidate.values)) {
    if (!isSlotValue(value)) throw new Error("mcp_values_invalid");
    values[slotKey] = value;
  }
  const updatedAt: Record<string, string> = {};
  for (const [slotKey, value] of Object.entries(candidate.updatedAt)) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("mcp_values_invalid");
    updatedAt[slotKey] = value;
  }
  return { updatedAt, values, version: 1 };
}

function applyStoredValuePatch(
  current: StoredValues,
  patch: Record<string, McpSlotValue | null>,
  now: Date
): StoredValues {
  const values = { ...current.values };
  const updatedAt = { ...current.updatedAt };
  for (const [slotKey, value] of Object.entries(patch)) {
    if (value === null) {
      delete values[slotKey];
      delete updatedAt[slotKey];
    } else {
      values[slotKey] = value;
      updatedAt[slotKey] = now.toISOString();
    }
  }
  return { updatedAt, values, version: 1 };
}

function draftFrom(value: Prisma.JsonValue): McpDraftConfiguration {
  const result = validateMcpDraft(value);
  if (!result.ok) throw new Error("mcp_draft_invalid_in_storage");
  return result.value;
}

function slotLineageIssues(
  draft: McpDraftConfiguration,
  revisions: readonly Readonly<{ configuration: Prisma.JsonValue }>[]
): McpValidationIssue[] {
  const historical: McpDraftConfiguration[] = [];
  for (const revision of revisions) {
    const parsed = validateMcpDraft(revision.configuration);
    if (!parsed.ok) return [{ code: "slot_lineage_invalid", path: "slots" }];
    historical.push(parsed.value);
  }
  return validateMcpSlotIdentityLineage(draft, historical);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonObjectFrom(value: unknown): McpJsonObject | null {
  return isRecord(value) ? value as McpJsonObject : null;
}

function toolInventoryFrom(value: unknown): McpToolInventoryEntry[] | null {
  if (!Array.isArray(value) || value.length > 512) return null;
  const tools: McpToolInventoryEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" ||
      candidate.name.length === 0 || candidate.name.length > 256 ||
      (candidate.description !== null && typeof candidate.description !== "string") ||
      (typeof candidate.description === "string" && candidate.description.length > 4_000)) {
      return null;
    }
    tools.push({
      description: candidate.description as string | null,
      name: candidate.name
    });
  }
  return tools;
}

function validationEvidenceFrom(value: unknown, fallbackTestedAt: Date): McpValidationEvidence {
  if (isRecord(value)) {
    const evidence = jsonObjectFrom(value.evidence);
    const toolInventory = toolInventoryFrom(value.toolInventory);
    if (evidence && toolInventory && typeof value.testedAt === "string" &&
      Number.isFinite(Date.parse(value.testedAt))) {
      return { evidence, testedAt: value.testedAt, toolInventory };
    }
  }

  return {
    evidence: jsonObjectFrom(value) ?? {},
    testedAt: fallbackTestedAt.toISOString(),
    toolInventory: []
  };
}

function draftTestFrom(value: unknown, draftHash: string | null): McpDraftTestSummary | null {
  if (!draftHash || !isRecord(value) || value.draftHash !== draftHash) return null;
  const evidence = jsonObjectFrom(value.evidence);
  const toolInventory = toolInventoryFrom(value.toolInventory);
  const resolvedArtifact = value.resolvedArtifact === null ? null : jsonObjectFrom(value.resolvedArtifact);
  if (!evidence || !toolInventory || (resolvedArtifact === null && value.resolvedArtifact !== null) ||
    typeof value.testedAt !== "string" || !Number.isFinite(Date.parse(value.testedAt))) {
    return null;
  }
  return {
    draftHash,
    evidence,
    identityHash: revisionIdentityHash({ draftHash, evidence, resolvedArtifact, toolInventory }),
    resolvedArtifact,
    testedAt: value.testedAt,
    toolInventory
  };
}

function revisionIdentityHash(input: Readonly<{
  draftHash: string;
  evidence: McpJsonObject;
  resolvedArtifact: McpJsonObject | null;
  toolInventory: readonly McpToolInventoryEntry[];
}>): string {
  return hashCanonicalMcpValue({
    draftHash: input.draftHash,
    evidence: input.evidence,
    resolvedArtifact: input.resolvedArtifact,
    toolInventory: input.toolInventory
      .map((tool) => ({ description: tool.description, name: tool.name }))
      .sort((left, right) => left.name.localeCompare(right.name))
  });
}

function storedRevisionIdentityHash(revision: RevisionRecord): string {
  const validation = validationEvidenceFrom(revision.validationEvidence, revision.createdAt);
  return revisionIdentityHash({
    draftHash: revision.draftHash,
    evidence: validation.evidence,
    resolvedArtifact: jsonObjectFrom(revision.resolvedArtifact),
    toolInventory: validation.toolInventory
  });
}

type RevisionRecord = {
  configuration: Prisma.JsonValue;
  createdAt: Date;
  draftHash: string;
  id: string;
  resolvedArtifact: Prisma.JsonValue | null;
  revisionNumber: number;
  runtimeGenerations?: { errorCode: string | null; state: string }[];
  validationEvidence: Prisma.JsonValue;
};

function revisionArtifactStatus(revision: RevisionRecord): McpRevisionSummary["artifactStatus"] {
  const configuration = draftFrom(revision.configuration);
  if (configuration.source.kind === "remote") return "not_applicable";
  if (!parseMcpLocalResolvedArtifact(revision.resolvedArtifact, configuration.source)) return "missing";
  const latest = revision.runtimeGenerations?.[0];
  if (latest?.errorCode === "mcp_artifact_missing") return "missing";
  if (latest?.state === "ready") return "available";
  return "unknown";
}

function serializeRevision(revision: RevisionRecord): McpRevisionSummary {
  return {
    artifactStatus: revisionArtifactStatus(revision),
    createdAt: revision.createdAt.toISOString(),
    draftHash: revision.draftHash,
    id: revision.id,
    identityHash: storedRevisionIdentityHash(revision),
    resolvedArtifact: jsonObjectFrom(revision.resolvedArtifact),
    revisionNumber: revision.revisionNumber,
    validationEvidence: validationEvidenceFrom(revision.validationEvidence, revision.createdAt)
  };
}

function jsonContainsString(value: McpJsonValue, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => jsonContainsString(item, needle));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) => key.includes(needle) || jsonContainsString(item, needle));
  }
  return false;
}

function valueIssues(
  slots: McpConfigurationSlot[],
  values: Record<string, McpSlotValue | null>,
  allowed: (slot: McpConfigurationSlot) => boolean
) {
  const byKey = new Map(slots.map((slot) => [slot.slotKey, slot]));
  return Object.entries(values).flatMap(([slotKey, value]) => {
    const slot = byKey.get(slotKey);
    if (!slot || !allowed(slot)) return [{ code: "slot_not_permitted", path: `values.${slotKey}` }];
    if (value !== null && !validateMcpSlotValue(slot, value)) {
      return [{ code: "slot_value_invalid", path: `values.${slotKey}` }];
    }
    return [];
  });
}

function namespace(): string {
  return `mcp_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

async function loadAdminServer(client: McpDataClient, serverId: string): Promise<AdminServerRecord | null> {
  return client.mcpServer.findUnique({ include: adminServerInclude, where: { id: serverId } });
}

function serializeAdminServer(
  record: AdminServerRecord,
  key: Buffer,
  oauthValidationRedirectUri?: (serverId: string) => string
): AdminMcpServer {
  const draft = draftFrom(record.draft);
  const draftHash = hashCanonicalMcpValue(draft);
  const draftTest = draftTestFrom(record.draftTestEvidence, record.testedDraftHash);
  const stored = readStoredValues(record.sharedConfigEnvelope, key);
  let validationOAuth: AdminServerRecord["oauthConnections"][number] | null =
    record.oauthConnections[0] ?? null;
  if (draft.auth.mode === "oauth" && oauthValidationRedirectUri) {
    try {
      validationOAuth = record.oauthConnections.find((connection) => connection.oauthClient &&
        connection.policyFingerprint === mcpOAuthPolicyFingerprint(
          buildMcpOAuthPolicy({
            configurationIdentity: draftHash,
            draft,
            purpose: "validation",
            redirectUri: oauthValidationRedirectUri(record.id),
            serverId: record.id,
            userId: connection.userId
          }),
          connection.oauthClient.clientId
        )) ?? null;
    } catch {
      validationOAuth = null;
    }
  }
  return {
    activePersonalSlots: record.activeRevision
      ? draftFrom(record.activeRevision.configuration).slots
          .filter((slot) => slot.policy.kind === "personal" ||
            (slot.policy.kind === "shared" && slot.policy.allowPersonalOverride))
          .map((slot) => ({ label: slot.label, slotKey: slot.slotKey }))
      : [],
    activeRevision: record.activeRevision ? serializeRevision(record.activeRevision) : null,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    description: record.description,
    draft,
    draftTest,
    draftTested: Boolean(draftTest && record.testedDraftHash === draftHash),
    enabled: record.enabled,
    grants: record.grants.map((grant) => ({
      canUse: grant.canUse,
      groupId: grant.groupId,
      groupName: grant.group?.name ?? null,
      id: grant.id,
      personalSlotKeys: grant.personalSlotKeys,
      userId: grant.userId,
      userName: grant.user?.displayName ?? null
    })),
    id: record.id,
    name: record.displayName,
    namespace: record.namespace,
    revisions: record.revisions.map(serializeRevision),
    sharedValues: Object.fromEntries(
      draft.slots
        .filter((slot) => slot.policy.kind === "shared")
        .map((slot) => [slot.slotKey, {
          configured: Object.hasOwn(stored.values, slot.slotKey),
          updatedAt: stored.updatedAt[slot.slotKey] ?? null
        }])
    ),
    updatedAt: record.updatedAt.toISOString(),
    validationOAuth: validationOAuth
      ? {
          accountLabel: validationOAuth.externalAccountLabel,
          connectedAt: validationOAuth.createdAt.toISOString(),
          state: validationOAuth.state
        }
      : null
  };
}

async function adminResult(
  client: McpDataClient,
  serverId: string,
  key: Buffer,
  oauthValidationRedirectUri?: (serverId: string) => string
): Promise<McpRepositoryResult<AdminMcpServer>> {
  const server = await loadAdminServer(client, serverId);
  return server
    ? { kind: "ok", value: serializeAdminServer(server, key, oauthValidationRedirectUri) }
    : { kind: "not_found" };
}

function toolInventory(value: Prisma.JsonValue | null): UserMcpServer["tools"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("tools" in value) ||
    !Array.isArray(value.tools) || value.tools.length > 512) return null;
  const tools = value.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool) || !("name" in tool) ||
      typeof tool.name !== "string") return [];
    const description = "description" in tool && typeof tool.description === "string" ? tool.description : null;
    return [{ description, name: tool.name }];
  });
  return tools.length === value.tools.length ? tools : null;
}

export function deriveKnownMcpToolCount(input: {
  revisionCreatedAt: Date;
  revisionValidationEvidence: Prisma.JsonValue;
  runtimeInventory: Prisma.JsonValue | null;
}): number {
  const runtimeInventory = toolInventory(input.runtimeInventory);
  return runtimeInventory?.length ?? validationEvidenceFrom(
    input.revisionValidationEvidence,
    input.revisionCreatedAt
  ).toolInventory.length;
}

export function deriveMcpUserReadiness(input: {
  enabled: boolean;
  hasInvalidValues: boolean;
  hasMissingValues: boolean;
  now: Date;
  oauthMode: boolean;
  oauthState: string | null;
  preferenceUpdatedAt: Date | null;
  runtime: { errorCode: string | null; inventory: Prisma.JsonValue | null; state: string } | null;
}): Pick<UserMcpServer, "errorCode" | "readiness" | "tools"> {
  if (!input.enabled) return { errorCode: null, readiness: "disabled", tools: [] };
  if (input.hasInvalidValues || input.hasMissingValues) {
    return { errorCode: "configuration_required", readiness: "needs_setup", tools: [] };
  }
  if (input.oauthMode && input.oauthState !== "ready") {
    return {
      errorCode: input.oauthState === "reauthorization_required" ? "oauth_reauthorization_required" : "oauth_required",
      readiness: input.oauthState === "reauthorization_required" ? "reauthorization_required" : "needs_authorization",
      tools: []
    };
  }
  if (!input.runtime) {
    const changedAt = input.preferenceUpdatedAt?.getTime() ?? input.now.getTime();
    const readiness = input.now.getTime() - changedAt <= MCP_QUEUE_GRACE_MS ? "queued" : "idle";
    return { errorCode: null, readiness, tools: [] };
  }
  if (input.runtime.state === "ready") {
    return { errorCode: null, readiness: "ready", tools: toolInventory(input.runtime.inventory) ?? [] };
  }
  if (input.runtime.state === "starting") return { errorCode: null, readiness: "starting", tools: [] };
  if (input.runtime.state === "idle") return { errorCode: null, readiness: "idle", tools: [] };
  if (input.runtime.state === "stopping") return { errorCode: null, readiness: "restarting", tools: [] };
  return { errorCode: input.runtime.errorCode ?? "runtime_unavailable", readiness: "unavailable", tools: [] };
}

type UserServerRecord = Prisma.McpServerGetPayload<{
  include: {
    activeRevision: true;
    grants: true;
    oauthConnections: { include: { oauthClient: { select: { clientId: true } } } };
    userServers: { include: { desiredRuntimeGeneration: true } };
  };
}>;

function serializeUserServer(input: {
  groupIds: string[];
  key: Buffer;
  oauthRedirectUri?: (serverId: string) => string;
  record: UserServerRecord;
  userId: string;
}): UserMcpServer | null {
  const direct = input.record.grants.find((grant) => grant.userId === input.userId) ?? null;
  const groups = input.record.grants.filter((grant) => grant.groupId && input.groupIds.includes(grant.groupId));
  const grant = resolveEffectiveMcpGrant({ direct, groups });
  if (!grant.canUse || !input.record.activeRevision) return null;

  const draft = draftFrom(input.record.activeRevision.configuration);
  const preference = input.record.userServers[0] ?? null;
  const shared = readStoredValues(input.record.sharedConfigEnvelope, input.key);
  const personal = readStoredValues(preference?.personalConfigEnvelope ?? null, input.key);
  const resolved = resolveEffectiveMcpValues({
    personalSlotKeys: grant.personalSlotKeys,
    personalValues: personal.values,
    personalVersion: preference?.personalConfigVersion ?? 0,
    sharedValues: shared.values,
    sharedVersion: input.record.sharedConfigVersion,
    slots: draft.slots
  });
  const fields: UserMcpConfigurationField[] = draft.slots.flatMap((slot) => {
    if (!grant.personalSlotKeys.has(slot.slotKey) ||
      (slot.policy.kind !== "personal" && !(slot.policy.kind === "shared" && slot.policy.allowPersonalOverride))) {
      return [];
    }
    const plan = resolved.plan.find((item) => item.slotKey === slot.slotKey)!;
    const field: UserMcpConfigurationField = {
      configured: plan.source !== "missing",
      label: slot.label,
      sensitive: slot.sensitive,
      slotKey: slot.slotKey,
      source: plan.source === "literal" ? "missing" : plan.source,
      valueType: slot.valueType,
      ...(slot.description ? { description: slot.description } : {}),
      ...(slot.enumValues ? { enumValues: slot.enumValues } : {}),
      ...(slot.maxLength !== undefined ? { maxLength: slot.maxLength } : {}),
      ...(slot.minLength !== undefined ? { minLength: slot.minLength } : {})
    };
    if (!slot.sensitive && plan.source === "personal" && Object.hasOwn(personal.values, slot.slotKey)) {
      field.value = personal.values[slot.slotKey];
    }
    return [field];
  });
  let oauth: UserServerRecord["oauthConnections"][number] | null =
    input.record.oauthConnections[0] ?? null;
  if (draft.auth.mode === "oauth" && input.oauthRedirectUri) {
    try {
      const policy = buildMcpOAuthPolicy({
        configurationIdentity: input.record.activeRevision.id,
        draft,
        purpose: "user",
        redirectUri: input.oauthRedirectUri(input.record.id),
        serverId: input.record.id,
        userId: input.userId
      });
      oauth = input.record.oauthConnections.find((connection) => connection.oauthClient &&
        connection.policyFingerprint === mcpOAuthPolicyFingerprint(
          policy,
          connection.oauthClient.clientId
        )) ?? null;
    } catch {
      oauth = null;
    }
  }
  const readiness = deriveMcpUserReadiness({
    enabled: preference?.enabled ?? false,
    hasInvalidValues: resolved.invalidSlotKeys.length > 0,
    hasMissingValues: resolved.missingSlotKeys.length > 0,
    now: new Date(),
    oauthMode: draft.auth.mode === "oauth",
    oauthState: oauth?.state ?? null,
    preferenceUpdatedAt: preference?.updatedAt ?? null,
    runtime: preference?.desiredRuntimeGeneration ?? null
  });
  return {
    accountLabel: oauth?.externalAccountLabel ?? null,
    description: input.record.description,
    enabled: preference?.enabled ?? false,
    fields,
    id: input.record.id,
    knownToolCount: deriveKnownMcpToolCount({
      revisionCreatedAt: input.record.activeRevision.createdAt,
      revisionValidationEvidence: input.record.activeRevision.validationEvidence,
      runtimeInventory: preference?.desiredRuntimeGeneration?.inventory ?? null
    }),
    name: input.record.displayName,
    oauthAvailable: draft.auth.mode === "oauth",
    oauthState: draft.auth.mode === "oauth" ? oauth?.state ?? "disconnected" : null,
    ...readiness
  };
}

async function groupIdsForUser(client: McpDataClient, userId: string): Promise<string[] | null> {
  const user = await client.user.findUnique({
    select: {
      groups: {
        select: { groupId: true },
        where: { group: { archivedAt: null } }
      }
    },
    where: { id: userId, status: "active" }
  });
  return user?.groups.map((membership) => membership.groupId) ?? null;
}

async function listUserServerRecords(
  client: McpDataClient,
  userId: string,
  groupIds: string[],
  serverId?: string
): Promise<UserServerRecord[]> {
  return client.mcpServer.findMany({
    include: {
      activeRevision: true,
      grants: {
        where: { OR: [{ userId }, ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])] }
      },
      oauthConnections: {
        include: { oauthClient: { select: { clientId: true } } },
        orderBy: { createdAt: "desc" },
        where: { purpose: "user", userId }
      },
      userServers: {
        include: { desiredRuntimeGeneration: true },
        take: 1,
        where: { userId }
      }
    },
    orderBy: { displayName: "asc" },
    where: {
      activeRevisionId: { not: null },
      archivedAt: null,
      enabled: true,
      ...(serverId ? { id: serverId } : {}),
      grants: {
        some: {
          canUse: true,
          OR: [{ userId }, ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])]
        }
      }
    }
  });
}

async function disableUsersWithoutEffectiveGrant(
  client: McpDataClient,
  serverId: string,
  userIds: string[]
): Promise<void> {
  for (const userId of userIds) {
    const groupIds = await groupIdsForUser(client, userId);
    if (!groupIds) continue;
    const stillGranted = await client.mcpGrant.count({
      where: {
        canUse: true,
        serverId,
        OR: [{ userId }, ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])]
      }
    });
    if (!stillGranted) {
      await client.mcpUserServer.updateMany({
        data: { desiredRuntimeGenerationId: null, enabled: false },
        where: { serverId, userId }
      });
    }
  }
}

function draftValidationValues(input: {
  draft: McpDraftConfiguration;
  oneTimeValues: Record<string, McpSlotValue>;
  sharedValues: Record<string, McpSlotValue>;
}): { issues: { code: string; path: string }[]; values: Record<string, McpSlotValue> } {
  const issues = valueIssues(
    input.draft.slots,
    input.oneTimeValues,
    (slot) => slot.policy.kind === "personal"
  ).map((issue) => ({ ...issue, path: issue.path.replace(/^values\./u, "oneTimeValues.") }));
  const values: Record<string, McpSlotValue> = {};
  for (const slot of input.draft.slots) {
    if (slot.policy.kind === "literal") {
      values[slot.slotKey] = slot.policy.value;
    } else if (slot.policy.kind === "shared" && Object.hasOwn(input.sharedValues, slot.slotKey)) {
      values[slot.slotKey] = input.sharedValues[slot.slotKey]!;
    } else if (slot.policy.kind === "personal" && Object.hasOwn(input.oneTimeValues, slot.slotKey)) {
      values[slot.slotKey] = input.oneTimeValues[slot.slotKey]!;
    } else {
      issues.push({ code: "slot_value_required", path: `oneTimeValues.${slot.slotKey}` });
    }
  }
  return { issues, values };
}

function validationResultContainsOneTimeSecret(input: {
  draft: McpDraftConfiguration;
  evidence: McpJsonObject;
  oneTimeValues: Record<string, McpSlotValue>;
  resolvedArtifact: McpJsonObject | null;
  toolInventory: readonly McpToolInventoryEntry[];
}): boolean {
  const output: McpJsonObject = {
    evidence: input.evidence,
    resolvedArtifact: input.resolvedArtifact,
    toolInventory: input.toolInventory.map((tool) => ({
      description: tool.description,
      name: tool.name
    }))
  };
  return input.draft.slots.some((slot) => {
    const value = input.oneTimeValues[slot.slotKey];
    return slot.sensitive && typeof value === "string" && value.length > 0 && jsonContainsString(output, value);
  });
}

async function lockMcpServer(tx: Prisma.TransactionClient, serverId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "McpServer"
    WHERE "id" = ${serverId}
      AND "archivedAt" IS NULL
    FOR UPDATE
  `;
  return rows.length === 1;
}

export function createPrismaMcpRepository(input: {
  draftValidator?: McpDraftValidator;
  encryptionKey?: () => Buffer;
  oauthRedirectUri?: (serverId: string) => string;
  oauthValidationRedirectUri?: (serverId: string) => string;
  prisma?: PrismaClient;
} = {}): McpRepository {
  const client = input.prisma ?? prisma;
  const draftValidator = input.draftValidator ?? unavailableMcpDraftValidator;
  const encryptionKey = input.encryptionKey ?? getMcpEncryptionKey;

  const repository: McpRepository = {
    activateDraft: async (serverId) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
        const server = await tx.mcpServer.findUnique({ where: { id: serverId } });
        if (!server) return { kind: "not_found" as const };
        const draft = draftFrom(server.draft);
        const draftHash = hashCanonicalMcpValue(draft);
        const draftTest = draftTestFrom(server.draftTestEvidence, server.testedDraftHash);
        if (!draftTest || server.testedDraftHash !== draftHash || draftTest.draftHash !== draftHash) {
          return { kind: "revision_required" as const };
        }

        const identityHash = revisionIdentityHash({
          draftHash,
          evidence: draftTest.evidence,
          resolvedArtifact: draftTest.resolvedArtifact,
          toolInventory: draftTest.toolInventory
        });
        const matchingRevisions = await tx.mcpRevision.findMany({
          select: {
            configuration: true,
            createdAt: true,
            draftHash: true,
            id: true,
            resolvedArtifact: true,
            revisionNumber: true,
            validationEvidence: true
          },
          where: { serverId }
        });
        const lineageIssues = slotLineageIssues(draft, matchingRevisions);
        if (lineageIssues.length) {
          return { issues: lineageIssues, kind: "draft_validation_failed" as const };
        }
        const existingRevision = matchingRevisions.find(
          (revision) => storedRevisionIdentityHash(revision) === identityHash
        );
        let revisionId = existingRevision?.id;
        if (!revisionId) {
          const latest = await tx.mcpRevision.aggregate({
            _max: { revisionNumber: true },
            where: { serverId }
          });
          const validationEvidence: McpValidationEvidence = {
            evidence: draftTest.evidence,
            testedAt: draftTest.testedAt,
            toolInventory: draftTest.toolInventory
          };
          const revision = await tx.mcpRevision.create({
            data: {
              configuration: draft as Prisma.InputJsonValue,
              draftHash,
              identityHash,
              revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
              serverId,
              validationEvidence: validationEvidence as Prisma.InputJsonValue,
              ...(draftTest.resolvedArtifact ? {
                resolvedArtifact: draftTest.resolvedArtifact as Prisma.InputJsonValue
              } : {})
            },
            select: { id: true }
          });
          revisionId = revision.id;
        }

        await tx.mcpServer.update({
          data: { activeRevisionId: revisionId, enabled: true },
          where: { id: serverId }
        });
        await tx.mcpUserServer.updateMany({
          data: { desiredRuntimeGenerationId: null },
          where: { enabled: true, serverId }
        });
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    deleteServer: async (serverId) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        const tombstoned = await tx.mcpServer.updateMany({
          data: { archivedAt: new Date(), enabled: false },
          where: { archivedAt: null, id: serverId }
        });
        if (tombstoned.count !== 1) return { kind: "not_found" as const };
        await tx.mcpUserServer.updateMany({
          data: { desiredRuntimeGenerationId: null, enabled: false },
          where: { serverId }
        });
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    createServer: async ({ description, draft, name, sharedValues }) => {
      const issues = valueIssues(draft.slots, sharedValues, (slot) => slot.policy.kind === "shared");
      if (issues.length) return { issues, kind: "invalid_values" };
      const key = encryptionKey();
      const now = new Date();
      const stored = applyStoredValuePatch(emptyStoredValues(), sharedValues, now);
      const server = await client.mcpServer.create({
        data: {
          description,
          displayName: name,
          draft: draft as Prisma.InputJsonValue,
          namespace: namespace(),
          sharedConfigEnvelope: Object.keys(stored.values).length ? encryptMcpEnvelope(stored, key) : null,
          sharedConfigVersion: Object.keys(sharedValues).length ? 1 : 0
        },
        select: { id: true }
      });
      return adminResult(client, server.id, key, input.oauthValidationRedirectUri);
    },

    listAdminServers: async () => {
      const key = encryptionKey();
      const records = await client.mcpServer.findMany({
        include: adminServerInclude,
        orderBy: { displayName: "asc" },
        where: { archivedAt: null }
      });
      return records.map((record) => serializeAdminServer(
        record,
        key,
        input.oauthValidationRedirectUri
      ));
    },

    listUserServers: async (userId) => {
      const groupIds = await groupIdsForUser(client, userId);
      if (!groupIds) return [];
      const key = encryptionKey();
      const records = await listUserServerRecords(client, userId, groupIds);
      return records.flatMap((record) => {
        const serialized = serializeUserServer({
          groupIds,
          key,
          record,
          userId,
          ...(input.oauthRedirectUri ? { oauthRedirectUri: input.oauthRedirectUri } : {})
        });
        return serialized ? [serialized] : [];
      });
    },

    rebuildRevision: async ({ oneTimeValues, replaceDraft, revisionId, serverId, validationUserId }) => {
      const prepared = await client.$transaction(async (tx) => {
        if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
        const [server, revision] = await Promise.all([
          tx.mcpServer.findUnique({ select: { draft: true }, where: { id: serverId } }),
          tx.mcpRevision.findFirst({
            select: { configuration: true },
            where: { id: revisionId, serverId }
          })
        ]);
        if (!server || !revision) return { kind: "not_found" as const };
        const selectedDraft = draftFrom(revision.configuration);
        const currentHash = hashCanonicalMcpValue(draftFrom(server.draft));
        const selectedHash = hashCanonicalMcpValue(selectedDraft);
        if (currentHash !== selectedHash && !replaceDraft) return { kind: "draft_changed" as const };
        await tx.mcpServer.update({
          data: {
            draft: selectedDraft as Prisma.InputJsonValue,
            draftTestEvidence: Prisma.DbNull,
            testedDraftHash: null
          },
          where: { id: serverId }
        });
        return { kind: "ok" as const };
      });
      if (prepared.kind !== "ok") return prepared;
      const tested = await repository.testDraft({
        oneTimeValues,
        serverId,
        ...(validationUserId ? { validationUserId } : {})
      });
      if (tested.kind !== "ok") return tested;
      return repository.activateDraft(serverId);
    },

    rollbackServer: async ({ revisionId, serverId }) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
        const revision = await tx.mcpRevision.findFirst({
          select: {
            configuration: true,
            createdAt: true,
            draftHash: true,
            id: true,
            resolvedArtifact: true,
            revisionNumber: true,
            runtimeGenerations: {
              orderBy: { updatedAt: "desc" },
              select: { errorCode: true, state: true },
              take: 1
            },
            validationEvidence: true
          },
          where: { id: revisionId, serverId }
        });
        if (!revision) return { kind: "not_found" as const };
        if (revisionArtifactStatus(revision) === "missing") {
          return { kind: "artifact_missing" as const };
        }
        await tx.mcpServer.update({
          data: { activeRevisionId: revision.id },
          where: { id: serverId }
        });
        await tx.mcpUserServer.updateMany({
          data: { desiredRuntimeGenerationId: null },
          where: { enabled: true, serverId }
        });
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    setGrant: async ({ canUse, groupId, personalSlotKeys, serverId, userId }) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        const server = await tx.mcpServer.findFirst({
          select: { activeRevision: { select: { configuration: true } }, draft: true, id: true },
          where: { archivedAt: null, id: serverId }
        });
        if (!server) return { kind: "not_found" as const };
        const configuration = server.activeRevision?.configuration ?? server.draft;
        const draft = draftFrom(configuration);
        const personalSlots = new Set(draft.slots
          .filter((slot) => slot.policy.kind === "personal" ||
            (slot.policy.kind === "shared" && slot.policy.allowPersonalOverride))
          .map((slot) => slot.slotKey));
        if (groupId && personalSlotKeys.length || personalSlotKeys.some((slotKey) => !personalSlots.has(slotKey))) {
          return {
            issues: [{ code: "personal_slot_not_permitted", path: "personalSlotKeys" }],
            kind: "invalid_grant" as const
          };
        }
        if (userId) {
          const user = await tx.user.findUnique({ select: { id: true }, where: { id: userId } });
          if (!user) return { issues: [{ code: "user_not_found", path: "userId" }], kind: "invalid_grant" as const };
        } else if (groupId) {
          const group = await tx.group.findUnique({ select: { id: true }, where: { id: groupId } });
          if (!group) return { issues: [{ code: "group_not_found", path: "groupId" }], kind: "invalid_grant" as const };
        }

        const where = userId ? { serverId_userId: { serverId, userId } } : { serverId_groupId: { groupId: groupId!, serverId } };
        if (!canUse && personalSlotKeys.length === 0) {
          if (userId) await tx.mcpGrant.deleteMany({ where: { serverId, userId } });
          else await tx.mcpGrant.deleteMany({ where: { groupId, serverId } });
        } else {
          await tx.mcpGrant.upsert({
            create: { canUse, groupId, personalSlotKeys, serverId, userId },
            update: { canUse, personalSlotKeys },
            where
          });
        }

        let affectedUserIds: string[];
        if (userId) {
          affectedUserIds = [userId];
        } else {
          const members = await tx.userGroup.findMany({ select: { userId: true }, where: { groupId: groupId! } });
          affectedUserIds = members.map((membership) => membership.userId);
        }
        if (affectedUserIds.length) {
          await tx.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null },
            where: { serverId, userId: { in: affectedUserIds } }
          });
        }
        await disableUsersWithoutEffectiveGrant(tx, serverId, affectedUserIds);
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    testDraft: async ({ expectedDraftHash, oneTimeValues, serverId, validationUserId }) => {
      const key = encryptionKey();
      const server = await client.mcpServer.findFirst({
        select: {
          draft: true,
          id: true,
          revisions: { select: { configuration: true } },
          sharedConfigEnvelope: true
        },
        where: { archivedAt: null, id: serverId }
      });
      if (!server) return { kind: "not_found" as const };
      const draft = draftFrom(server.draft);
      const draftHash = hashCanonicalMcpValue(draft);
      if (expectedDraftHash && draftHash !== expectedDraftHash) {
        return { kind: "draft_changed" as const };
      }
      const lineageIssues = slotLineageIssues(draft, server.revisions);
      if (lineageIssues.length) {
        return { issues: lineageIssues, kind: "draft_validation_failed" as const };
      }
      const sharedValues = readStoredValues(server.sharedConfigEnvelope, key);
      const validationInput = draftValidationValues({
        draft,
        oneTimeValues,
        sharedValues: sharedValues.values
      });
      if (validationInput.issues.length) {
        return { issues: validationInput.issues, kind: "invalid_values" as const };
      }

      const outcome = await draftValidator.validate({
        draft,
        serverId,
        ...(validationUserId ? { validationUserId } : {}),
        values: validationInput.values
      });
      if (outcome.kind === "invalid") {
        return { issues: outcome.issues, kind: "draft_validation_failed" as const };
      }
      const evidence = jsonObjectFrom(outcome.evidence);
      const resolvedArtifact = outcome.resolvedArtifact === null
        ? null
        : jsonObjectFrom(outcome.resolvedArtifact);
      const toolInventory = toolInventoryFrom(outcome.toolInventory);
      if (!evidence || !toolInventory || (outcome.resolvedArtifact !== null && !resolvedArtifact)) {
        return {
          issues: [{ code: "validator_result_invalid", path: "validator" }],
          kind: "draft_validation_failed" as const
        };
      }
      if (validationResultContainsOneTimeSecret({
        draft,
        evidence,
        oneTimeValues,
        resolvedArtifact,
        toolInventory
      })) {
        return {
          issues: [{ code: "unsafe_validation_evidence", path: "validator" }],
          kind: "draft_validation_failed" as const
        };
      }

      const testedAt = new Date().toISOString();
      const draftTestEvidence: McpDraftTestSummary = {
        draftHash,
        evidence,
        identityHash: revisionIdentityHash({ draftHash, evidence, resolvedArtifact, toolInventory }),
        resolvedArtifact,
        testedAt,
        toolInventory
      };
      return client.$transaction(async (tx) => {
        if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
        const current = await tx.mcpServer.findUnique({ select: { draft: true }, where: { id: serverId } });
        if (!current) return { kind: "not_found" as const };
        if (hashCanonicalMcpValue(draftFrom(current.draft)) !== draftHash) {
          return { kind: "draft_changed" as const };
        }
        await tx.mcpServer.update({
          data: {
            draftTestEvidence: draftTestEvidence as Prisma.InputJsonValue,
            testedDraftHash: draftHash
          },
          where: { id: serverId }
        });
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    updateServer: async ({ description, draft, enabled, name, serverId, sharedValues }) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        const existing = await tx.mcpServer.findFirst({ where: { archivedAt: null, id: serverId } });
        if (!existing) return { kind: "not_found" as const };
        if (enabled === true && !existing.activeRevisionId) return { kind: "revision_required" as const };
        const effectiveDraft = draft ?? draftFrom(existing.draft);
        if (sharedValues) {
          const issues = valueIssues(effectiveDraft.slots, sharedValues, (slot) => slot.policy.kind === "shared");
          if (issues.length) return { issues, kind: "invalid_values" as const };
        }
        const data: Prisma.McpServerUpdateInput = {};
        if (description !== undefined) data.description = description;
        if (name !== undefined) data.displayName = name;
        if (enabled !== undefined) data.enabled = enabled;
        if (draft && hashCanonicalMcpValue(draft) !== hashCanonicalMcpValue(draftFrom(existing.draft))) {
          data.draft = draft as Prisma.InputJsonValue;
          data.draftTestEvidence = Prisma.DbNull;
          data.testedDraftHash = null;
        }
        if (sharedValues && Object.keys(sharedValues).length) {
          const stored = applyStoredValuePatch(
            readStoredValues(existing.sharedConfigEnvelope, key),
            sharedValues,
            new Date()
          );
          data.sharedConfigEnvelope = Object.keys(stored.values).length ? encryptMcpEnvelope(stored, key) : null;
          data.sharedConfigVersion = { increment: 1 };
        }
        if (Object.keys(data).length) await tx.mcpServer.update({ data, where: { id: serverId } });
        if (enabled === false) {
          await tx.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null, enabled: false },
            where: { serverId }
          });
        } else if (sharedValues && Object.keys(sharedValues).length) {
          await tx.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null },
            where: { serverId, enabled: true }
          });
        }
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    updateUserServer: async ({ enabled, serverId, userId, values }) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        const groupIds = await groupIdsForUser(tx, userId);
        if (!groupIds) return { kind: "not_found" as const };
        const [record] = await listUserServerRecords(tx, userId, groupIds, serverId);
        if (!record || !record.activeRevision) return { kind: "not_found" as const };
        const direct = record.grants.find((grant) => grant.userId === userId) ?? null;
        const groups = record.grants.filter((grant) => grant.groupId && groupIds.includes(grant.groupId));
        const grant = resolveEffectiveMcpGrant({ direct, groups });
        if (!grant.canUse) return { kind: "not_found" as const };
        const draft = draftFrom(record.activeRevision.configuration);
        if (values) {
          const issues = valueIssues(draft.slots, values, (slot) => grant.personalSlotKeys.has(slot.slotKey) &&
            (slot.policy.kind === "personal" || (slot.policy.kind === "shared" && slot.policy.allowPersonalOverride)));
          if (issues.length) return { issues, kind: "invalid_values" as const };
        }
        const preference = record.userServers[0] ?? null;
        const personal = applyStoredValuePatch(
          readStoredValues(preference?.personalConfigEnvelope ?? null, key),
          values ?? {},
          new Date()
        );
        if (enabled === true) {
          const shared = readStoredValues(record.sharedConfigEnvelope, key);
          const resolved = resolveEffectiveMcpValues({
            personalSlotKeys: grant.personalSlotKeys,
            personalValues: personal.values,
            personalVersion: (preference?.personalConfigVersion ?? 0) + (values && Object.keys(values).length ? 1 : 0),
            sharedValues: shared.values,
            sharedVersion: record.sharedConfigVersion,
            slots: draft.slots
          });
          let oauthReady = draft.auth.mode !== "oauth";
          if (draft.auth.mode === "oauth") {
            const current = serializeUserServer({
              groupIds,
              key,
              record,
              userId,
              ...(input.oauthRedirectUri ? { oauthRedirectUri: input.oauthRedirectUri } : {})
            });
            oauthReady = current?.oauthState === "ready";
          }
          if (resolved.invalidSlotKeys.length || resolved.missingSlotKeys.length || !oauthReady) {
            const paths = [...resolved.invalidSlotKeys, ...resolved.missingSlotKeys]
              .map((slotKey) => ({ code: "slot_value_required", path: `values.${slotKey}` }));
            if (!oauthReady) paths.push({ code: "oauth_required", path: "oauth" });
            return { issues: paths, kind: "invalid_values" as const };
          }
        }
        const hasValuesPatch = Boolean(values && Object.keys(values).length);
        await tx.mcpUserServer.upsert({
          create: {
            enabled: enabled ?? false,
            personalConfigEnvelope: Object.keys(personal.values).length ? encryptMcpEnvelope(personal, key) : null,
            personalConfigVersion: hasValuesPatch ? 1 : 0,
            serverId,
            userId
          },
          update: {
            desiredRuntimeGenerationId: null,
            ...(enabled !== undefined ? { enabled } : {}),
            ...(hasValuesPatch ? {
              personalConfigEnvelope: Object.keys(personal.values).length ? encryptMcpEnvelope(personal, key) : null,
              personalConfigVersion: { increment: 1 }
            } : {})
          },
          where: { userId_serverId: { serverId, userId } }
        });
        const [updated] = await listUserServerRecords(tx, userId, groupIds, serverId);
        const serialized = updated ? serializeUserServer({
          groupIds,
          key,
          record: updated,
          userId,
          ...(input.oauthRedirectUri ? { oauthRedirectUri: input.oauthRedirectUri } : {})
        }) : null;
        return serialized ? { kind: "ok" as const, value: serialized } : { kind: "not_found" as const };
      });
    }
  };
  return repository;
}
