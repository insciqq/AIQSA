import { randomUUID } from "node:crypto";
import {
  Prisma,
  type McpOAuthConnectionState,
  type PrismaClient
} from "@prisma/client";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { prisma } from "@/lib/server/prisma";
import { resolveEffectiveMcpGrant } from "./access";
import { hashCanonicalMcpValue, validateMcpDraft } from "./definitions";
import {
  decryptMcpEnvelope,
  encryptMcpEnvelope,
  getMcpEncryptionKey,
  mcpOAuthClientSecretEnvelopeContext,
  mcpOAuthTokenEnvelopeContext
} from "./encryption";
import {
  buildMcpOAuthPolicy,
  mcpOAuthPolicyFingerprint,
  type McpOAuthPolicy,
  type McpOAuthPurpose
} from "./oauthPolicy";

const ACTIVE_RUN_STATUSES = ["queued", "streaming", "in_progress"] as const;
const MAX_OAUTH_ENVELOPE_JSON_BYTES = 512 * 1_024;

type StoredClientMetadata = {
  clientInformation: Record<string, unknown>;
  clientMetadata: OAuthClientMetadata;
  discoveryState: OAuthDiscoveryState;
  version: 1;
};

type StoredTokenEnvelope = {
  issuedAt: string;
  policy: McpOAuthPolicy;
  tokens: OAuthTokens;
  version: 1;
};

export type McpOAuthStoredClient = Readonly<{
  clientInformation: OAuthClientInformationMixed;
  clientMetadata: OAuthClientMetadata;
  discoveryState: OAuthDiscoveryState;
  id: string;
  registrationKey: string;
}>;

export type McpOAuthStoredConnection = Readonly<{
  client: McpOAuthStoredClient;
  expiresAt: Date | null;
  externalAccountLabel: string | null;
  id: string;
  policy: McpOAuthPolicy;
  policyFingerprint: string;
  purpose: McpOAuthPurpose;
  scopes: readonly string[];
  state: McpOAuthConnectionState;
  tokenVersion: string;
  tokens: OAuthTokens;
  userId: string;
}>;

export type McpOAuthRepositoryResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "configuration_changed" }
  | { kind: "not_found" };

export interface McpOAuthRepository {
  createConnection(input: Readonly<{
    clientId: string;
    configurationIdentity: string;
    externalAccountLabel: string | null;
    oauthClientId: string;
    policyFingerprint: string;
    purpose: McpOAuthPurpose;
    redirectUri: string;
    serverId: string;
    tokens: OAuthTokens;
    userId: string;
  }>): Promise<McpOAuthRepositoryResult<McpOAuthStoredConnection>>;
  finalizeDisconnected(connectionId: string): Promise<boolean>;
  findClient(registrationKey: string): Promise<McpOAuthStoredClient | null>;
  findReadyConnection(input: Readonly<{
    policyFingerprint: string;
    purpose: McpOAuthPurpose;
    serverId: string;
    userId: string;
  }>): Promise<McpOAuthStoredConnection | null>;
  findLatestReadyConnection(input: Readonly<{
    purpose: McpOAuthPurpose;
    serverId: string;
    userId: string;
  }>): Promise<McpOAuthStoredConnection | null>;
  hasActiveRunBindings(connectionId: string): Promise<boolean>;
  listDisconnectingConnectionIds(): Promise<string[]>;
  loadConnection(connectionId: string): Promise<McpOAuthStoredConnection | null>;
  prepareValidationPolicy(input: Readonly<{
    redirectUri: string;
    serverId: string;
    userId: string;
  }>): Promise<McpOAuthPolicy | null>;
  requestDisconnectForIneligibleConnections(): Promise<number>;
  loadPolicy(input: Readonly<{
    purpose: McpOAuthPurpose;
    redirectUri: string;
    serverId: string;
    userId: string;
  }>): Promise<McpOAuthPolicy | null>;
  markReauthorizationRequired(input: Readonly<{
    connectionId: string;
    tokenVersion: string;
  }>): Promise<boolean>;
  requestDisconnect(input: Readonly<{
    purpose: McpOAuthPurpose;
    serverId: string;
    userId: string;
  }>): Promise<McpOAuthStoredConnection | null>;
  rotateTokens(input: Readonly<{
    connectionId: string;
    expectedTokenVersion: string;
    tokens: OAuthTokens;
  }>): Promise<McpOAuthStoredConnection | null>;
  saveClient(input: Readonly<{
    clientInformation: OAuthClientInformationMixed;
    clientMetadata: OAuthClientMetadata;
    discoveryState: OAuthDiscoveryState;
    registrationKey: string;
  }>): Promise<McpOAuthStoredClient>;
}

