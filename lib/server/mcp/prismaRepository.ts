import { databaseFailureCode, retainDatabaseFailure } from "../observability/databaseFailure";
import { logEvent } from "../observability";
import { loadMcpToolAccess } from "./toolAccess";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  boundMcpToolDescription,
  isMcpInventoryDifferenceReason,
  isMcpToolName,
  MCP_INVENTORY_EXCLUSION_LIMIT,
  MCP_RUN_PLAN_LIMITS,
  MCP_SERVER_TOOL_LIMIT,
  mcpRuntimeErrorCode,
  mcpValidationIssue,
  PERSONAL_MCP_CONNECTION_LIMIT,
  safeMcpEndpoint
} from "@/lib/contracts/mcp";
import type {
  AdminMcpActivationSummary,
  AdminMcpInventoryDifference,
  AdminMcpServer,
  McpConfigurationSlot,
  McpDraftConfiguration,
  McpDraftTestSummary,
  McpJsonObject,
  McpJsonValue,
  McpRevisionSummary,
  McpSlotValue,
  McpToolInventoryEntry,
  McpUnavailableTool,
  McpValidationEvidence,
  McpValidationIssue,
  UserMcpConfigurationField,
  UserMcpServer
} from "@/lib/contracts/mcp";
import { prisma } from "@/lib/server/prisma";
import { resolveEffectiveMcpGrant, resolveEffectiveMcpValues } from "./access";
import { archivePersonalMcpServers } from "./personalArchive";
import {
  hashCanonicalMcpValue,
  mcpEndpointBinding,
  mcpPublishedToolDefinitions,
  mcpValuesForEndpoint,
  parseMcpEndpointBindings,
  validateMcpDraft,
  validateMcpSlotIdentityLineage,
  validateMcpSlotValue,
  type McpEndpointBinding
} from "./definitions";
import type { McpDraftValidator } from "./draftValidator";
import { unavailableMcpDraftValidator } from "./draftValidator";
import {
  decryptMcpEnvelope,
  encryptMcpEnvelope,
  getMcpEncryptionKey,
  mcpPersonalConfigEnvelopeContext,
  mcpSharedConfigEnvelopeContext,
  type McpEnvelopeContext
} from "./encryption";
import { buildMcpOAuthPolicy, mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import { correctedMcpDraft } from "./endpointCorrection";
import { McpEndpointBindingChangedError, rebindMcpValidationEndpoint } from "./oauthRepository";
import { parseMcpLocalResolvedArtifact } from "./localArtifact";
import { mcpInventoryExclusions } from "./runPlan";
import { nextPersonalMcpDisabledToolNames, personalMcpLiveTools } from "./personalCatalog";
import type {
  McpActivationClaim,
  McpActivationCoordinatorRepository,
  McpActivationPublishResult
} from "./activationCoordinator";
import type {
  McpRepository,
  McpRepositoryError,
  McpRepositoryResult,
  McpUserLimitKind,
  McpUserServerState
} from "./repositoryContract";

const adminServerInclude = {
  toolAccessPolicies: {
    include: { users: true, groups: true },
    orderBy: { toolName: "asc" as const }
  },
  activationJob: {
    select: {
      completedAt: true,
      errorCode: true,
      id: true,
      issues: true,
      requestedAt: true,
      stage: true,
      startedAt: true,
      updatedAt: true
    }
  },
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
        take: 1,
        // A member's current connection or the shared runtime Project runs use.
        where: {
          OR: [{ desiredFor: { enabled: true } }, { sharedDesiredFor: { isNot: null } }],
          state: "failed" as const
        }
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


type AdminServerRecord = Prisma.McpServerGetPayload<{ include: typeof adminServerInclude }>;
type McpDataClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "group" | "mcpGrant" | "mcpServer" | "mcpUserServer" | "user"
>;

type StoredValues = {
  endpoints: Record<string, McpEndpointBinding>;
  updatedAt: Record<string, string>;
  values: Record<string, McpSlotValue>;
  version: 1;
};

function emptyStoredValues(): StoredValues {
  return { endpoints: {}, updatedAt: {}, values: {}, version: 1 };
}

function isSlotValue(value: unknown): value is McpSlotValue {
  return typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function readStoredValues(
  envelope: string | null,
  key: Buffer,
  context?: McpEnvelopeContext
): StoredValues {
  if (!envelope) return emptyStoredValues();
  if (!context) throw new Error("mcp_values_invalid");
  const decoded = decryptMcpEnvelope<unknown>(envelope, key, context);
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
  const endpoints = parseMcpEndpointBindings(candidate.endpoints);
  if (!endpoints) throw new Error("mcp_values_invalid");
  return { endpoints, updatedAt, values, version: 1 };
}

// Every written value is bound to the destination its owner entered it for.
function applyStoredValuePatch(
  current: StoredValues,
  patch: Record<string, McpSlotValue | null>,
  now: Date,
  endpoint: McpEndpointBinding
): StoredValues {
  const endpoints = { ...current.endpoints };
  const values = { ...current.values };
  const updatedAt = { ...current.updatedAt };
  for (const [slotKey, value] of Object.entries(patch)) {
    if (value === null) {
      delete endpoints[slotKey];
      delete values[slotKey];
      delete updatedAt[slotKey];
    } else {
      endpoints[slotKey] = endpoint;
      values[slotKey] = value;
      updatedAt[slotKey] = now.toISOString();
    }
  }
  return { endpoints, updatedAt, values, version: 1 };
}

function valuesForEndpoint(
  stored: StoredValues,
  target: McpEndpointBinding,
  implicit: McpEndpointBinding | null
): Record<string, McpSlotValue> {
  return mcpValuesForEndpoint({ bindings: stored.endpoints, implicit, target, values: stored.values });
}

// Destination of unbound legacy values: the active revision, if any. An
// unreadable active revision matches no destination.
function implicitEndpointBinding(configuration: Prisma.JsonValue | null | undefined): McpEndpointBinding | null {
  if (configuration === null || configuration === undefined) return null;
  const parsed = validateMcpDraft(configuration);
  return parsed.ok ? mcpEndpointBinding(parsed.value) : { endpointHash: "", origin: "" };
}

function activeConfiguration(
  activeRevisionId: string | null,
  revisions: readonly Readonly<{ configuration: Prisma.JsonValue; id: string }>[]
): Prisma.JsonValue | null {
  return activeRevisionId
    ? revisions.find((revision) => revision.id === activeRevisionId)?.configuration ?? null
    : null;
}

/**
 * Before publication moves runtime use to another origin, record the previous
 * active destination on every unbound legacy value of the server, so those
 * values are never sent to the new origin. Versions stay unchanged: the values
 * themselves do not change.
 */
async function pinLegacyEndpointBindings(tx: Prisma.TransactionClient, input: Readonly<{
  key: Buffer;
  next: McpDraftConfiguration;
  previous: Prisma.JsonValue | null;
  serverId: string;
}>): Promise<void> {
  const previous = implicitEndpointBinding(input.previous);
  if (!previous || previous.origin === mcpEndpointBinding(input.next).origin) return;
  const pinned = (stored: StoredValues): StoredValues | null => {
    const unbound = Object.keys(stored.values).filter((slotKey) => !stored.endpoints[slotKey]);
    return unbound.length
      ? { ...stored, endpoints: { ...stored.endpoints, ...Object.fromEntries(unbound.map((slotKey) => [slotKey, previous])) } }
      : null;
  };
  const server = await tx.mcpServer.findUnique({
    select: { sharedConfigEnvelope: true, sharedConfigVersion: true },
    where: { id: input.serverId }
  });
  if (server?.sharedConfigEnvelope) {
    const context = mcpSharedConfigEnvelopeContext(input.serverId, server.sharedConfigVersion);
    const shared = pinned(readStoredValues(server.sharedConfigEnvelope, input.key, context));
    if (shared) {
      await tx.mcpServer.update({
        data: { sharedConfigEnvelope: encryptMcpEnvelope(shared, input.key, context) },
        where: { id: input.serverId }
      });
    }
  }
  const preferences = await tx.mcpUserServer.findMany({
    select: { id: true, personalConfigEnvelope: true, personalConfigVersion: true },
    where: { personalConfigEnvelope: { not: null }, serverId: input.serverId }
  });
  for (const preference of preferences) {
    const context = mcpPersonalConfigEnvelopeContext(preference.id, preference.personalConfigVersion);
    const personal = pinned(readStoredValues(preference.personalConfigEnvelope, input.key, context));
    if (!personal) continue;
    await tx.mcpUserServer.update({
      data: { personalConfigEnvelope: encryptMcpEnvelope(personal, input.key, context) },
      where: { id: preference.id }
    });
  }
}

function draftFrom(value: Prisma.JsonValue): McpDraftConfiguration {
  const result = validateMcpDraft(value);
  if (!result.ok) throw new Error("mcp_draft_invalid_in_storage");
  return result.value;
}

/** The one header slot a static-auth personal connection stores its credential in. */
const PERSONAL_AUTHORIZATION_SLOT_KEY = "authorization";

function personalAuthorizationSlot(
  draft: McpDraftConfiguration
): (McpConfigurationSlot & { target: { kind: "header"; name: string } }) | null {
  const slot = draft.slots.find((candidate) => candidate.slotKey === PERSONAL_AUTHORIZATION_SLOT_KEY);
  return slot && slot.target.kind === "header" && slot.policy.kind === "personal"
    ? slot as McpConfigurationSlot & { target: { kind: "header"; name: string } }
    : null;
}

function draftDefinitionHash(draft: McpDraftConfiguration): string {
  const { disabledToolNames: _disabledToolNames, ...definition } = draft;
  return hashCanonicalMcpValue(definition);
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
  if (!Array.isArray(value) || value.length > MCP_SERVER_TOOL_LIMIT) return null;
  const tools: McpToolInventoryEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" ||
      candidate.name.length === 0 || candidate.name.length > 256 ||
      (candidate.description !== null && typeof candidate.description !== "string") ||
      (typeof candidate.description === "string" && candidate.description.length > 4_000) ||
      (candidate.title !== undefined && (typeof candidate.title !== "string" ||
        candidate.title.length === 0)) ||
      (candidate.arguments !== undefined && !Array.isArray(candidate.arguments))) {
      return null;
    }
    const argumentsValue = candidate.arguments === undefined
      ? undefined
      : candidate.arguments.flatMap((argument) => {
          if (!isRecord(argument) || typeof argument.name !== "string" ||
            !argument.name ||
            (argument.description !== null && typeof argument.description !== "string") ||
            !Array.isArray(argument.types) || argument.types.length > 7 ||
            argument.types.some((type) => typeof type !== "string" || type.length > 32)) return [];
          return [{
            description: argument.description as string | null,
            name: argument.name,
            types: argument.types as string[]
          }];
        });
    if (candidate.arguments !== undefined && argumentsValue?.length !== candidate.arguments.length) {
      return null;
    }
    tools.push({
      ...(argumentsValue ? { arguments: argumentsValue } : {}),
      description: candidate.description as string | null,
      name: candidate.name,
      ...(typeof candidate.title === "string" ? { title: candidate.title } : {})
    });
  }
  return tools;
}

function activationIssuesFrom(value: unknown): McpValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.code !== "string" ||
      typeof candidate.path !== "string" || candidate.code.length > 128 ||
      candidate.path.length > 128) return [];
    return [mcpValidationIssue(candidate)];
  });
}

