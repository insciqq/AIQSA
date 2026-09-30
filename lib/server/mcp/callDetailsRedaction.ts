import type { Prisma } from "@prisma/client";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { decryptMcpEnvelope, getMcpEncryptionKey, mcpOAuthClientSecretEnvelopeContext, mcpOAuthTokenEnvelopeContext,
  mcpPersonalConfigEnvelopeContext, mcpRuntimeGenerationEnvelopeContext, mcpSharedConfigEnvelopeContext,
  type McpEnvelopeContext } from "./encryption";
import { validateMcpDraft } from "./definitions";
import { mcpDetailRecord as record, type AcceptedMcpCallIdentity } from "./callDetailsAuthority";

export type McpDisplayRedaction = Readonly<{ values: readonly string[] }>;

/** Bounds per-read decryption work; the newest connections of the user include the runtime one. */
const OAUTH_CONNECTION_LIMIT = 4;

const draft = (value: unknown): McpDraftConfiguration | null => {
  const checked = validateMcpDraft(value);
  return checked.ok ? checked.value : null;
};
const slotText = (value: unknown): string | null => typeof value === "string" ? value || null
  : typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? String(value) : null;

/** A missing, stale or undecryptable envelope contributes no values. */
function open(envelope: string | null | undefined, key: Buffer, context: () => McpEnvelopeContext): Record<string, unknown> | null {
  if (!envelope) return null;
  try {
    const decoded = decryptMcpEnvelope<unknown>(envelope, key, context());
    return record(decoded) && decoded.version === 1 ? decoded : null;
  } catch {
    return null;
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
  const accepted = await tx.mcpRevision.findFirst({ where: { id: identity.revisionId, serverId: identity.serverId }, select: { configuration: true } });
  const server = await tx.mcpServer.findFirst({ where: { id: identity.serverId }, select: {
    id: true, sharedConfigEnvelope: true, sharedConfigVersion: true, activeRevision: { select: { configuration: true } }
  } });
  const configurations = [draft(accepted?.configuration), draft(server?.activeRevision?.configuration)]
    .filter((value): value is McpDraftConfiguration => value !== null);
  const sensitive = new Set(configurations.flatMap(value => value.slots.filter(slot => slot.sensitive).map(slot => slot.slotKey)));
  // Project runs never use OAuth identity or personal values.
  const oauth = !projectId && configurations.some(value => value.auth.mode === "oauth");
  if (!sensitive.size && !oauth) return { values: [] };

  let key: Buffer;
  try { key = getMcpEncryptionKey(); } catch { return { values: [] }; }
  const values = new Set<string>();
  const add = (value: unknown) => { const text = slotText(value); if (text) values.add(text); };
  const addSlots = (decoded: Record<string, unknown> | null) => {
    if (!decoded || !record(decoded.values)) return;
    for (const slotKey of sensitive) if (Object.hasOwn(decoded.values, slotKey)) add(decoded.values[slotKey]);
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
      const tokens = open(connection.tokenEnvelope, key, () => mcpOAuthTokenEnvelopeContext(connection.id, connection.tokenGeneration));
      if (tokens && record(tokens.tokens)) for (const name of ["access_token", "refresh_token"]) add(tokens.tokens[name]);
      const client = connection.oauthClient;
      const secret = client && open(client.clientSecretEnvelope, key,
        () => mcpOAuthClientSecretEnvelopeContext(client.id, client.clientSecretGeneration));
      if (secret && typeof secret.clientSecret === "string") add(secret.clientSecret);
    }
  }
  return { values: [...values] };
}