type OAuthPrismaClient = Pick<
  Prisma.TransactionClient,
  | "mcpOAuthClient"
  | "mcpOAuthConnection"
  | "mcpRuntimeGeneration"
  | "mcpServer"
  | "mcpUserServer"
  | "user"
>;

const oauthEligibilitySelect = {
  id: true,
  oauthClient: { select: { clientId: true } },
  policyFingerprint: true,
  purpose: true,
  server: {
    select: {
      activeRevision: { select: { configuration: true, id: true } },
      archivedAt: true,
      draft: true,
      grants: {
        select: { canUse: true, groupId: true, userId: true }
      },
      testedDraftHash: true
    }
  },
  serverId: true,
  tokenEnvelope: true,
  tokenGeneration: true,
  user: {
    select: {
      groups: {
        select: { groupId: true },
        where: { group: { archivedAt: null } }
      },
      role: true,
      status: true
    }
  },
  userId: true
} satisfies Prisma.McpOAuthConnectionSelect;

type OAuthEligibilityRecord = Prisma.McpOAuthConnectionGetPayload<{
  select: typeof oauthEligibilitySelect;
}>;

export function isMcpOAuthConnectionEligible(record: OAuthEligibilityRecord): boolean {
  // Server and personal enablement are intentionally absent: toggling either off
  // pauses use without discarding the user's external authorization.
  if (record.server.archivedAt || record.user.status !== "active") return false;
  if (record.purpose === "validation") return record.user.role === "admin";

  const activeGroupIds = new Set(record.user.groups.map((membership) => membership.groupId));
  return record.server.grants.some((grant) => grant.canUse && (
    grant.userId === record.userId || Boolean(grant.groupId && activeGroupIds.has(grant.groupId))
  ));
}

function hasCurrentMcpOAuthPolicy(record: OAuthEligibilityRecord, key: Buffer): boolean {
  if (!record.oauthClient || !record.tokenEnvelope) return false;
  let storedPolicy: McpOAuthPolicy;
  try {
    storedPolicy = parseTokenEnvelope(
      record.tokenEnvelope,
      key,
      record.id,
      record.tokenGeneration
    ).policy;
  } catch {
    return false;
  }

  const selected = record.purpose === "validation"
    ? (() => {
        const draft = draftFrom(record.server.draft);
        if (!draft || draft.auth.mode !== "oauth") return null;
        const identity = hashCanonicalMcpValue(draft);
        return record.server.testedDraftHash === identity ? { draft, identity } : null;
      })()
    : (() => {
        const revision = record.server.activeRevision;
        const draft = revision ? draftFrom(revision.configuration) : null;
        return draft?.auth.mode === "oauth" && revision
          ? { draft, identity: revision.id }
          : null;
      })();
  if (!selected) return false;
  try {
    const current = buildMcpOAuthPolicy({
      configurationIdentity: selected.identity,
      draft: selected.draft,
      purpose: record.purpose,
      redirectUri: storedPolicy.redirectUri,
      serverId: record.serverId,
      userId: record.userId
    });
    return mcpOAuthPolicyFingerprint(current, record.oauthClient.clientId) ===
      record.policyFingerprint;
  } catch {
    return false;
  }
}