function serializeActivation(
  job: AdminServerRecord["activationJob"]
): AdminMcpActivationSummary | null {
  return job
    ? {
        completedAt: job.completedAt?.toISOString() ?? null,
        errorCode: job.errorCode,
        id: job.id,
        issues: activationIssuesFrom(job.issues),
        requestedAt: job.requestedAt.toISOString(),
        stage: job.stage,
        startedAt: job.startedAt?.toISOString() ?? null,
        updatedAt: job.updatedAt.toISOString()
      }
    : null;
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
      .map((tool) => ({
        ...(tool.arguments ? { arguments: tool.arguments } : {}),
        description: tool.description,
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {})
      }))
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
  const configuration = draftFrom(revision.configuration);
  return {
    artifactStatus: revisionArtifactStatus(revision),
    createdAt: revision.createdAt.toISOString(),
    ...(configuration.disabledToolNames?.length
      ? { disabledToolNames: configuration.disabledToolNames }
      : {}),
    draftHash: revision.draftHash,
    id: revision.id,
    identityHash: storedRevisionIdentityHash(revision),
    resolvedArtifact: jsonObjectFrom(revision.resolvedArtifact),
    revisionNumber: revision.revisionNumber,
    toolVerification: mcpPublishedToolDefinitions(revision.validationEvidence).kind,
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
  return client.mcpServer.findFirst({ include: adminServerInclude, where: { id: serverId, ownerUserId: null } });
}

const INVENTORY_DIFFERENCE_ORDER: Readonly<Record<AdminMcpInventoryDifference["reason"], number>> = {
  definition_drift: 0,
  missing_upstream: 1,
  unpublished_addition: 2
};

/**
 * What current connections of each server's active configuration hold back
 * from its checked tools, counted per connection. A connection is a member's
 * current runtime or the shared runtime Project runs use. Names of additions
 * seen only through personal or OAuth connections belong to those accounts and
 * are reported as a count. Each server keeps at most one runtime inventory's
 * exclusion bound of rows, in display order, so every name one connection
 * holds back fits.
 */
async function loadInventoryDifferences(
  client: McpDataClient,
  serverIds: readonly string[]
): Promise<Map<string, AdminMcpInventoryDifference[]>> {
  const differences = new Map<string, AdminMcpInventoryDifference[]>();
  if (!serverIds.length) return differences;
  const rows = await client.$queryRaw<Array<{
    connections: number;
    name: string | null;
    reason: string;
    serverId: string;
  }>>`
    SELECT ranked."serverId", ranked."name", ranked."reason", ranked."connections"
    FROM (
      SELECT grouped.*, ROW_NUMBER() OVER (
               PARTITION BY grouped."serverId"
               ORDER BY CASE grouped."reason" WHEN 'definition_drift' THEN 0 WHEN 'missing_upstream' THEN 1 ELSE 2 END,
                        grouped."name" COLLATE "C" NULLS LAST
             ) AS "position"
      FROM (
        SELECT difference."serverId", difference."name", difference."reason",
               COUNT(DISTINCT difference."generationId")::int AS "connections"
        FROM (
          SELECT connection."serverId",
                 connection."generationId",
                 exclusion.value->>'reason' AS "reason",
                 CASE
                   WHEN exclusion.value->>'reason' = 'unpublished_addition' AND connection."personal"
                   THEN NULL
                   ELSE exclusion.value->>'name'
                 END AS "name"
          FROM (
            SELECT preference."serverId" AS "serverId",
                   generation."id" AS "generationId",
                   generation."inventory" AS "inventory",
                   (
                     generation."oauthConnectionId" IS NOT NULL
                     OR preference."personalConfigEnvelope" IS NOT NULL
                     OR NOT (generation."credentialSources" <@ ARRAY['shared', 'none']::text[])
                   ) AS "personal"
            FROM "McpRuntimeGeneration" AS generation
            JOIN "McpUserServer" AS preference
              ON preference."id" = generation."userServerId"
             AND preference."desiredRuntimeGenerationId" = generation."id"
             AND preference."enabled" = true
            JOIN "McpServer" AS server
              ON server."id" = preference."serverId"
             AND server."activeRevisionId" = generation."revisionId"
            JOIN "User" AS owner
              ON owner."id" = preference."userId"
             AND owner."status" = 'active'
            WHERE generation."state" = 'ready'
              AND preference."serverId" IN (${Prisma.join(serverIds)})
            UNION ALL
            SELECT shared."serverId" AS "serverId",
                   generation."id" AS "generationId",
                   generation."inventory" AS "inventory",
                   (
                     generation."oauthConnectionId" IS NOT NULL
                     OR NOT (generation."credentialSources" <@ ARRAY['shared', 'none']::text[])
                   ) AS "personal"
            FROM "McpRuntimeGeneration" AS generation
            JOIN "McpSharedRuntime" AS shared
              ON shared."serverId" = generation."sharedServerId"
             AND shared."desiredRuntimeGenerationId" = generation."id"
            JOIN "McpServer" AS server
              ON server."id" = shared."serverId"
             AND server."activeRevisionId" = generation."revisionId"
            WHERE generation."state" = 'ready'
              AND shared."serverId" IN (${Prisma.join(serverIds)})
          ) AS connection
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(connection."inventory"->'exclusions') = 'array'
              THEN connection."inventory"->'exclusions'
              ELSE '[]'::jsonb
            END
          ) AS exclusion(value)
          WHERE exclusion.value->>'reason' IN ('definition_drift', 'missing_upstream', 'unpublished_addition')
        ) AS difference
        GROUP BY difference."serverId", difference."name", difference."reason"
      ) AS grouped
    ) AS ranked
    WHERE ranked."position" <= ${MCP_INVENTORY_EXCLUSION_LIMIT}
  `;
  for (const row of rows) {
    if (!isMcpInventoryDifferenceReason(row.reason) || !Number.isSafeInteger(row.connections) ||
      row.connections < 1) continue;
    const list = differences.get(row.serverId) ?? [];
    // A malformed name still counts; it is never echoed.
    list.push({ connections: row.connections, name: isMcpToolName(row.name) ? row.name : null, reason: row.reason });
    differences.set(row.serverId, list);
  }
  for (const list of differences.values()) {
    list.sort((left, right) =>
      INVENTORY_DIFFERENCE_ORDER[left.reason] - INVENTORY_DIFFERENCE_ORDER[right.reason] ||
      (left.name === right.name ? 0 : left.name === null ? 1 : right.name === null ? -1 : left.name < right.name ? -1 : 1));
  }
  return differences;
}

function serializeAdminServer(
  record: AdminServerRecord,
  key: Buffer,
  oauthValidationRedirectUri?: (serverId: string) => string,
  validationUserId?: string,
  inventoryDifferences: readonly AdminMcpInventoryDifference[] = []
): AdminMcpServer {
  const draft = draftFrom(record.draft);
  const draftHash = hashCanonicalMcpValue(draft);
  const draftTest = draftTestFrom(record.draftTestEvidence, record.testedDraftHash);
  const stored = readStoredValues(
    record.sharedConfigEnvelope,
    key,
    record.sharedConfigEnvelope
      ? mcpSharedConfigEnvelopeContext(record.id, record.sharedConfigVersion)
      : undefined
  );
  // Values entered for another origin read as unset until entered again.
  const draftSharedValues = valuesForEndpoint(
    stored,
    mcpEndpointBinding(draft),
    implicitEndpointBinding(record.activeRevision?.configuration)
  );
  const viewerConnections = record.oauthConnections.filter((connection) =>
    connection.userId === validationUserId);
  let validationOAuth: AdminServerRecord["oauthConnections"][number] | null =
    viewerConnections[0] ?? null;
  if (draft.auth.mode === "oauth" && oauthValidationRedirectUri) {
    try {
      validationOAuth = viewerConnections.find((connection) => connection.oauthClient &&
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
    toolAccess: record.toolAccessPolicies.map((policy) => ({
      name: policy.toolName,
      restricted: policy.restricted,
      userIds: policy.users.map(({ userId }) => userId).sort(),
      groupIds: policy.groups.map(({ groupId }) => groupId).sort()
    })),
    activation: serializeActivation(record.activationJob),
    activePersonalSlots: record.activeRevision
      ? draftFrom(record.activeRevision.configuration).slots
          .filter((slot) => slot.policy.kind === "personal" ||
            (slot.policy.kind === "shared" && slot.policy.allowPersonalOverride))
          .map((slot) => ({ label: slot.label, slotKey: slot.slotKey }))
      : [],
    activeRevision: record.activeRevision
      ? serializeRevision(record.revisions.find((revision) => revision.id === record.activeRevision!.id) ?? record.activeRevision)
      : null,
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
    inventoryDifferences: [...inventoryDifferences],
    name: record.displayName,
    namespace: record.namespace,
    revisions: record.revisions.map(serializeRevision),
    runtimeErrorCode: record.activeRevision?.runtimeGenerations[0]?.state === "failed"
      ? mcpRuntimeErrorCode(record.activeRevision.runtimeGenerations[0].errorCode) : null,
    runtimeProblem: record.activeRevision?.runtimeGenerations[0]?.state === "failed"
      ? record.activeRevision.runtimeGenerations[0].errorCode === "mcp_oauth_reauthorization_required"
        ? "reauthorization_required"
        : "unavailable"
      : null,
    sharedValues: Object.fromEntries(
      draft.slots
        .filter((slot) => slot.policy.kind === "shared")
        .map((slot) => [slot.slotKey, Object.hasOwn(draftSharedValues, slot.slotKey)
          ? { configured: true, updatedAt: stored.updatedAt[slot.slotKey] ?? null }
          : { configured: false, updatedAt: null }])
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
  if (!server) return { kind: "not_found" };
  const differences = await loadInventoryDifferences(client, [server.id]);
  return {
    kind: "ok",
    value: serializeAdminServer(server, key, oauthValidationRedirectUri, undefined, differences.get(server.id))
  };
}

function toolInventory(value: Prisma.JsonValue | null): UserMcpServer["tools"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("tools" in value) ||
    !Array.isArray(value.tools) || value.tools.length > MCP_SERVER_TOOL_LIMIT) return null;
  const tools = value.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool) || !("name" in tool) ||
      typeof tool.name !== "string") return [];
    const description = "description" in tool && typeof tool.description === "string" ? tool.description : null;
    return [{ description, name: tool.name }];
  });
  return tools.length === value.tools.length ? tools : null;
}

export function deriveKnownMcpToolCount(input: {
  toolAllowed?: (name: string) => boolean;
  disabledToolNames?: readonly string[];
  revisionCreatedAt: Date;
  revisionValidationEvidence: Prisma.JsonValue;
  runtimeInventory: Prisma.JsonValue | null;
}): number {
  const runtimeInventory = toolInventory(input.runtimeInventory);
  if (runtimeInventory) return runtimeInventory.filter((tool) => input.toolAllowed?.(tool.name) ?? true).length;
  const disabledToolNames = new Set(input.disabledToolNames ?? []);
  return validationEvidenceFrom(input.revisionValidationEvidence, input.revisionCreatedAt)
    .toolInventory.filter((tool) => !disabledToolNames.has(tool.name) && (input.toolAllowed?.(tool.name) ?? true)).length;
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
}): Pick<McpUserServerState, "errorCode" | "readiness" | "tools" | "unavailableTools"> {
  const none = { tools: [], unavailableTools: [] };
  if (!input.enabled) return { errorCode: null, readiness: "disabled", ...none };
  if (input.hasInvalidValues || input.hasMissingValues) {
    return { errorCode: "configuration_required", readiness: "needs_setup", ...none };
  }
  if (input.oauthMode && input.oauthState !== "ready") {
    return {
      errorCode: input.oauthState === "reauthorization_required" ? "oauth_reauthorization_required" : "oauth_required",
      readiness: input.oauthState === "reauthorization_required" ? "reauthorization_required" : "needs_authorization",
      ...none
    };
  }
  if (!input.runtime) {
    return { errorCode: null, readiness: "idle", ...none };
  }
  if (input.runtime.state === "ready") {
    // Every tool the runtime holds back is listed with its reason, never dropped.
    return {
      errorCode: null,
      readiness: "ready",
      tools: toolInventory(input.runtime.inventory) ?? [],
      unavailableTools: mcpInventoryExclusions(input.runtime.inventory) ?? []
    };
  }
  if (input.runtime.state === "starting") return { errorCode: null, readiness: "starting", ...none };
  if (input.runtime.state === "idle") return { errorCode: null, readiness: "idle", ...none };
  if (input.runtime.state === "stopping") return { errorCode: null, readiness: "restarting", ...none };
  return { errorCode: input.runtime.errorCode ?? "runtime_unavailable", readiness: "unavailable", ...none };
}

