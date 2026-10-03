import type { Prisma } from "@prisma/client";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { decryptMcpEnvelope, getMcpEncryptionKey, mcpOAuthClientSecretEnvelopeContext, mcpOAuthTokenEnvelopeContext,
  mcpPersonalConfigEnvelopeContext, mcpRuntimeGenerationEnvelopeContext, mcpSharedConfigEnvelopeContext,
  type McpEnvelopeContext } from "./encryption";
import { validateMcpDraft } from "./definitions";
import { mcpDetailRecord as record, type AcceptedMcpCallIdentity } from "./callDetailsAuthority";

export type McpDisplayRedaction = Readonly<{ values: readonly string[] }>;

/**
 * Whether the values known now can redact a call's sensitive slots:
 * `none_needed` (no sensitive slots and no OAuth), `complete` (every sensitive
 * slot was checked against at least one current source that decrypted, or
 * only OAuth applies: headers and tokens are never arguments) or `incomplete`
 * (the key is unavailable, the accepted configuration is unknown, or a
 * sensitive slot has no current source that decrypted while one failed or
 * none exists).
 */
export type McpRedactionState = "none_needed" | "complete" | "incomplete";
export type McpRedactionEvidence = Readonly<{ state: McpRedactionState; values: readonly string[] }>;

/** Bounds per-read decryption work; the newest connections of the user include the runtime one. */
const OAUTH_CONNECTION_LIMIT = 4;

const draft = (value: unknown): McpDraftConfiguration | null => {
  const checked = validateMcpDraft(value);
  return checked.ok ? checked.value : null;
};
const slotText = (value: unknown): string | null => typeof value === "string" ? value || null
  : typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? String(value) : null;

type Opened = Readonly<{ decoded: Record<string, unknown> | null; failed: boolean }>;

/** A missing envelope contributes nothing; a stale or undecryptable one is
 * reported as failed, so a provider projection can fail closed. */
function open(envelope: string | null | undefined, key: Buffer, context: () => McpEnvelopeContext): Opened {
  if (!envelope) return { decoded: null, failed: false };
  try {
    const decoded = decryptMcpEnvelope<unknown>(envelope, key, context());
    return record(decoded) && decoded.version === 1 ? { decoded, failed: false } : { decoded: null, failed: true };
  } catch {
    return { decoded: null, failed: true };
  }
}

type OAuthConnectionRecord = Readonly<{
  id: string; userId: string; serverId: string; tokenEnvelope: string | null; tokenGeneration: number;
  oauthClient: Readonly<{ id: string; clientSecretEnvelope: string | null; clientSecretGeneration: number }> | null;
}>;

/**
 * Exact values redacted from displayed MCP details: the secret values known
 * now, read without starting a runtime or refreshing OAuth. Sources are the
 * accepted runtime generation while it exists, the current secret values of the
 * same server for this user or Project, and the current OAuth tokens and client
 * secret of the user's connection, whatever their generation. Every source that
 * is missing or cannot be decrypted contributes nothing, and the request is
 * still shown (operator decision 2026-09-30): a value rotated away since the
 * call can appear only where the model itself put it into the arguments, and
 * only its initiator reads it. Headers and OAuth tokens are never arguments.
 */
export async function mcpCallDisplayRedaction(tx: Prisma.TransactionClient, identity: AcceptedMcpCallIdentity,
  generationId: string | null, userId: string, projectId: string | null): Promise<McpDisplayRedaction> {
  return { values: (await mcpCallRedactionEvidence(tx, identity, generationId, userId, projectId)).values };
}

/**
 * The same known values with the evidence a provider-facing projection needs
 * (see `McpRedactionState`). Unlike the initiator's display, a model receives
 * stored arguments only when no sensitive slot could hide behind an
 * undecryptable or absent source: `incomplete` withholds them, while their
 * known outcome stays. The absence of a deleted runtime generation or of
 * rotated OAuth tokens alone never makes the evidence incomplete.
 */