function draftFrom(value: Prisma.JsonValue): McpDraftConfiguration | null {
  const result = validateMcpDraft(value);
  return result.ok ? result.value : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tokenVersion(tokenGeneration: number): string {
  return String(tokenGeneration);
}

function parseClientInformation(value: unknown): OAuthClientInformationMixed | null {
  const full = OAuthClientInformationFullSchema.safeParse(value);
  if (full.success) return full.data;
  const minimal = OAuthClientInformationSchema.safeParse(value);
  return minimal.success ? minimal.data : null;
}

function parseStoredClientMetadata(value: unknown): StoredClientMetadata | null {
  const record = jsonRecord(value);
  const clientInformation = jsonRecord(record?.clientInformation);
  const clientMetadata = jsonRecord(record?.clientMetadata);
  const discoveryState = jsonRecord(record?.discoveryState);
  if (record?.version !== 1 || !clientInformation || !clientMetadata || !discoveryState) return null;
  return {
    clientInformation,
    clientMetadata: clientMetadata as OAuthClientMetadata,
    discoveryState: discoveryState as unknown as OAuthDiscoveryState,
    version: 1
  };
}

function withClientSecret(
  metadata: StoredClientMetadata,
  clientId: string,
  clientSecretEnvelope: string | null,
  clientSecretGeneration: number,
  oauthClientId: string,
  key: Buffer
): OAuthClientInformationMixed {
  const secret = clientSecretEnvelope
    ? decryptMcpEnvelope<{ clientSecret: string; version: 1 }>(
        clientSecretEnvelope,
        key,
        mcpOAuthClientSecretEnvelopeContext(oauthClientId, clientSecretGeneration)
      )
    : null;
  const parsed = parseClientInformation({
    ...metadata.clientInformation,
    client_id: clientId,
    ...(secret?.clientSecret ? { client_secret: secret.clientSecret } : {})
  });
  if (!parsed || (secret && secret.version !== 1)) throw new Error("mcp_oauth_client_invalid");
  return parsed;
}

function serializeClient(
  record: Readonly<{
    clientId: string;
    clientMetadata: Prisma.JsonValue;
    clientSecretEnvelope: string | null;
    clientSecretGeneration: number;
    id: string;
    registrationKey: string;
  }>,
  key: Buffer
): McpOAuthStoredClient {
  const metadata = parseStoredClientMetadata(record.clientMetadata);
  if (!metadata) throw new Error("mcp_oauth_client_invalid");
  return {
    clientInformation: withClientSecret(
      metadata,
      record.clientId,
      record.clientSecretEnvelope,
      record.clientSecretGeneration,
      record.id,
      key
    ),
    clientMetadata: metadata.clientMetadata,
    discoveryState: metadata.discoveryState,
    id: record.id,
    registrationKey: record.registrationKey
  };
}

function parseTokenEnvelope(
  envelope: string,
  key: Buffer,
  connectionId: string,
  tokenGeneration: number
): StoredTokenEnvelope {
  const decoded = decryptMcpEnvelope<unknown>(
    envelope,
    key,
    mcpOAuthTokenEnvelopeContext(connectionId, tokenGeneration)
  );
  const record = jsonRecord(decoded);
  const parsedTokens = OAuthTokensSchema.safeParse(record?.tokens);
  if (
    record?.version !== 1 ||
    typeof record.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(record.issuedAt)) ||
    !jsonRecord(record.policy) ||
    !parsedTokens.success
  ) {
    throw new Error("mcp_oauth_tokens_invalid");
  }
  return {
    issuedAt: record.issuedAt,
    policy: record.policy as McpOAuthPolicy,
    tokens: parsedTokens.data,
    version: 1
  };
}

function checkedTokens(tokens: OAuthTokens): OAuthTokens {
  const parsed = OAuthTokensSchema.parse(tokens);
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_OAUTH_ENVELOPE_JSON_BYTES) {
    throw new Error("mcp_oauth_tokens_invalid");
  }
  return parsed;
}

function tokenExpiry(tokens: OAuthTokens, now: Date): Date | null {
  const seconds = tokens.expires_in;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now.getTime() + Math.min(seconds, 365 * 24 * 60 * 60) * 1_000);
}

function tokenScopes(tokens: OAuthTokens, fallback: readonly string[]): string[] {
  const scopes = tokens.scope?.split(/\s+/u).map((value) => value.trim()).filter(Boolean) ?? [];
  return [...new Set(scopes.length ? scopes : fallback)].sort((left, right) => left.localeCompare(right));
}