type UserServerRecord = Prisma.McpServerGetPayload<{
  include: {
    activeRevision: true;
    grants: true;
    oauthConnections: { include: { oauthClient: { select: { clientId: true } } } };
    userServers: { include: {
      desiredRuntimeGeneration: true;
      runtimeGenerations: {
        orderBy: { updatedAt: "desc" };
        take: 8;
        select: { inventory: true; oauthConnectionId: true; revisionId: true; state: true };
      };
    } };
  };
}>;

function serializeUserServer(input: {
  toolAllowed: (tool: import("./toolAccess").McpToolIdentity) => boolean;
  groupIds: string[];
  key: Buffer;
  oauthRedirectUri?: (serverId: string) => string;
  record: UserServerRecord;
  userId: string;
}): McpUserServerState | null {
  const direct = input.record.grants.find((grant) => grant.userId === input.userId) ?? null;
  const groups = input.record.grants.filter((grant) => grant.groupId && input.groupIds.includes(grant.groupId));
  const grant = resolveEffectiveMcpGrant({ direct, groups });
  if (input.record.ownerUserId && input.record.ownerUserId !== input.userId) return null;
  if ((input.record.ownerUserId !== input.userId && !grant.canUse) || !input.record.activeRevision) return null;

  const draft = draftFrom(input.record.activeRevision.configuration);
  const preference = input.record.userServers[0] ?? null;
  const shared = readStoredValues(
    input.record.sharedConfigEnvelope,
    input.key,
    input.record.sharedConfigEnvelope
      ? mcpSharedConfigEnvelopeContext(input.record.id, input.record.sharedConfigVersion)
      : undefined
  );
  const personal = readStoredValues(
    preference?.personalConfigEnvelope ?? null,
    input.key,
    preference?.personalConfigEnvelope
      ? mcpPersonalConfigEnvelopeContext(preference.id, preference.personalConfigVersion)
      : undefined
  );
  const endpoint = mcpEndpointBinding(draft);
  const personalValues = valuesForEndpoint(personal, endpoint, endpoint);
  const resolved = resolveEffectiveMcpValues({
    personalSlotKeys: grant.personalSlotKeys,
    personalValues,
    personalVersion: preference?.personalConfigVersion ?? 0,
    sharedValues: valuesForEndpoint(shared, endpoint, endpoint),
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
    if (!slot.sensitive && plan.source === "personal" && Object.hasOwn(personalValues, slot.slotKey)) {
      field.value = personalValues[slot.slotKey];
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
  const toolAllowed = (name: string) => input.toolAllowed({ serverId: input.record.id, originalName: name });
  const availability = userToolAvailability(readiness, toolAllowed);
  const personalOwner = input.record.ownerUserId === input.userId;
  const personalTools = personalOwner && preference ? personalSettingsTools(input.record, preference, input.userId, draft) : null;
  const availableTools = (personalTools?.availableTools ?? []).filter((tool) => toolAllowed(tool.name));
  return {
    accountLabel: oauth?.externalAccountLabel ?? null,
    description: input.record.description,
    enabled: preference?.enabled ?? false,
    ...(personalOwner ? { availableTools } : {}),
    ...(personalOwner ? { sourceType: "personal" as const } : { sourceType: "installation" as const }),
    ...(personalOwner && draft.source.kind === "remote"
      ? { endpoint: safeMcpEndpoint(draft.source.url) }
      : {}),
    ...(personalOwner ? { userDisabledToolNames: [...(personalTools?.disabled ?? [])].sort() } : {}),
    ...(personalOwner ? {
      authHeaderName: draft.auth.mode === "static" ? personalAuthorizationSlot(draft)?.target.name ?? null : null,
      authMode: draft.auth.mode
    } : {}),
    fields,
    id: input.record.id,
    knownToolCount: personalOwner
      ? availableTools.filter((tool) => !personalTools?.disabled.has(tool.name)).length
      : deriveKnownMcpToolCount({
          toolAllowed,
          disabledToolNames: draft.disabledToolNames,
          revisionCreatedAt: input.record.activeRevision.createdAt,
          revisionValidationEvidence: input.record.activeRevision.validationEvidence,
          runtimeInventory: preference?.desiredRuntimeGeneration?.inventory ?? null
        }),
    name: input.record.displayName,
    oauthAvailable: draft.auth.mode === "oauth",
    oauthState: draft.auth.mode === "oauth" ? oauth?.state ?? "disconnected" : null,
    runtimeGenerationId: preference?.desiredRuntimeGeneration?.id ?? null,
    ...readiness,
    ...availability,
    // A switched-off tool leaves the owner's runtime projection; Settings
    // still lists it in availableTools with its switch.
    ...(personalTools ? { tools: availability.tools.filter((tool) => !personalTools.disabled.has(tool.name)) } : {})
  };
}

/**
 * A personal owner's Settings inventory: the live tools the Auto catalog
 * offers, under the same OAuth-identity rule, plus the owner's switch-offs.
 */
function personalSettingsTools(
  record: UserServerRecord,
  preference: UserServerRecord["userServers"][number],
  userId: string,
  draft: McpDraftConfiguration
): { availableTools: UserMcpServer["tools"]; disabled: ReadonlySet<string> } {
  const current = preference.desiredRuntimeGeneration;
  const live = personalMcpLiveTools({
    activeRevisionId: record.activeRevision!.id,
    current: current?.userServerId === preference.id ? current : null,
    discovered: {
      inventory: preference.discoveredInventory,
      oauthConnectionId: preference.discoveredOAuthConnectionId,
      revisionId: preference.discoveredRevisionId
    },
    disabledByConfiguration: draft.disabledToolNames ?? [],
    oauthMode: draft.auth.mode === "oauth",
    readyOAuthConnectionIds: new Set(record.oauthConnections
      .filter((connection) => connection.userId === userId &&
        connection.state === "ready" && connection.disconnectRequestedAt === null)
      .map((connection) => connection.id)),
    recent: preference.runtimeGenerations
  });
  return {
    availableTools: live.map((tool) => ({ description: tool.description, name: tool.name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    disabled: new Set(preference.userDisabledToolNames)
  };
}

/**
 * This user's restriction outranks the runtime reason for a tool: after the
 * next check it would still be unavailable to them.
 */
function userToolAvailability(
  runtime: Pick<McpUserServerState, "tools" | "unavailableTools">,
  allowed: (name: string) => boolean
): Pick<McpUserServerState, "tools" | "unavailableTools"> {
  const unavailableTools: McpUnavailableTool[] = [
    ...runtime.tools.filter((tool) => !allowed(tool.name)).map((tool) => ({ name: tool.name, reason: "restricted" as const })),
    ...(runtime.unavailableTools ?? []).map((tool) => allowed(tool.name) ? tool : { name: tool.name, reason: "restricted" as const })
  ];
  return {
    tools: runtime.tools.filter((tool) => allowed(tool.name)),
    unavailableTools: unavailableTools.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
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
        include: {
          desiredRuntimeGeneration: true,
          runtimeGenerations: {
            orderBy: { updatedAt: "desc" },
            take: 8,
            select: { inventory: true, oauthConnectionId: true, revisionId: true, state: true }
          }
        },
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
      OR: [
        { ownerUserId: userId },
        { ownerUserId: null, grants: {
          some: {
            canUse: true,
            OR: [{ userId }, ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])]
          }
        } }
      ]
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

/**
 * Project runs stop using a server's shared runtime at the same transitions
 * that stop its members' runtimes: a new revision, new shared values,
 * disabling or deletion. The next Project run starts the current one.
 */
async function releaseSharedRuntime(
  client: Pick<Prisma.TransactionClient, "mcpSharedRuntime">,
  serverId: string
): Promise<void> {
  await client.mcpSharedRuntime.updateMany({
    data: { desiredRuntimeGenerationId: null },
    where: { serverId }
  });
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

function validationResultContainsSensitiveValue(input: {
  draft: McpDraftConfiguration;
  evidence: McpJsonObject;
  resolvedArtifact: McpJsonObject | null;
  toolInventory: readonly McpToolInventoryEntry[];
  values: Readonly<Record<string, McpSlotValue>>;
}): boolean {
  const output: McpJsonObject = {
    evidence: input.evidence,
    resolvedArtifact: input.resolvedArtifact,
    toolInventory: input.toolInventory.map((tool) => ({ ...tool }))
  };
  return input.draft.slots.some((slot) => {
    const value = input.values[slot.slotKey];
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

/**
 * Serializes one owner's personal creates, enables and disconnects with each
 * other and with account deletion and disabling, which hold the row FOR
 * UPDATE. NO KEY UPDATE leaves foreign-key checks (FOR KEY SHARE) free, so a
 * writer that locked a server first and then inserts a row referencing this
 * user cannot deadlock against it. Always taken before any server lock.
 */
async function lockMcpOwner(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}
    FOR NO KEY UPDATE
  `;
}

/**
 * A new personal connection is live and enabled at once. Enabled rows count as
 * the run plan counts them: every enabled preference of the user, across
 * installation and personal servers.
 */
async function personalCreationLimit(
  client: Pick<Prisma.TransactionClient, "mcpServer" | "mcpUserServer">,
  userId: string
): Promise<McpUserLimitKind | null> {
  const [live, enabled] = await Promise.all([
    client.mcpServer.count({ where: { archivedAt: null, ownerUserId: userId } }),
    client.mcpUserServer.count({ where: { enabled: true, userId } })
  ]);
  if (live >= PERSONAL_MCP_CONNECTION_LIMIT) return "personal_mcp_limit_reached";
  return enabled >= MCP_RUN_PLAN_LIMITS.maxEnabledServers ? "mcp_enabled_server_limit_reached" : null;
}

/** Only this row's false-to-true transition can push the user past the plan bound. */
async function enabledServerLimitReached(
  tx: Pick<Prisma.TransactionClient, "mcpUserServer">,
  userId: string,
  serverId: string
): Promise<boolean> {
  const others = await tx.mcpUserServer.count({
    where: { enabled: true, serverId: { not: serverId }, userId }
  });
  return others >= MCP_RUN_PLAN_LIMITS.maxEnabledServers;
}

const LIVE_ACTIVATION_STAGES = [
  "queued",
  "resolving",
  "preparing_runtime",
  "connecting",
  "discovering_tools",
  "publishing"
] as const;

function activationToken(): string {
  return randomUUID().replaceAll("-", "");
}

type ActivationEnqueueResult = { kind: "ok" } | McpRepositoryError;

/** Rolls back a credential replacement whose guarded write found a newer version. */
class PersonalCredentialsChangedError extends Error {
  constructor() {
    super("mcp_personal_credentials_changed");
    this.name = "PersonalCredentialsChangedError";
  }
}

export type PrismaMcpRepository = McpRepository & McpActivationCoordinatorRepository;

export function createPrismaMcpRepository(input: {
  draftValidator?: McpDraftValidator;
  encryptionKey?: () => Buffer;
  oauthRedirectUri?: (serverId: string) => string;
  oauthValidationRedirectUri?: (serverId: string) => string;
  prisma?: PrismaClient;
} = {}): PrismaMcpRepository {
  const client = input.prisma ?? prisma;
  const draftValidator = input.draftValidator ?? unavailableMcpDraftValidator;
  const encryptionKey = input.encryptionKey ?? getMcpEncryptionKey;

  async function enqueueActivationLocked(
    tx: Prisma.TransactionClient,
    serverId: string,
    validationUserId: string,
    key: Buffer,
    expectedDraftHash?: string
  ): Promise<ActivationEnqueueResult> {
    const [server, validationUser] = await Promise.all([
      tx.mcpServer.findUnique({
        include: {
          activationJob: true,
          revisions: { select: { configuration: true, id: true } }
        },
        where: { id: serverId }
      }),
      tx.user.findFirst({
        select: { id: true },
        where: { id: validationUserId, role: "admin", status: "active" }
      })
    ]);
    if (!server || server.archivedAt || server.ownerUserId !== null) return { kind: "not_found" };
    if (!validationUser) {
      return {
        issues: [{ code: "validation_identity_invalid", path: "activation" }],
        kind: "invalid_values"
      };
    }

    const draft = draftFrom(server.draft);
    const draftHash = hashCanonicalMcpValue(draft);
    if (expectedDraftHash && expectedDraftHash !== draftHash) return { kind: "draft_changed" };
    const lineageIssues = slotLineageIssues(draft, server.revisions);
    if (lineageIssues.length) {
      return { issues: lineageIssues, kind: "draft_validation_failed" };
    }
    const shared = readStoredValues(
      server.sharedConfigEnvelope,
      key,
      server.sharedConfigEnvelope
        ? mcpSharedConfigEnvelopeContext(server.id, server.sharedConfigVersion)
        : undefined
    );
    const validation = draftValidationValues({
      draft,
      oneTimeValues: {},
      sharedValues: valuesForEndpoint(
        shared,
        mcpEndpointBinding(draft),
        implicitEndpointBinding(activeConfiguration(server.activeRevisionId, server.revisions))
      )
    });
    if (validation.issues.length) {
      return { issues: validation.issues, kind: "invalid_values" };
    }

    const existing = server.activationJob;
    if (existing && LIVE_ACTIVATION_STAGES.includes(
      existing.stage as (typeof LIVE_ACTIVATION_STAGES)[number]
    ) && existing.draftHash === draftHash &&
      existing.sharedConfigVersion === server.sharedConfigVersion) {
      return { kind: "ok" };
    }

    await tx.mcpActivationJob.deleteMany({ where: { serverId } });
    await tx.mcpActivationJob.create({
      data: {
        draftHash,
        id: randomUUID(),
        serverId,
        sharedConfigVersion: server.sharedConfigVersion,
        validationUserId,
        workloadToken: activationToken()
      }
    });
    return { kind: "ok" };
  }

  async function activateDraftLocked(
    tx: Prisma.TransactionClient,
    serverId: string,
    key: Buffer
  ): Promise<McpRepositoryResult<AdminMcpServer>> {
    if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
    const server = await tx.mcpServer.findUnique({ where: { id: serverId } });
    if (!server || server.archivedAt || server.ownerUserId !== null) return { kind: "not_found" as const };
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

    await tx.mcpActivationJob.deleteMany({ where: { serverId } });
    await pinLegacyEndpointBindings(tx, {
      key,
      next: draft,
      previous: activeConfiguration(server.activeRevisionId, matchingRevisions),
      serverId
    });
    await tx.mcpServer.update({
      data: { activeRevisionId: revisionId, enabled: server.activeRevisionId ? server.enabled : true },
      where: { id: serverId }
    });
    await tx.mcpUserServer.updateMany({
      data: { desiredRuntimeGenerationId: null },
      where: { enabled: true, serverId }
    });
    await releaseSharedRuntime(tx, serverId);
    return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
  }

  const repository: PrismaMcpRepository = {
    activateDraft: async (serverId) => {
      const key = encryptionKey();
      return client.$transaction((tx) => activateDraftLocked(tx, serverId, key));
    },

    deletePersonalServer: async ({ serverId, userId }) => {
      return client.$transaction(async (tx) => {
        // Same order as creates and enables: the owner, then the server.
        await lockMcpOwner(tx, userId);
        if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
        const server = await tx.mcpServer.findFirst({ where: { archivedAt: null, id: serverId, ownerUserId: userId } });
        if (!server) return { kind: "not_found" as const };
        await archivePersonalMcpServers(tx, { now: new Date(), ownerUserId: userId, serverIds: [serverId] });
        return { kind: "ok" as const, value: {
          accountLabel: null,
          description: server.description,
          enabled: false,
          errorCode: null,
          fields: [],
          knownToolCount: 0,
          id: server.id,
          name: server.displayName,
          oauthAvailable: false,
          oauthState: null,
          readiness: "disabled" as const,
          runtimeErrorCode: null,
          runtimeGenerationId: null,
          tools: [],
          sourceType: "personal" as const
        } satisfies McpUserServerState };
      });
    },

    deleteServer: async (serverId) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        const now = new Date();
        const tombstoned = await tx.mcpServer.updateMany({
          data: { archivedAt: now, enabled: false },
          where: { archivedAt: null, id: serverId, ownerUserId: null }
        });
        if (tombstoned.count !== 1) return { kind: "not_found" as const };
        // Every stored token becomes a revocation obligation before the
        // archived server can be finalized.
        await tx.mcpOAuthConnection.updateMany({
          data: { disconnectRequestedAt: now, state: "disconnecting" },
          where: { serverId, state: { in: ["ready", "reauthorization_required"] } }
        });
        await tx.mcpActivationJob.deleteMany({ where: { serverId } });
        await tx.mcpUserServer.updateMany({
          data: { desiredRuntimeGenerationId: null, enabled: false },
          where: { serverId }
        });
        await releaseSharedRuntime(tx, serverId);
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    createPersonalServer: async ({ description, draft, name, userId, values }) => {
      const definition = validateMcpDraft(draft);
      if (!definition.ok) return { kind: "invalid_values" as const, issues: definition.issues };
      draft = definition.value;
      if (draft.source.kind !== "remote" || draft.transport !== "streamable_http") {
        return { kind: "invalid_values" as const, issues: [{ code: "personal_remote_required", path: "draft.source" }] };
      }
      const user = await client.user.findFirst({ select: { id: true }, where: { id: userId, status: "active" } });
      if (!user) return { kind: "not_found" as const };
      const validation = draftValidationValues({ draft, oneTimeValues: values, sharedValues: {} });
      if (validation.issues.length) return { kind: "invalid_values" as const, issues: validation.issues };
      // Advisory: never contact an endpoint for a connection the owner cannot add.
      const limited = await personalCreationLimit(client, userId);
      if (limited) return { kind: limited };
      const serverId = randomUUID();
      const outcome = draft.auth.mode === "oauth"
        ? {
            evidence: { endpointHash: hashCanonicalMcpValue({ origin: new URL(draft.source.url).origin, pathname: new URL(draft.source.url).pathname }), transport: "streamable_http" } as McpJsonObject,
            kind: "ok" as const,
            resolvedArtifact: null,
            toolInventory: [] as McpToolInventoryEntry[]
          }
        : await draftValidator.validate({ draft, serverId, validationUserId: userId, values: validation.values });
      if (outcome.kind === "invalid") return { kind: "draft_validation_failed" as const, issues: outcome.issues };
      const evidence = jsonObjectFrom(outcome.evidence);
      const resolvedArtifact = outcome.resolvedArtifact === null ? null : jsonObjectFrom(outcome.resolvedArtifact);
      const toolInventory = toolInventoryFrom(outcome.toolInventory);
      if (!evidence || !toolInventory || (outcome.resolvedArtifact !== null && !resolvedArtifact) ||
        validationResultContainsSensitiveValue({ draft, evidence, resolvedArtifact, toolInventory, values: validation.values })) {
        return { kind: "draft_validation_failed" as const, issues: [{ code: "validator_result_invalid", path: "validator" }] };
      }
      const checkedDraft = correctedMcpDraft(draft, outcome.endpointCorrection);
      if (!checkedDraft) return { kind: "draft_validation_failed" as const, issues: [{ code: "validator_result_invalid", path: "validator" }] };
      const draftHash = hashCanonicalMcpValue(checkedDraft);
      const identityHash = revisionIdentityHash({ draftHash, evidence, resolvedArtifact, toolInventory });
      const now = new Date();
      const key = encryptionKey();
      const preferenceId = randomUUID();
      const stored = applyStoredValuePatch(emptyStoredValues(), values, now, mcpEndpointBinding(checkedDraft));
      const personalKeys = checkedDraft.slots
        .filter((slot) => slot.policy.kind === "personal" || (slot.policy.kind === "shared" && slot.policy.allowPersonalOverride))
        .map((slot) => slot.slotKey);
      const revisionEvidence: McpValidationEvidence = { evidence, testedAt: now.toISOString(), toolInventory };
      const created = await client.$transaction(async (tx) => {
        // Creates, enables and account deletion of one owner serialize on the
        // user row; only under this lock are the limits authoritative.
        await lockMcpOwner(tx, userId);
        await tx.user.findFirstOrThrow({ select: { id: true }, where: { id: userId, status: "active" } });
        const limit = await personalCreationLimit(tx, userId);
        if (limit) return limit;
        const server = await tx.mcpServer.create({
          data: {
            description,
            displayName: name,
            draft: checkedDraft as Prisma.InputJsonValue,
            draftTestEvidence: { draftHash, evidence, identityHash, resolvedArtifact, testedAt: now.toISOString(), toolInventory } as Prisma.InputJsonValue,
            enabled: true,
            id: serverId,
            namespace: namespace(),
            ownerUserId: userId,
            testedDraftHash: draftHash
          },
          select: { id: true }
        });
        const revision = await tx.mcpRevision.create({
          data: {
            configuration: checkedDraft as Prisma.InputJsonValue,
            draftHash,
            identityHash,
            revisionNumber: 1,
            resolvedArtifact: resolvedArtifact ? resolvedArtifact as Prisma.InputJsonValue : Prisma.DbNull,
            serverId: server.id,
            validationEvidence: revisionEvidence as Prisma.InputJsonValue
          },
          select: { id: true }
        });
        await tx.mcpServer.update({ data: { activeRevisionId: revision.id }, where: { id: server.id } });
        await tx.mcpGrant.create({ data: { canUse: true, personalSlotKeys: personalKeys, serverId: server.id, userId } });
        await tx.mcpUserServer.create({
          data: {
            enabled: true,
            id: preferenceId,
            personalConfigEnvelope: Object.keys(stored.values).length
              ? encryptMcpEnvelope(stored, key, mcpPersonalConfigEnvelopeContext(preferenceId, 1))
              : null,
            personalConfigVersion: Object.keys(stored.values).length ? 1 : 0,
            // The validator's listing is the first observation of a non-OAuth
            // server, so Settings and Auto list its tools before a runtime is ready.
            ...(checkedDraft.auth.mode !== "oauth" ? {
              discoveredInventory: {
                tools: toolInventory.map((tool) => ({
                  description: tool.description === null ? null : boundMcpToolDescription(tool.description),
                  name: tool.name
                })),
                version: 1
              },
              discoveredOAuthConnectionId: null,
              discoveredRevisionId: revision.id
            } : {}),
            serverId: server.id,
            userId
          }
        });
        const groupIds = await groupIdsForUser(tx, userId);
        if (!groupIds) return null;
        const [record] = await listUserServerRecords(tx, userId, groupIds, server.id);
        return record ? serializeUserServer({
          toolAllowed: () => true,
          groupIds,
          key,
          record,
          userId
        }) : null;
      });
      if (typeof created === "string") return { kind: created };
      return created ? { kind: "ok" as const, value: created } : { kind: "not_found" as const };
    },

    replacePersonalCredentials: async ({ authorization, headerName, serverId, userId }) => {
      const user = await client.user.findFirst({ select: { id: true }, where: { id: userId, status: "active" } });
      if (!user) return { kind: "not_found" as const };
      // The state this replacement is validated against; the commit below
      // applies only while the connection is still exactly this state.
      const current = await client.mcpServer.findFirst({
        select: {
          activeRevision: { select: { configuration: true, id: true } },
          userServers: { select: { id: true, personalConfigVersion: true }, take: 1, where: { userId } }
        },
        where: { archivedAt: null, enabled: true, id: serverId, ownerUserId: userId }
      });
      const preference = current?.userServers[0];
      if (!current?.activeRevision || !preference) return { kind: "not_found" as const };
      const expectedRevisionId = current.activeRevision.id;
      const draft = draftFrom(current.activeRevision.configuration);
      const slot = personalAuthorizationSlot(draft);
      if (draft.auth.mode !== "static" || draft.source.kind !== "remote" || !slot) {
        return { kind: "auth_mode_invalid" as const };
      }
      const nextHeaderName = headerName ?? slot.target.name;
      const headerChanged = nextHeaderName !== slot.target.name;
      // Personal servers are exempt from slot lineage: the header and its only
      // value are replaced together, so no stored value meets a new target.
      const definition = validateMcpDraft(headerChanged ? {
        ...draft,
        slots: draft.slots.map((candidate) => candidate.slotKey === slot.slotKey
          ? { ...candidate, target: { kind: "header" as const, name: nextHeaderName } }
          : candidate)
      } : draft);
      if (!definition.ok) return { kind: "invalid_values" as const, issues: definition.issues };
      const nextDraft = definition.value;
      const values: Record<string, McpSlotValue> = { [slot.slotKey]: authorization };
      const validation = draftValidationValues({ draft: nextDraft, oneTimeValues: values, sharedValues: {} });
      if (validation.issues.length) return { kind: "invalid_values" as const, issues: validation.issues };
      const outcome = await draftValidator.validate({ draft: nextDraft, serverId, validationUserId: userId, values: validation.values });
      if (outcome.kind === "invalid") {
        // With the stored header name kept, a header that cannot be set is
        // caused by the value, which the validator reports at the slot target.
        return { kind: "draft_validation_failed" as const, issues: headerChanged ? outcome.issues : outcome.issues.map((issue) =>
          issue.code === "mcp_static_header_invalid" ? { ...issue, path: `values.${slot.slotKey}` } : issue) };
      }
      const evidence = jsonObjectFrom(outcome.evidence);
      const resolvedArtifact = outcome.resolvedArtifact === null ? null : jsonObjectFrom(outcome.resolvedArtifact);
      const toolInventory = toolInventoryFrom(outcome.toolInventory);
      // The URL is immutable: a credential that works only at a corrected
      // endpoint belongs to a new connection.
      if (!evidence || !toolInventory || outcome.endpointCorrection || (outcome.resolvedArtifact !== null && !resolvedArtifact) ||
        validationResultContainsSensitiveValue({ draft: nextDraft, evidence, resolvedArtifact, toolInventory, values: validation.values })) {
        return { kind: "draft_validation_failed" as const, issues: [{ code: "validator_result_invalid", path: "validator" }] };
      }
      const draftHash = hashCanonicalMcpValue(nextDraft);
      const identityHash = revisionIdentityHash({ draftHash, evidence, resolvedArtifact, toolInventory });
      const now = new Date();
      const key = encryptionKey();
      // Personal static connections hold exactly this one value; an unreadable
      // previous envelope never blocks its replacement.
      const stored = applyStoredValuePatch(emptyStoredValues(), values, now, mcpEndpointBinding(nextDraft));
      try {
        return await client.$transaction(async (tx) => {
          // Lock order: the owner first (shared with creates, enables and
          // disconnects), then the server, then its rows.
          await lockMcpOwner(tx, userId);
          if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
          const [owner, locked, row] = await Promise.all([
            tx.user.findFirst({ select: { id: true }, where: { id: userId, status: "active" } }),
            tx.mcpServer.findUnique({ select: { activeRevisionId: true, enabled: true, ownerUserId: true }, where: { id: serverId } }),
            tx.mcpUserServer.findUnique({ select: { id: true, personalConfigVersion: true }, where: { userId_serverId: { serverId, userId } } })
          ]);
          if (!owner || !locked || locked.ownerUserId !== userId || !locked.enabled || !row) return { kind: "not_found" as const };
          // Validated against an older state: never applied out of order.
          if (locked.activeRevisionId !== expectedRevisionId || row.id !== preference.id ||
            row.personalConfigVersion !== preference.personalConfigVersion) {
            return { kind: "credentials_changed" as const };
          }
          let revisionId = expectedRevisionId;
          if (headerChanged) {
            const existing = await tx.mcpRevision.findUnique({
              select: { id: true },
              where: { serverId_identityHash: { identityHash, serverId } }
            });
            if (existing) {
              revisionId = existing.id;
            } else {
              const latest = await tx.mcpRevision.aggregate({ _max: { revisionNumber: true }, where: { serverId } });
              const revisionEvidence: McpValidationEvidence = { evidence, testedAt: now.toISOString(), toolInventory };
              revisionId = (await tx.mcpRevision.create({
                data: {
                  configuration: nextDraft as Prisma.InputJsonValue,
                  draftHash,
                  identityHash,
                  revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
                  resolvedArtifact: resolvedArtifact ? resolvedArtifact as Prisma.InputJsonValue : Prisma.DbNull,
                  serverId,
                  validationEvidence: revisionEvidence as Prisma.InputJsonValue
                },
                select: { id: true }
              })).id;
            }
            await tx.mcpServer.update({
              data: {
                activeRevisionId: revisionId,
                draft: nextDraft as Prisma.InputJsonValue,
                draftTestEvidence: { draftHash, evidence, identityHash, resolvedArtifact, testedAt: now.toISOString(), toolInventory } as Prisma.InputJsonValue,
                testedDraftHash: draftHash
              },
              where: { id: serverId }
            });
          }
          const version = row.personalConfigVersion + 1;
          const written = await tx.mcpUserServer.updateMany({
            data: {
              // A new value version is a new runtime fingerprint: future
              // messages start the new generation, accepted runs keep theirs.
              desiredRuntimeGenerationId: null,
              discoveredInventory: {
                tools: toolInventory.map((tool) => ({
                  description: tool.description === null ? null : boundMcpToolDescription(tool.description),
                  name: tool.name
                })),
                version: 1
              },
              discoveredOAuthConnectionId: null,
              discoveredRevisionId: revisionId,
              personalConfigEnvelope: encryptMcpEnvelope(stored, key, mcpPersonalConfigEnvelopeContext(row.id, version)),
              personalConfigVersion: version
            },
            where: { id: row.id, personalConfigVersion: row.personalConfigVersion }
          });
          if (written.count !== 1) throw new PersonalCredentialsChangedError();
          const groupIds = await groupIdsForUser(tx, userId);
          if (!groupIds) return { kind: "not_found" as const };
          const [record] = await listUserServerRecords(tx, userId, groupIds, serverId);
          const serialized = record ? serializeUserServer({
            toolAllowed: await loadMcpToolAccess(userId, [serverId], tx),
            groupIds,
            key,
            record,
            userId,
            ...(input.oauthRedirectUri ? { oauthRedirectUri: input.oauthRedirectUri } : {})
          }) : null;
          return serialized ? { kind: "ok" as const, value: serialized } : { kind: "not_found" as const };
        });
      } catch (error) {
        if (error instanceof PersonalCredentialsChangedError) return { kind: "credentials_changed" as const };
        throw error;
      }
    },

    createServer: async ({
      activate,
      description,
      draft,
      name,
      sharedValues,
      validationUserId
    }) => {
      const issues = valueIssues(draft.slots, sharedValues, (slot) => slot.policy.kind === "shared");
      if (issues.length) return { issues, kind: "invalid_values" };
      const key = encryptionKey();
      const now = new Date();
      const stored = applyStoredValuePatch(emptyStoredValues(), sharedValues, now, mcpEndpointBinding(draft));
      if (activate) {
        const validation = draftValidationValues({
          draft,
          oneTimeValues: {},
          sharedValues: stored.values
        });
        if (validation.issues.length) {
          return { issues: validation.issues, kind: "invalid_values" };
        }
        if (!validationUserId) {
          return {
            issues: [{ code: "validation_identity_invalid", path: "activation" }],
            kind: "invalid_values"
          };
        }
      }
      const serverId = randomUUID();
      const sharedConfigVersion = Object.keys(sharedValues).length ? 1 : 0;
      return client.$transaction(async (tx) => {
        if (activate) {
          const validationUser = await tx.user.findFirst({
            select: { id: true },
            where: { id: validationUserId!, role: "admin", status: "active" }
          });
          if (!validationUser) {
            return {
              issues: [{ code: "validation_identity_invalid", path: "activation" }],
              kind: "invalid_values" as const
            };
          }
        }
        const server = await tx.mcpServer.create({
          data: {
            description,
            displayName: name,
            draft: draft as Prisma.InputJsonValue,
            id: serverId,
            namespace: namespace(),
            sharedConfigEnvelope: Object.keys(stored.values).length
              ? encryptMcpEnvelope(
                  stored,
                  key,
                  mcpSharedConfigEnvelopeContext(serverId, sharedConfigVersion)
                )
              : null,
            sharedConfigVersion
          },
          select: { id: true }
        });
        if (activate) {
          await tx.mcpActivationJob.create({
            data: {
              draftHash: hashCanonicalMcpValue(draft),
              id: randomUUID(),
              serverId: server.id,
              sharedConfigVersion,
              validationUserId: validationUserId!,
              workloadToken: activationToken()
            }
          });
        }
        return adminResult(tx, server.id, key, input.oauthValidationRedirectUri);
      });
    },

    listAdminServers: async (validationUserId) => {
      const key = encryptionKey();
      const records = await client.mcpServer.findMany({
        include: adminServerInclude,
        orderBy: { displayName: "asc" },
        where: { archivedAt: null, ownerUserId: null }
      });
      const differences = await loadInventoryDifferences(client, records.map((record) => record.id));
      return records.map((record) => serializeAdminServer(
        record,
        key,
        input.oauthValidationRedirectUri,
        validationUserId,
        differences.get(record.id)
      ));
    },

    listUserServers: async (userId) => {
      const groupIds = await groupIdsForUser(client, userId);
      if (!groupIds) return [];
      const key = encryptionKey();
      const records = await listUserServerRecords(client, userId, groupIds);
      const toolAllowed = await loadMcpToolAccess(userId, records.map(({ id }) => id), client);
      return records.flatMap((record) => {
        const serialized = serializeUserServer({
          toolAllowed,
          groupIds,
          key,
          record,
          userId,
          ...(input.oauthRedirectUri ? { oauthRedirectUri: input.oauthRedirectUri } : {})
        });
        return serialized ? [serialized] : [];
      });
    },

    personalCreationLimit: (userId) => personalCreationLimit(client, userId),

    rebuildRevision: async ({ oneTimeValues, replaceDraft, revisionId, serverId, validationUserId }) => {
      const prepared = await client.$transaction(async (tx) => {
        if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
        const [server, revision] = await Promise.all([
          tx.mcpServer.findFirst({ select: { draft: true }, where: { id: serverId, ownerUserId: null } }),
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
        await tx.mcpActivationJob.deleteMany({ where: { serverId } });
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

    enqueueLegacyToolRechecks: async () => {
      // The migration marks only the upgrade's existing servers. Consuming that
      // marker and recording the ordinary activation are one transaction, so a
      // restart cannot lose the work or repeatedly retry a failed upstream check.
      while (await client.$transaction(async (tx) => {
        const [candidate] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "McpServer"
          WHERE "legacyToolRecheckPending" = true
            AND "ownerUserId" IS NULL
          ORDER BY "id"
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
        if (!candidate) return false;
        const server = await tx.mcpServer.findUniqueOrThrow({
          include: { activeRevision: true, activationJob: true },
          where: { id: candidate.id }
        });
        await tx.mcpServer.update({ data: { legacyToolRecheckPending: false }, where: { id: server.id } });
        if (!server.enabled || server.archivedAt || !server.activeRevision ||
          mcpPublishedToolDefinitions(server.activeRevision.validationEvidence).kind !== "names") return true;
        if (server.activationJob && LIVE_ACTIVATION_STAGES.includes(
          server.activationJob.stage as (typeof LIVE_ACTIVATION_STAGES)[number]
        )) return true;

        const draft = draftFrom(server.draft);
        const draftHash = hashCanonicalMcpValue(draft);
        let validationUserId: string | undefined;
        if (draft.auth.mode === "oauth") {
          const connections = await tx.mcpOAuthConnection.findMany({
            include: { oauthClient: true },
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            where: {
              disconnectRequestedAt: null, purpose: "validation", serverId: server.id,
              state: "ready", tokenEnvelope: { not: null }, user: { role: "admin", status: "active" }
            }
          });
          validationUserId = connections.find((connection) => {
            if (!connection.oauthClient || !input.oauthValidationRedirectUri) return false;
            try {
              return connection.policyFingerprint === mcpOAuthPolicyFingerprint(buildMcpOAuthPolicy({
                configurationIdentity: draftHash, draft, purpose: "validation",
                redirectUri: input.oauthValidationRedirectUri(server.id), serverId: server.id, userId: connection.userId
              }), connection.oauthClient.clientId);
            } catch { return false; }
          })?.userId;
        } else {
          validationUserId = (await tx.user.findFirst({
            orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true },
            where: { role: "admin", status: "active" }
          }))?.id;
        }

        // An upgrade must not publish unrelated settings somebody left in a
        // draft. Existing manual Test & Save remains the recovery path.
        const result: ActivationEnqueueResult = draftHash !== server.activeRevision.draftHash
          ? { kind: "draft_changed" }
          : !validationUserId ? { kind: "invalid_values", issues: [{
              code: draft.auth.mode === "oauth" ? "mcp_oauth_validation_unavailable" : "validation_identity_invalid",
              path: draft.auth.mode === "oauth" ? "auth.mode" : "activation"
            }] }
          : await enqueueActivationLocked(tx, server.id, validationUserId, encryptionKey(), draftHash);
        if (result.kind === "ok") return true;
        await tx.mcpActivationJob.deleteMany({ where: { serverId: server.id } });
        await tx.mcpActivationJob.create({ data: {
          completedAt: new Date(), draftHash, errorCode: "mcp_draft_test_failed",
          issues: ("issues" in result ? result.issues : [{ code: "mcp_draft_changed", path: "draft" }]) as Prisma.InputJsonValue,
          serverId: server.id, sharedConfigVersion: server.sharedConfigVersion, stage: "failed",
          validationUserId, workloadToken: activationToken()
        } });
        return true;
      })) { /* Drain durable upgrade markers before normal activation claims. */ }
    },

    requestActivation: async ({ expectedDraftHash, serverId, validationUserId }) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
        const queued = await enqueueActivationLocked(
          tx,
          serverId,
          validationUserId,
          key,
          expectedDraftHash
        );
        if (queued.kind !== "ok") return queued;
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    claimActivation: async ({ now, staleBefore }) => {
      let invalidJobId: string | undefined;
      return client.$transaction(async (tx) => {
        const [candidate] = await tx.$queryRaw<Array<{
          id: string;
          leaseId: string | null;
          startedAt: Date | null;
        }>>`
          SELECT job."id", job."leaseId", job."startedAt"
          FROM "McpActivationJob" AS job
          JOIN "McpServer" AS server ON server."id" = job."serverId"
          WHERE job."stage" NOT IN ('ready', 'failed')
            AND (job."leaseId" IS NULL OR job."updatedAt" < ${staleBefore})
            AND server."archivedAt" IS NULL
            AND server."ownerUserId" IS NULL
          ORDER BY job."requestedAt" ASC
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
        `;
        if (!candidate) return null;

        const leaseId = randomUUID();
        const claimed = await tx.mcpActivationJob.update({
          data: {
            completedAt: null,
            errorCode: null,
            issues: Prisma.DbNull,
            leaseId,
            stage: candidate.leaseId ? "queued" : undefined,
            startedAt: candidate.startedAt ?? now,
            updatedAt: now,
            ...(candidate.leaseId ? { workloadToken: activationToken() } : {})
          },
          where: { id: candidate.id }
        });
        const server = await tx.mcpServer.findFirst({
          select: {
            activeRevisionId: true,
            archivedAt: true,
            draft: true,
            revisions: { select: { configuration: true, id: true } },
            sharedConfigEnvelope: true,
            sharedConfigVersion: true
          },
          where: { archivedAt: null, id: claimed.serverId, ownerUserId: null }
        });
        if (!server || hashCanonicalMcpValue(draftFrom(server.draft)) !== claimed.draftHash ||
          server.sharedConfigVersion !== claimed.sharedConfigVersion) {
          await tx.mcpActivationJob.deleteMany({ where: { id: claimed.id, leaseId } });
          return null;
        }
        const draft = draftFrom(server.draft);
        const lineageIssues = slotLineageIssues(draft, server.revisions);
        const shared = readStoredValues(
          server.sharedConfigEnvelope,
          encryptionKey(),
          server.sharedConfigEnvelope
            ? mcpSharedConfigEnvelopeContext(claimed.serverId, server.sharedConfigVersion)
            : undefined
        );
        const validation = draftValidationValues({
          draft,
          oneTimeValues: {},
          sharedValues: valuesForEndpoint(
            shared,
            mcpEndpointBinding(draft),
            implicitEndpointBinding(activeConfiguration(server.activeRevisionId, server.revisions))
          )
        });
        const issues = [...lineageIssues, ...validation.issues].slice(0, 20);
        if (issues.length) {
          invalidJobId = claimed.id;
          logEvent("job_attempt", { subsystem: "mcp", job_id: claimed.id, stage: "validate", outcome: "failed",
            code: "mcp_activation_values_invalid", count: issues.length, action: "fail" });
          await tx.mcpActivationJob.update({
            data: {
              completedAt: now,
              errorCode: "mcp_activation_values_invalid",
              issues: issues as Prisma.InputJsonValue,
              leaseId: null,
              stage: "failed",
              updatedAt: now
            },
            where: { id: claimed.id }
          });
          return null;
        }
        return {
          draft,
          id: claimed.id,
          leaseId,
          serverId: claimed.serverId,
          validationUserId: claimed.validationUserId,
          values: validation.values,
          workloadToken: claimed.workloadToken
        } satisfies McpActivationClaim;
      }).catch(retainDatabaseFailure).then((result) => {
        if (invalidJobId) logEvent("job_persistence", { subsystem: "mcp", job_id: invalidJobId, stage: "fail", outcome: "confirmed" });
        return result;
      }, (error: unknown) => {
        if (invalidJobId) logEvent("job_persistence", { subsystem: "mcp", job_id: invalidJobId, stage: "fail", outcome: "unconfirmed", prisma_code: databaseFailureCode(error) });
        throw error;
      });
    },

    heartbeatActivation: async ({ id, leaseId, now }) => {
      const updated = await client.mcpActivationJob.updateMany({
        data: { updatedAt: now },
        where: {
          id,
          leaseId,
          stage: { in: [...LIVE_ACTIVATION_STAGES] }
        }
      }).catch(retainDatabaseFailure);
      return updated.count === 1;
    },

    advanceActivation: async ({ id, leaseId, now, stage }) => {
      const updated = await client.mcpActivationJob.updateMany({
        data: { stage, updatedAt: now },
        where: {
          id,
          leaseId,
          stage: { in: [...LIVE_ACTIVATION_STAGES] }
        }
      }).catch(retainDatabaseFailure);
      return updated.count === 1;
    },

    failActivation: async ({ errorCode, id, issues, leaseId, now }) => {
      const updated = await client.mcpActivationJob.updateMany({
        data: {
          completedAt: now,
          errorCode,
          issues: issues.length ? issues as Prisma.InputJsonValue : Prisma.DbNull,
          leaseId: null,
          stage: "failed",
          updatedAt: now
        },
        where: {
          id,
          leaseId,
          stage: { in: [...LIVE_ACTIVATION_STAGES] }
        }
      }).catch(retainDatabaseFailure);
      return updated.count === 1;
    },

    publishActivation: async ({ claim, now, publication }): Promise<McpActivationPublishResult> => {
      return client.$transaction(async (tx): Promise<McpActivationPublishResult> => {
        if (!await lockMcpServer(tx, claim.serverId)) return { kind: "lease_lost" };
        const [job, server, validationUser] = await Promise.all([
          tx.mcpActivationJob.findFirst({
            where: {
              id: claim.id,
              leaseId: claim.leaseId,
              serverId: claim.serverId,
              stage: "publishing"
            }
          }),
          tx.mcpServer.findFirst({
            select: {
              activeRevisionId: true,
              draft: true,
              enabled: true,
              revisions: {
                select: {
                  configuration: true,
                  createdAt: true,
                  draftHash: true,
                  id: true,
                  resolvedArtifact: true,
                  revisionNumber: true,
                  validationEvidence: true
                }
              },
              sharedConfigVersion: true
            },
            where: { archivedAt: null, id: claim.serverId, ownerUserId: null }
          }),
          claim.validationUserId
            ? tx.user.findFirst({
                select: { id: true },
                where: { id: claim.validationUserId, role: "admin", status: "active" }
              })
            : Promise.resolve(null)
        ]);
        if (!job || !server || job.draftHash !== hashCanonicalMcpValue(draftFrom(server.draft)) ||
          job.sharedConfigVersion !== server.sharedConfigVersion) {
          return { kind: "lease_lost" };
        }
        if (!validationUser || job.validationUserId !== validationUser.id) {
          return {
            issues: [{ code: "validation_identity_invalid", path: "activation" }],
            kind: "invalid"
          };
        }

        const originalDraft = draftFrom(server.draft);
        const draft = correctedMcpDraft(originalDraft, publication.endpointCorrection);
        if (!draft) return { kind: "invalid", issues: [{ code: "validator_result_invalid", path: "validator" }] };
        const lineageIssues = slotLineageIssues(draft, server.revisions);
        if (lineageIssues.length) return { issues: lineageIssues, kind: "invalid" };
        const evidence = jsonObjectFrom(publication.evidence);
        const resolvedArtifact = publication.resolvedArtifact === null
          ? null
          : jsonObjectFrom(publication.resolvedArtifact);
        const inventory = toolInventoryFrom(publication.toolInventory);
        if (!evidence || !inventory ||
          (publication.resolvedArtifact !== null && !resolvedArtifact) ||
          validationResultContainsSensitiveValue({
            draft,
            evidence: evidence ?? {},
            resolvedArtifact,
            toolInventory: inventory ?? [],
            values: claim.values
          })) {
          return {
            issues: [{ code: "validator_result_invalid", path: "validator" }],
            kind: "invalid"
          };
        }

        const draftHash = hashCanonicalMcpValue(draft);
        const identityHash = revisionIdentityHash({
          draftHash,
          evidence,
          resolvedArtifact,
          toolInventory: inventory
        });
        const existingRevision = server.revisions.find(
          (revision) => storedRevisionIdentityHash(revision) === identityHash
        );
        const accepted = await tx.mcpActivationJob.updateMany({
          data: {
            completedAt: now,
            errorCode: null,
            issues: Prisma.DbNull,
            leaseId: null,
            stage: "ready",
            updatedAt: now
          },
          where: {
            id: claim.id,
            leaseId: claim.leaseId,
            serverId: claim.serverId,
            stage: "publishing"
          }
        });
        if (accepted.count !== 1) return { kind: "lease_lost" };
        if (publication.endpointCorrection) await rebindMcpValidationEndpoint({
          tx, key: encryptionKey(), serverId: claim.serverId, userId: claim.validationUserId,
          fromDraft: originalDraft, toDraft: draft, binding: publication.endpointCorrection.oauthBinding
        });

        let revisionId = existingRevision?.id;
        if (!revisionId) {
          const latestRevisionNumber = server.revisions.reduce(
            (latest, revision) => Math.max(latest, revision.revisionNumber),
            0
          );
          const validationEvidence: McpValidationEvidence = {
            evidence,
            testedAt: now.toISOString(),
            toolInventory: inventory
          };
          const revision = await tx.mcpRevision.create({
            data: {
              configuration: draft as Prisma.InputJsonValue,
              draftHash,
              identityHash,
              revisionNumber: latestRevisionNumber + 1,
              serverId: claim.serverId,
              validationEvidence: validationEvidence as Prisma.InputJsonValue,
              ...(resolvedArtifact ? {
                resolvedArtifact: resolvedArtifact as Prisma.InputJsonValue
              } : {})
            },
            select: { id: true }
          });
          revisionId = revision.id;
        }

        const draftTestEvidence: McpDraftTestSummary = {
          draftHash,
          evidence,
          identityHash,
          resolvedArtifact,
          testedAt: now.toISOString(),
          toolInventory: inventory
        };
        await pinLegacyEndpointBindings(tx, {
          key: encryptionKey(),
          next: draft,
          previous: activeConfiguration(server.activeRevisionId, server.revisions),
          serverId: claim.serverId
        });
        await tx.mcpServer.update({
          data: {
            activeRevisionId: revisionId,
            ...(publication.endpointCorrection ? { draft: draft as Prisma.InputJsonValue } : {}),
            draftTestEvidence: draftTestEvidence as Prisma.InputJsonValue,
            enabled: server.activeRevisionId ? server.enabled : true,
            testedDraftHash: draftHash
          },
          where: { id: claim.serverId }
        });
        await tx.mcpUserServer.updateMany({
          data: { desiredRuntimeGenerationId: null },
          where: { enabled: true, serverId: claim.serverId }
        });
        await releaseSharedRuntime(tx, claim.serverId);
        return { kind: "published" };
      }).catch((error) => {
        if (error instanceof McpEndpointBindingChangedError) {
          logEvent("job_attempt", { subsystem: "mcp", job_id: claim.id, stage: "publish", outcome: "stale", code: "mcp_draft_changed", action: "stop" });
          return { kind: "invalid" as const, issues: [{ code: "mcp_draft_changed", path: "auth.mode" }] };
        }
        throw error;
      }).catch(retainDatabaseFailure);
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
          where: { id: revisionId, serverId, server: { ownerUserId: null } }
        });
        if (!revision) return { kind: "not_found" as const };
        if (revisionArtifactStatus(revision) === "missing") {
          return { kind: "artifact_missing" as const };
        }
        await tx.mcpActivationJob.deleteMany({ where: { serverId } });
        const next = validateMcpDraft(revision.configuration);
        if (next.ok) {
          const current = await tx.mcpServer.findUnique({
            select: { activeRevision: { select: { configuration: true } } },
            where: { id: serverId, ownerUserId: null }
          });
          await pinLegacyEndpointBindings(tx, {
            key,
            next: next.value,
            previous: current?.activeRevision?.configuration ?? null,
            serverId
          });
        }
        await tx.mcpServer.update({
          data: { activeRevisionId: revision.id },
          where: { id: serverId }
        });
        await tx.mcpUserServer.updateMany({
          data: { desiredRuntimeGenerationId: null },
          where: { enabled: true, serverId }
        });
        await releaseSharedRuntime(tx, serverId);
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    setGrant: async ({ canUse, groupId, personalSlotKeys, serverId, userId }) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        const server = await tx.mcpServer.findFirst({
          select: { activeRevision: { select: { configuration: true } }, draft: true, id: true },
          where: { archivedAt: null, id: serverId, ownerUserId: null }
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
          const group = await tx.group.findUnique({
            select: { archivedAt: true, id: true, systemRole: true },
            where: { id: groupId }
          });
          if (!group) return { issues: [{ code: "group_not_found", path: "groupId" }], kind: "invalid_grant" as const };
          if (group.archivedAt) {
            return { issues: [{ code: "group_archived", path: "groupId" }], kind: "invalid_grant" as const };
          }
          if (group.systemRole === "full_access") {
            return {
              issues: [{ code: "system_group_grant_immutable", path: "groupId" }],
              kind: "invalid_grant" as const
            };
          }
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

    testDraft: async ({ description, draft: candidateDraft, expectedDraftHash, expectedUpdatedAt, name, oneTimeValues, publish, serverId, sharedValues, validationUserId }) => {
      const key = encryptionKey();
      if (!publish && (candidateDraft !== undefined || name !== undefined || description !== undefined)) {
        return { kind: "invalid_values" as const, issues: [{ code: "publication_required", path: "draft" }] };
      }
      if (publish && (!expectedUpdatedAt || !validationUserId || !await client.user.findFirst({
        select: { id: true },
        where: { id: validationUserId, role: "admin", status: "active" }
      }))) {
        return { kind: "invalid_values" as const, issues: [{ code: "validation_identity_invalid", path: "validation" }] };
      }
      const server = await client.mcpServer.findFirst({
        select: {
          activeRevisionId: true,
          draft: true,
          id: true,
          revisions: { select: { configuration: true, id: true } },
          sharedConfigEnvelope: true,
          sharedConfigVersion: true,
          updatedAt: true
        },
          where: { archivedAt: null, id: serverId, ownerUserId: null }
      });
      if (!server) return { kind: "not_found" as const };
      if (expectedUpdatedAt && server.updatedAt.toISOString() !== expectedUpdatedAt) {
        return { kind: "draft_changed" as const };
      }
      const storedDraftHash = hashCanonicalMcpValue(draftFrom(server.draft));
      let draft = candidateDraft ?? draftFrom(server.draft);
      let draftHash = hashCanonicalMcpValue(draft);
      if (expectedDraftHash && draftHash !== expectedDraftHash) {
        return { kind: "draft_changed" as const };
      }
      const lineageIssues = slotLineageIssues(draft, server.revisions);
      if (lineageIssues.length) {
        return { issues: lineageIssues, kind: "draft_validation_failed" as const };
      }
      if (sharedValues) {
        if (!publish) return { kind: "invalid_values" as const, issues: [{ code: "publication_required", path: "sharedValues" }] };
        const issues = valueIssues(draft.slots, sharedValues, (slot) => slot.policy.kind === "shared");
        if (issues.length) return { issues, kind: "invalid_values" as const };
      }
      const currentShared = readStoredValues(
        server.sharedConfigEnvelope,
        key,
        server.sharedConfigEnvelope
          ? mcpSharedConfigEnvelopeContext(server.id, server.sharedConfigVersion)
          : undefined
      );
      const patchedAt = new Date();
      const storedValues = applyStoredValuePatch(currentShared, sharedValues ?? {}, patchedAt, mcpEndpointBinding(draft));
      // The validator reaches the candidate endpoint: send only values entered for its origin.
      const validationInput = draftValidationValues({
        draft,
        oneTimeValues,
        sharedValues: valuesForEndpoint(
          storedValues,
          mcpEndpointBinding(draft),
          implicitEndpointBinding(activeConfiguration(server.activeRevisionId, server.revisions))
        )
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
      const originalDraft = draft;
      const corrected = correctedMcpDraft(draft, outcome.endpointCorrection);
      if (!corrected) return { kind: "draft_validation_failed" as const, issues: [{ code: "validator_result_invalid", path: "validator" }] };
      draft = corrected;
      draftHash = hashCanonicalMcpValue(draft);
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
      if (validationResultContainsSensitiveValue({
        draft,
        evidence,
        resolvedArtifact,
        toolInventory,
        values: validationInput.values
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
        const current = await tx.mcpServer.findUnique({
          select: { archivedAt: true, draft: true, sharedConfigVersion: true, updatedAt: true },
          where: { id: serverId, ownerUserId: null }
        });
        if (!current || current.archivedAt) return { kind: "not_found" as const };
        if (hashCanonicalMcpValue(draftFrom(current.draft)) !== storedDraftHash ||
          current.sharedConfigVersion !== server.sharedConfigVersion ||
          (publish && current.updatedAt.getTime() !== server.updatedAt.getTime())) {
          return { kind: "draft_changed" as const };
        }
        if (publish && !await tx.user.findFirst({
          select: { id: true },
          where: { id: validationUserId, role: "admin", status: "active" }
        })) {
          return { kind: "invalid_values" as const, issues: [{ code: "validation_identity_invalid", path: "validation" }] };
        }
        if (outcome.endpointCorrection) await rebindMcpValidationEndpoint({
          tx, key, serverId, userId: validationUserId, fromDraft: originalDraft, toDraft: draft,
          binding: outcome.endpointCorrection.oauthBinding
        });
        const sharedConfigVersion = current.sharedConfigVersion + 1;
        const sharedPatch = publish && sharedValues && Object.keys(sharedValues).length
          ? {
              sharedConfigVersion,
              sharedConfigEnvelope: Object.keys(storedValues.values).length
                ? encryptMcpEnvelope(
                    applyStoredValuePatch(currentShared, sharedValues, patchedAt, mcpEndpointBinding(draft)),
                    key,
                    mcpSharedConfigEnvelopeContext(serverId, sharedConfigVersion)
                  )
                : null
            }
          : {};
        await tx.mcpServer.update({
          data: {
            ...sharedPatch,
            ...(candidateDraft || outcome.endpointCorrection ? { draft: draft as Prisma.InputJsonValue } : {}),
            ...(name !== undefined ? { displayName: name } : {}),
            ...(description !== undefined ? { description } : {}),
            draftTestEvidence: draftTestEvidence as Prisma.InputJsonValue,
            testedDraftHash: draftHash
          },
          where: { id: serverId }
        });
        if (publish) {
          await tx.mcpActivationJob.deleteMany({ where: { serverId } });
          const activated = await activateDraftLocked(tx, serverId, key);
          // All expected conflicts were checked under this lock. An unexpected
          // publication failure must also roll back the credential/evidence write.
          if (activated.kind !== "ok") throw new Error("mcp_publication_failed");
          return activated;
        }
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      }).catch((error) => {
        if (error instanceof McpEndpointBindingChangedError) return { kind: "draft_changed" as const };
        throw error;
      });
    },

    updateServer: async ({
      toolAccess,
      tool,
      expectedUpdatedAt,
      description,
      draft,
      enabled,
      name,
      serverId,
      sharedValues
    }) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
        const existing = await tx.mcpServer.findFirst({ where: { archivedAt: null, id: serverId, ownerUserId: null } });
        if (!existing) return { kind: "not_found" as const };
        if (expectedUpdatedAt && existing.updatedAt.toISOString() !== expectedUpdatedAt) {
          return { kind: "draft_changed" as const };
        }
        if (enabled === true && !existing.activeRevisionId) return { kind: "revision_required" as const };
        const storedDraft = draftFrom(existing.draft);
        if (toolAccess) {
          if (!expectedUpdatedAt || tool || draft || sharedValues || name !== undefined || description !== undefined || enabled !== undefined) {
            return { kind: "draft_changed" as const };
          }
          const active = existing.activeRevisionId
            ? await tx.mcpRevision.findUnique({ where: { id: existing.activeRevisionId } })
            : null;
          if (!active) return { kind: "revision_required" as const };
          if (!validationEvidenceFrom(active.validationEvidence, active.createdAt).toolInventory
            .some(({ name }) => name === toolAccess.name)) {
            return { kind: "draft_validation_failed" as const, issues: [{ code: "tool_not_available", path: "toolAccess.name" }] };
          }
          const userIds = [...new Set(toolAccess.userIds)];
          const groupIds = [...new Set(toolAccess.groupIds)];
          const [users, groups] = await Promise.all([
            tx.user.count({ where: { id: { in: userIds } } }),
            tx.group.count({ where: { id: { in: groupIds } } })
          ]);
          if (users !== userIds.length || groups !== groupIds.length) {
            return { kind: "draft_validation_failed" as const, issues: [{ code: "subject_not_found", path: "toolAccess" }] };
          }
          const recipients = {
            users: { create: userIds.map((userId) => ({ userId })) },
            groups: { create: groupIds.map((groupId) => ({ groupId })) }
          };
          await tx.mcpToolAccessPolicy.upsert({
            where: { serverId_toolName: { serverId, toolName: toolAccess.name } },
            create: { serverId, toolName: toolAccess.name, restricted: toolAccess.restricted, ...recipients },
            update: {
              restricted: toolAccess.restricted,
              users: { deleteMany: {}, ...recipients.users },
              groups: { deleteMany: {}, ...recipients.groups }
            }
          });
          await tx.mcpServer.update({
            data: { updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)) },
            where: { id: serverId }
          });
          return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
        }
        if (tool) {
          if (!expectedUpdatedAt || draft || sharedValues || name !== undefined || description !== undefined || enabled !== undefined) {
            return { kind: "draft_changed" as const };
          }
          const active = existing.activeRevisionId
            ? await tx.mcpRevision.findUnique({ where: { id: existing.activeRevisionId } })
            : null;
          if (!active) return { kind: "revision_required" as const };
          const validation = validationEvidenceFrom(active.validationEvidence, active.createdAt);
          if (!validation.toolInventory.some(({ name }) => name === tool.name)) {
            return { kind: "draft_validation_failed" as const, issues: [{ code: "tool_not_available", path: "tool.name" }] };
          }
          const changeTool = (configuration: McpDraftConfiguration): McpDraftConfiguration => {
            const disabled = new Set(configuration.disabledToolNames ?? []);
            if (tool.enabled) disabled.delete(tool.name);
            else disabled.add(tool.name);
            return { ...configuration, disabledToolNames: [...disabled].sort() };
          };
          const configuration = changeTool(draftFrom(active.configuration));
          const draftHash = hashCanonicalMcpValue(configuration);
          const resolvedArtifact = active.resolvedArtifact === null ? null : jsonObjectFrom(active.resolvedArtifact);
          const identityHash = revisionIdentityHash({
            draftHash, evidence: validation.evidence, resolvedArtifact, toolInventory: validation.toolInventory
          });
          let revision = await tx.mcpRevision.findUnique({ where: { serverId_identityHash: { serverId, identityHash } } });
          if (!revision) {
            const latest = await tx.mcpRevision.aggregate({ _max: { revisionNumber: true }, where: { serverId } });
            revision = await tx.mcpRevision.create({ data: {
              configuration: configuration as Prisma.InputJsonValue,
              draftHash,
              identityHash,
              resolvedArtifact: resolvedArtifact ? resolvedArtifact as Prisma.InputJsonValue : Prisma.DbNull,
              revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
              serverId,
              validationEvidence: validation as Prisma.InputJsonValue
            } });
          }
          const nextDraft = changeTool(storedDraft);
          const nextDraftHash = hashCanonicalMcpValue(nextDraft);
          const previousTest = draftTestFrom(existing.draftTestEvidence, existing.testedDraftHash);
          const canReuseDraftTest = previousTest && existing.testedDraftHash === hashCanonicalMcpValue(storedDraft);
          await tx.mcpServer.update({ data: {
            activeRevisionId: revision.id,
            draft: nextDraft as Prisma.InputJsonValue,
            ...(canReuseDraftTest ? {
              draftTestEvidence: { ...previousTest, draftHash: nextDraftHash } as Prisma.InputJsonValue,
              testedDraftHash: nextDraftHash
            } : {})
          }, where: { id: serverId } });
          await tx.mcpActivationJob.deleteMany({ where: { serverId } });
          await tx.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null }, where: { enabled: true, serverId }
          });
          await releaseSharedRuntime(tx, serverId);
          return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
        }
        const effectiveDraft = draft ?? storedDraft;
        if (sharedValues) {
          const issues = valueIssues(effectiveDraft.slots, sharedValues, (slot) => slot.policy.kind === "shared");
          if (issues.length) return { issues, kind: "invalid_values" as const };
        }
        const data: Prisma.McpServerUpdateInput = {};
        const draftChanged = Boolean(
          draft && hashCanonicalMcpValue(draft) !== hashCanonicalMcpValue(storedDraft)
        );
        const policyOnlyDraftChange = Boolean(
          draftChanged && draft && draftDefinitionHash(draft) === draftDefinitionHash(storedDraft)
        );
        const sharedConfigChanged = Boolean(sharedValues && Object.keys(sharedValues).length);
        if (description !== undefined) data.description = description;
        if (name !== undefined) data.displayName = name;
        if (enabled !== undefined) data.enabled = enabled;
        if (draftChanged) {
          data.draft = draft as Prisma.InputJsonValue;
          if (!policyOnlyDraftChange) {
            data.draftTestEvidence = Prisma.DbNull;
            data.testedDraftHash = null;
          }
        }
        if (sharedConfigChanged) {
          const sharedConfigVersion = existing.sharedConfigVersion + 1;
          const stored = applyStoredValuePatch(
            readStoredValues(
              existing.sharedConfigEnvelope,
              key,
              existing.sharedConfigEnvelope
                ? mcpSharedConfigEnvelopeContext(existing.id, existing.sharedConfigVersion)
                : undefined
            ),
            sharedValues!,
            new Date(),
            mcpEndpointBinding(effectiveDraft)
          );
          data.sharedConfigEnvelope = Object.keys(stored.values).length
            ? encryptMcpEnvelope(
                stored,
                key,
                mcpSharedConfigEnvelopeContext(existing.id, sharedConfigVersion)
              )
            : null;
          data.sharedConfigVersion = sharedConfigVersion;
        }
        if (Object.keys(data).length) await tx.mcpServer.update({ data, where: { id: serverId, ownerUserId: null } });
        if (draftChanged || sharedConfigChanged) {
          await tx.mcpActivationJob.deleteMany({ where: { serverId } });
        } else if (enabled === false) {
          await tx.mcpActivationJob.deleteMany({
            where: { serverId, stage: { in: [...LIVE_ACTIVATION_STAGES] } }
          });
        }
        if (enabled === false) {
          await tx.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null, enabled: false },
            where: { serverId }
          });
          await releaseSharedRuntime(tx, serverId);
        } else if (sharedValues && Object.keys(sharedValues).length) {
          await tx.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null },
            where: { serverId, enabled: true }
          });
          await releaseSharedRuntime(tx, serverId);
        }
        return adminResult(tx, serverId, key, input.oauthValidationRedirectUri);
      });
    },

    updateUserServer: async ({ enabled, installationOnly, personalOnly, serverId, tool, userId, values }) => {
      const key = encryptionKey();
      return client.$transaction(async (tx) => {
        // Lock order: the owner first (serializes enables and personal creates),
        // then the server.
        await lockMcpOwner(tx, userId);
        if (!await lockMcpServer(tx, serverId)) return { kind: "not_found" as const };
        const groupIds = await groupIdsForUser(tx, userId);
        if (!groupIds) return { kind: "not_found" as const };
        const [record] = await listUserServerRecords(tx, userId, groupIds, serverId);
        if (!record || !record.activeRevision) return { kind: "not_found" as const };
        const direct = record.grants.find((grant) => grant.userId === userId) ?? null;
        const groups = record.grants.filter((grant) => grant.groupId && groupIds.includes(grant.groupId));
        const grant = resolveEffectiveMcpGrant({ direct, groups });
        if (record.ownerUserId && record.ownerUserId !== userId) return { kind: "not_found" as const };
        if (installationOnly && record.ownerUserId) return { kind: "not_found" as const };
        const personalOwner = record.ownerUserId === userId;
        if (personalOnly && !personalOwner) return { kind: "not_found" as const };
        if (!personalOwner && !grant.canUse) return { kind: "not_found" as const };
        const draft = draftFrom(record.activeRevision.configuration);
        const preference = record.userServers[0] ?? null;
        let userDisabledToolNames: string[] | null = null;
        if (tool) {
          if (!personalOwner || !isMcpToolName(tool.name)) {
            return { issues: [{ code: "tool_not_permitted", path: "tool.name" }], kind: "invalid_values" as const };
          }
          const current = serializeUserServer({
            toolAllowed: await loadMcpToolAccess(userId, [serverId], tx),
            groupIds, key, record, userId,
            ...(input.oauthRedirectUri ? { oauthRedirectUri: input.oauthRedirectUri } : {})
          });
          const liveToolNames = current?.availableTools?.map((candidate) => candidate.name) ?? [];
          if (!liveToolNames.includes(tool.name)) {
            return { issues: [{ code: "tool_not_available", path: "tool.name" }], kind: "invalid_values" as const };
          }
          userDisabledToolNames = nextPersonalMcpDisabledToolNames(preference?.userDisabledToolNames ?? [], tool, liveToolNames);
        }
        if (values) {
          const issues = valueIssues(draft.slots, values, (slot) => grant.personalSlotKeys.has(slot.slotKey) &&
            (slot.policy.kind === "personal" || (slot.policy.kind === "shared" && slot.policy.allowPersonalOverride)));
          if (issues.length) return { issues, kind: "invalid_values" as const };
        }
        const endpoint = mcpEndpointBinding(draft);
        const personal = applyStoredValuePatch(
          readStoredValues(
            preference?.personalConfigEnvelope ?? null,
            key,
            preference?.personalConfigEnvelope
              ? mcpPersonalConfigEnvelopeContext(preference.id, preference.personalConfigVersion)
              : undefined
          ),
          values ?? {},
          new Date(),
          endpoint
        );
        // An already-enabled row (for example the OAuth settle) passes unchanged.
        if (enabled === true && !preference?.enabled && await enabledServerLimitReached(tx, userId, serverId)) {
          return { kind: "mcp_enabled_server_limit_reached" as const };
        }
        if (enabled === true) {
          const shared = readStoredValues(
            record.sharedConfigEnvelope,
            key,
            record.sharedConfigEnvelope
              ? mcpSharedConfigEnvelopeContext(record.id, record.sharedConfigVersion)
              : undefined
          );
          const resolved = resolveEffectiveMcpValues({
            personalSlotKeys: grant.personalSlotKeys,
            personalValues: valuesForEndpoint(personal, endpoint, endpoint),
            personalVersion: (preference?.personalConfigVersion ?? 0) + (values && Object.keys(values).length ? 1 : 0),
            sharedValues: valuesForEndpoint(shared, endpoint, endpoint),
            sharedVersion: record.sharedConfigVersion,
            slots: draft.slots
          });
          let oauthReady = draft.auth.mode !== "oauth";
          if (draft.auth.mode === "oauth") {
            const current = serializeUserServer({
              toolAllowed: await loadMcpToolAccess(userId, [serverId], tx),
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
        const preferenceId = preference?.id ?? randomUUID();
        const personalConfigVersion = (preference?.personalConfigVersion ?? 0) + (hasValuesPatch ? 1 : 0);
        const personalConfigEnvelope = Object.keys(personal.values).length
          ? encryptMcpEnvelope(
              personal,
              key,
              mcpPersonalConfigEnvelopeContext(preferenceId, personalConfigVersion)
            )
          : null;
        // Switching a tool is a projection change: the runtime and its desired
        // generation stay, so accepted runs and the next run keep dispatching.
        const toolSwitchOnly = tool !== undefined && enabled === undefined && values === undefined;
        await tx.mcpUserServer.upsert({
          create: {
            enabled: enabled ?? false,
            id: preferenceId,
            personalConfigEnvelope,
            personalConfigVersion,
            ...(userDisabledToolNames !== null ? { userDisabledToolNames } : {}),
            serverId,
            userId
          },
          update: {
            ...(toolSwitchOnly ? {} : { desiredRuntimeGenerationId: null }),
            ...(enabled !== undefined ? { enabled } : {}),
            ...(userDisabledToolNames !== null ? { userDisabledToolNames } : {}),
            ...(hasValuesPatch ? {
              personalConfigEnvelope,
              personalConfigVersion
            } : {})
          },
          where: { userId_serverId: { serverId, userId } }
        });
        const [updated] = await listUserServerRecords(tx, userId, groupIds, serverId);
        const serialized = updated ? serializeUserServer({
          toolAllowed: await loadMcpToolAccess(userId, [serverId], tx),
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