export async function mcpCallRedactionEvidence(tx: Prisma.TransactionClient, identity: AcceptedMcpCallIdentity,
  generationId: string | null, userId: string, projectId: string | null): Promise<McpRedactionEvidence> {
  const accepted = await tx.mcpRevision.findFirst({ where: { id: identity.revisionId, serverId: identity.serverId }, select: { configuration: true } });
  const server = await tx.mcpServer.findFirst({ where: { id: identity.serverId }, select: {
    id: true, sharedConfigEnvelope: true, sharedConfigVersion: true, activeRevision: { select: { configuration: true } }
  } });
  const acceptedConfiguration = draft(accepted?.configuration);
  const configurations = [acceptedConfiguration, draft(server?.activeRevision?.configuration)]
    .filter((value): value is McpDraftConfiguration => value !== null);
  const sensitive = new Set(configurations.flatMap(value => value.slots.filter(slot => slot.sensitive).map(slot => slot.slotKey)));
  // Project runs never use OAuth identity or personal values.
  const oauth = !projectId && configurations.some(value => value.auth.mode === "oauth");
  // An unknown accepted configuration cannot prove that no slot was secret.
  const unknownConfiguration = acceptedConfiguration === null;
  if (!sensitive.size && !oauth) return { state: unknownConfiguration ? "incomplete" : "none_needed", values: [] };

  let key: Buffer;
  try { key = getMcpEncryptionKey(); } catch {
    return { state: sensitive.size || unknownConfiguration ? "incomplete" : "complete", values: [] };
  }
  const values = new Set<string>();
  const add = (value: unknown) => { const text = slotText(value); if (text) values.add(text); };
  const covered = new Set<string>();
  let opened = 0;
  let failed = 0;
  const addSlots = (source: Opened) => {
    if (source.failed) failed += 1;
    const decoded = source.decoded;
    if (!decoded) return;
    opened += 1;
    if (!record(decoded.values)) return;
    for (const slotKey of sensitive) {
      if (!Object.hasOwn(decoded.values, slotKey)) continue;
      covered.add(slotKey);
      add(decoded.values[slotKey]);
    }
  };

  const generation = generationId ? await tx.mcpRuntimeGeneration.findFirst({ where: {
    id: generationId, fingerprint: identity.fingerprint, revisionId: identity.revisionId,
    ...(projectId ? { sharedServerId: identity.serverId } : { userServer: { userId, serverId: identity.serverId } })
  }, include: { oauthConnection: { include: { oauthClient: true } } } }) : null;
  if (generation && sensitive.size) {
    addSlots(open(generation.effectiveConfigEnvelope, key, () => mcpRuntimeGenerationEnvelopeContext(generation.id, generation.fingerprint)));
  }
  if (server && sensitive.size) {
    addSlots(open(server.sharedConfigEnvelope, key, () => mcpSharedConfigEnvelopeContext(server.id, server.sharedConfigVersion)));
  }
  if (!projectId && sensitive.size) {
    const personal = await tx.mcpUserServer.findUnique({ where: { userId_serverId: { userId, serverId: identity.serverId } },
      select: { id: true, personalConfigEnvelope: true, personalConfigVersion: true } });
    if (personal) addSlots(open(personal.personalConfigEnvelope, key,
      () => mcpPersonalConfigEnvelopeContext(personal.id, personal.personalConfigVersion)));
  }
  if (oauth) {
    const connections: OAuthConnectionRecord[] = await tx.mcpOAuthConnection.findMany({
      where: { serverId: identity.serverId, userId, tokenEnvelope: { not: null } },
      include: { oauthClient: true }, orderBy: { updatedAt: "desc" }, take: OAUTH_CONNECTION_LIMIT
    });
    const bound = generation?.oauthConnection;
    if (bound && bound.userId === userId && bound.serverId === identity.serverId && !connections.some(item => item.id === bound.id)) connections.push(bound);
    for (const connection of connections) {
      const tokens = open(connection.tokenEnvelope, key, () => mcpOAuthTokenEnvelopeContext(connection.id, connection.tokenGeneration)).decoded;
      if (tokens && record(tokens.tokens)) for (const name of ["access_token", "refresh_token"]) add(tokens.tokens[name]);
      const client = connection.oauthClient;
      const secret = client && open(client.clientSecretEnvelope, key,
        () => mcpOAuthClientSecretEnvelopeContext(client.id, client.clientSecretGeneration)).decoded;
      if (secret && typeof secret.clientSecret === "string") add(secret.clientSecret);
    }
  }
  // A slot no opened source holds is unset there, unless a source that might
  // hold it failed to decrypt or no source could be read at all.
  const unverified = [...sensitive].some(slotKey => !covered.has(slotKey) && (failed > 0 || opened === 0));
  return { state: unknownConfiguration || unverified ? "incomplete" : "complete", values: [...values] };
}