async function policyForSubject(
  client: OAuthPrismaClient,
  input: Readonly<{
    purpose: McpOAuthPurpose;
    redirectUri: string;
    serverId: string;
    userId: string;
  }>
): Promise<McpOAuthPolicy | null> {
  const user = await client.user.findUnique({
    select: {
      groups: { select: { groupId: true }, where: { group: { archivedAt: null } } },
      role: true,
      status: true
    },
    where: { id: input.userId }
  });
  if (!user || user.status !== "active") return null;

  if (input.purpose === "validation") {
    if (user.role !== "admin") return null;
    const server = await client.mcpServer.findFirst({
      select: { archivedAt: true, draft: true, testedDraftHash: true },
      where: { archivedAt: null, id: input.serverId }
    });
    const draft = server ? draftFrom(server.draft) : null;
    if (!server || !draft || draft.auth.mode !== "oauth") return null;
    const draftHash = hashCanonicalMcpValue(draft);
    if (server.testedDraftHash !== draftHash) return null;
    return buildMcpOAuthPolicy({
      configurationIdentity: draftHash,
      draft,
      purpose: input.purpose,
      redirectUri: input.redirectUri,
      serverId: input.serverId,
      userId: input.userId
    });
  }

  const groupIds = user.groups.map((membership) => membership.groupId);
  const server = await client.mcpServer.findFirst({
    select: {
      activeRevision: { select: { configuration: true, id: true } },
      grants: {
        select: { canUse: true, groupId: true, personalSlotKeys: true, userId: true },
        where: { OR: [{ userId: input.userId }, ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])] }
      }
    },
    where: { archivedAt: null, enabled: true, id: input.serverId }
  });
  if (!server?.activeRevision) return null;
  const direct = server.grants.find((grant) => grant.userId === input.userId) ?? null;
  const groups = server.grants.filter((grant) => grant.groupId && groupIds.includes(grant.groupId));
  if (!resolveEffectiveMcpGrant({ direct, groups }).canUse) return null;
  const draft = draftFrom(server.activeRevision.configuration);
  if (!draft || draft.auth.mode !== "oauth") return null;
  return buildMcpOAuthPolicy({
    configurationIdentity: server.activeRevision.id,
    draft,
    purpose: input.purpose,
    redirectUri: input.redirectUri,
    serverId: input.serverId,
    userId: input.userId
  });
}

export function createPrismaMcpOAuthRepository(input: Readonly<{
  encryptionKey?: () => Buffer;
  prisma?: PrismaClient;
}> = {}): McpOAuthRepository {
  const client = input.prisma ?? prisma;
  const encryptionKey = input.encryptionKey ?? getMcpEncryptionKey;

  async function storedClient(clientId: string): Promise<McpOAuthStoredClient> {
    const record = await client.mcpOAuthClient.findUniqueOrThrow({ where: { id: clientId } });
    return serializeClient(record, encryptionKey());
  }

  async function serializeConnection(record: Readonly<{
    expiresAt: Date | null;
    externalAccountLabel: string | null;
    id: string;
    oauthClientId: string | null;
    policyFingerprint: string;
    purpose: McpOAuthPurpose;
    scopes: string[];
    state: McpOAuthConnectionState;
    tokenEnvelope: string | null;
    tokenGeneration: number;
    userId: string;
  }>): Promise<McpOAuthStoredConnection | null> {
    if (!record.oauthClientId || !record.tokenEnvelope) return null;
    const envelope = parseTokenEnvelope(
      record.tokenEnvelope,
      encryptionKey(),
      record.id,
      record.tokenGeneration
    );
    return {
      client: await storedClient(record.oauthClientId),
      expiresAt: record.expiresAt,
      externalAccountLabel: record.externalAccountLabel,
      id: record.id,
      policy: envelope.policy,
      policyFingerprint: record.policyFingerprint,
      purpose: record.purpose,
      scopes: record.scopes,
      state: record.state,
      tokenVersion: tokenVersion(record.tokenGeneration),
      tokens: envelope.tokens,
      userId: record.userId
    };
  }

  async function loadConnection(connectionId: string): Promise<McpOAuthStoredConnection | null> {
    const record = await client.mcpOAuthConnection.findUnique({ where: { id: connectionId } });
    return record ? serializeConnection(record) : null;
  }

  return {
    async createConnection(inputValue) {
      const key = encryptionKey();
      const now = new Date();
      const tokens = checkedTokens(inputValue.tokens);
      return client.$transaction(async (tx) => {
        const policy = await policyForSubject(tx, inputValue);
        if (!policy || policy.configurationIdentity !== inputValue.configurationIdentity) {
          return { kind: "configuration_changed" as const };
        }
        if (mcpOAuthPolicyFingerprint(policy, inputValue.clientId) !== inputValue.policyFingerprint) {
          return { kind: "configuration_changed" as const };
        }
        const oauthClient = await tx.mcpOAuthClient.findUnique({
          select: { clientId: true, id: true },
          where: { id: inputValue.oauthClientId }
        });
        if (!oauthClient || oauthClient.clientId !== inputValue.clientId) return { kind: "not_found" as const };

        const connectionId = randomUUID();
        const tokenGeneration = 1;
        const envelope = encryptMcpEnvelope(
          {
            issuedAt: now.toISOString(),
            policy,
            tokens,
            version: 1
          } satisfies StoredTokenEnvelope,
          key,
          mcpOAuthTokenEnvelopeContext(connectionId, tokenGeneration)
        );
        await tx.mcpOAuthConnection.updateMany({
          data: { disconnectRequestedAt: now, state: "disconnecting" },
          where: {
            purpose: inputValue.purpose,
            serverId: inputValue.serverId,
            state: { in: ["ready", "reauthorization_required"] },
            userId: inputValue.userId
          }
        });
        const created = await tx.mcpOAuthConnection.create({
          data: {
            expiresAt: tokenExpiry(tokens, now),
            externalAccountLabel: inputValue.externalAccountLabel,
            id: connectionId,
            oauthClientId: oauthClient.id,
            policyFingerprint: inputValue.policyFingerprint,
            purpose: inputValue.purpose,
            scopes: tokenScopes(tokens, policy.requestedScopes),
            serverId: inputValue.serverId,
            state: "ready",
            tokenEnvelope: envelope,
            tokenGeneration,
            userId: inputValue.userId
          }
        });
        if (inputValue.purpose === "user") {
          await tx.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null },
            where: { serverId: inputValue.serverId, userId: inputValue.userId }
          });
        }
        const value = await serializeConnection(created);
        return value ? { kind: "ok" as const, value } : { kind: "not_found" as const };
      });
    },

    async finalizeDisconnected(connectionId) {
      const result = await client.mcpOAuthConnection.updateMany({
        data: {
          expiresAt: null,
          state: "disconnected",
          tokenEnvelope: null,
          tokenGeneration: { increment: 1 }
        },
        where: {
          id: connectionId,
          runtimeGenerations: {
            none: {
              runBindings: { some: { modelRun: { status: { in: [...ACTIVE_RUN_STATUSES] } } } }
            }
          },
          state: "disconnecting"
        }
      });
      return result.count === 1;
    },

    async findClient(registrationKey) {
      const record = await client.mcpOAuthClient.findUnique({ where: { registrationKey } });
      return record ? serializeClient(record, encryptionKey()) : null;
    },

    async findReadyConnection(query) {
      const record = await client.mcpOAuthConnection.findFirst({
        orderBy: { createdAt: "desc" },
        where: { ...query, state: "ready", tokenEnvelope: { not: null } }
      });
      return record ? serializeConnection(record) : null;
    },

    async findLatestReadyConnection(query) {
      const record = await client.mcpOAuthConnection.findFirst({
        orderBy: { createdAt: "desc" },
        where: { ...query, state: "ready", tokenEnvelope: { not: null } }
      });
      return record ? serializeConnection(record) : null;
    },

    async hasActiveRunBindings(connectionId) {
      return Boolean(await client.mcpRuntimeGeneration.findFirst({
        select: { id: true },
        where: {
          oauthConnectionId: connectionId,
          runBindings: { some: { modelRun: { status: { in: [...ACTIVE_RUN_STATUSES] } } } }
        }
      }));
    },

    async listDisconnectingConnectionIds() {
      const records = await client.mcpOAuthConnection.findMany({
        orderBy: { updatedAt: "asc" },
        select: { id: true },
        where: { state: "disconnecting", tokenEnvelope: { not: null } }
      });
      return records.map((record) => record.id);
    },

    loadConnection,

    async prepareValidationPolicy(inputValue) {
      return client.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
          select: { role: true, status: true },
          where: { id: inputValue.userId }
        });
        if (!user || user.status !== "active" || user.role !== "admin") return null;
        const server = await tx.mcpServer.findFirst({
          select: { draft: true, testedDraftHash: true, updatedAt: true },
          where: { archivedAt: null, id: inputValue.serverId }
        });
        const draft = server ? draftFrom(server.draft) : null;
        if (!server || !draft || draft.auth.mode !== "oauth") return null;
        const draftHash = hashCanonicalMcpValue(draft);
        if (server.testedDraftHash !== draftHash) {
          const pinned = await tx.mcpServer.updateMany({
            data: { testedDraftHash: draftHash },
            where: { id: inputValue.serverId, updatedAt: server.updatedAt }
          });
          if (pinned.count !== 1) return null;
        }
        return buildMcpOAuthPolicy({
          configurationIdentity: draftHash,
          draft,
          purpose: "validation",
          redirectUri: inputValue.redirectUri,
          serverId: inputValue.serverId,
          userId: inputValue.userId
        });
      });
    },

    async requestDisconnectForIneligibleConnections() {
      const key = encryptionKey();
      const candidates = await client.mcpOAuthConnection.findMany({
        select: oauthEligibilitySelect,
        where: {
          state: { in: ["ready", "reauthorization_required"] },
          tokenEnvelope: { not: null }
        }
      });
      let transitioned = 0;
      for (const candidate of candidates) {
        const subjectEligible = isMcpOAuthConnectionEligible(candidate);
        const policyCurrent = subjectEligible && hasCurrentMcpOAuthPolicy(candidate, key);
        if (policyCurrent) continue;
        transitioned += await client.$transaction(async (tx) => {
          const ineligibleNow = candidate.purpose === "validation"
            ? {
                OR: [
                  { server: { archivedAt: { not: null } } },
                  { user: { status: { not: "active" as const } } },
                  { user: { role: { not: "admin" as const } } }
                ]
              }
            : {
                OR: [
                  { server: { archivedAt: { not: null } } },
                  { user: { status: { not: "active" as const } } },
                  {
                    server: {
                      grants: {
                        none: {
                          canUse: true,
                          OR: [
                            { userId: candidate.userId },
                            {
                              group: {
                                archivedAt: null,
                                users: { some: { userId: candidate.userId } }
                              }
                            }
                          ]
                        }
                      }
                    }
                  }
                ]
              };
          const updated = await tx.mcpOAuthConnection.updateMany({
            data: { disconnectRequestedAt: new Date(), state: "disconnecting" },
            where: {
              id: candidate.id,
              state: { in: ["ready", "reauthorization_required"] },
              tokenEnvelope: { not: null },
              ...(subjectEligible ? { policyFingerprint: candidate.policyFingerprint } : ineligibleNow)
            }
          });
          if (updated.count && candidate.purpose === "user") {
            await tx.mcpUserServer.updateMany({
              data: { desiredRuntimeGenerationId: null },
              where: { serverId: candidate.serverId, userId: candidate.userId }
            });
          }
          return updated.count;
        });
      }
      return transitioned;
    },

    loadPolicy(inputValue) {
      return policyForSubject(client, inputValue);
    },

    async markReauthorizationRequired({ connectionId, tokenVersion: expectedVersion }) {
      const record = await client.mcpOAuthConnection.findUnique({
        select: {
          serverId: true,
          state: true,
          tokenEnvelope: true,
          tokenGeneration: true,
          userId: true
        },
        where: { id: connectionId }
      });
      if (!record?.tokenEnvelope || tokenVersion(record.tokenGeneration) !== expectedVersion) return false;
      return client.$transaction(async (tx) => {
        const updated = await tx.mcpOAuthConnection.updateMany({
          data: { state: "reauthorization_required" },
          where: {
            id: connectionId,
            state: { in: ["ready", "disconnecting"] },
            tokenGeneration: record.tokenGeneration
          }
        });
        if (updated.count !== 1) return false;
        await tx.mcpUserServer.updateMany({
          data: { desiredRuntimeGenerationId: null },
          where: { serverId: record.serverId, userId: record.userId }
        });
        return true;
      });
    },

    async requestDisconnect(query) {
      return client.$transaction(async (tx) => {
        const current = await tx.mcpOAuthConnection.findFirst({
          orderBy: { createdAt: "desc" },
          where: { ...query, state: { in: ["ready", "reauthorization_required", "disconnecting"] } }
        });
        if (!current) return null;
        const updated = current.state === "disconnecting"
          ? current
          : await tx.mcpOAuthConnection.update({
              data: { disconnectRequestedAt: new Date(), state: "disconnecting" },
              where: { id: current.id }
            });
        if (query.purpose === "user") {
          await tx.mcpUserServer.updateMany({
            data: { desiredRuntimeGenerationId: null },
            where: { serverId: query.serverId, userId: query.userId }
          });
        }
        return serializeConnection(updated);
      });
    },

    async rotateTokens({ connectionId, expectedTokenVersion, tokens: inputTokens }) {
      const record = await client.mcpOAuthConnection.findUnique({ where: { id: connectionId } });
      if (!record?.tokenEnvelope || tokenVersion(record.tokenGeneration) !== expectedTokenVersion) {
        return loadConnection(connectionId);
      }
      const key = encryptionKey();
      const prior = parseTokenEnvelope(
        record.tokenEnvelope,
        key,
        record.id,
        record.tokenGeneration
      );
      const tokens = checkedTokens({
        ...inputTokens,
        ...(inputTokens.refresh_token || !prior.tokens.refresh_token
          ? {}
          : { refresh_token: prior.tokens.refresh_token })
      });
      const now = new Date();
      const tokenGeneration = record.tokenGeneration + 1;
      const envelope = encryptMcpEnvelope(
        {
          issuedAt: now.toISOString(),
          policy: prior.policy,
          tokens,
          version: 1
        } satisfies StoredTokenEnvelope,
        key,
        mcpOAuthTokenEnvelopeContext(record.id, tokenGeneration)
      );
      const updated = await client.mcpOAuthConnection.updateMany({
        data: {
          expiresAt: tokenExpiry(tokens, now),
          scopes: tokenScopes(tokens, record.scopes),
          tokenEnvelope: envelope,
          tokenGeneration
        },
        where: {
          id: connectionId,
          state: { in: ["ready", "disconnecting"] },
          tokenGeneration: record.tokenGeneration
        }
      });
      if (updated.count !== 1) return loadConnection(connectionId);
      return loadConnection(connectionId);
    },

    async saveClient(inputValue) {
      const key = encryptionKey();
      const information = parseClientInformation(inputValue.clientInformation);
      if (!information) throw new Error("mcp_oauth_client_invalid");
      const { client_secret: clientSecret, ...publicInformation } = information;
      const metadata: StoredClientMetadata = {
        clientInformation: jsonClone(publicInformation),
        clientMetadata: jsonClone(inputValue.clientMetadata),
        discoveryState: jsonClone(inputValue.discoveryState),
        version: 1
      };
      if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_OAUTH_ENVELOPE_JSON_BYTES) {
        throw new Error("mcp_oauth_client_invalid");
      }
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`aiqsa:mcp-oauth-client:${inputValue.registrationKey}`}, 0)
          )::text AS "lock"
        `;
        const existing = await tx.mcpOAuthClient.findUnique({
          where: { registrationKey: inputValue.registrationKey }
        });
        const oauthClientId = existing?.id ?? randomUUID();
        const clientSecretGeneration = existing
          ? existing.clientSecretGeneration + 1
          : clientSecret ? 1 : 0;
        const data = {
          clientId: information.client_id,
          clientMetadata: metadata as unknown as Prisma.InputJsonValue,
          clientSecretEnvelope: clientSecret
            ? encryptMcpEnvelope(
                { clientSecret, version: 1 },
                key,
                mcpOAuthClientSecretEnvelopeContext(oauthClientId, clientSecretGeneration)
              )
            : null,
          clientSecretGeneration
        };
        const record = existing
          ? await tx.mcpOAuthClient.update({ data, where: { id: existing.id } })
          : await tx.mcpOAuthClient.create({
              data: {
                ...data,
                id: oauthClientId,
                registrationKey: inputValue.registrationKey
              }
            });
        return serializeClient(record, key);
      });
    }
  };
}
