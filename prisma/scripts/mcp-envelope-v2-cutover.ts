import { createDecipheriv } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  decryptMcpEnvelope,
  encryptMcpEnvelope,
  getMcpEncryptionKey,
  mcpOAuthClientSecretEnvelopeContext,
  mcpOAuthTokenEnvelopeContext,
  mcpPersonalConfigEnvelopeContext,
  mcpRuntimeGenerationEnvelopeContext,
  mcpSharedConfigEnvelopeContext,
  type McpEnvelopeContext
} from "../../lib/server/mcp/encryption";

const ALGORITHM = "aes-256-gcm";
const LEGACY_ENVELOPE_VERSION = "v1";
const CURRENT_ENVELOPE_VERSION = "v2";
const MAX_PLAINTEXT_BYTES = 1_048_576;

export const MCP_ENVELOPE_CUTOVER_LOCK_KEY = "aiqsa:maintenance:offline-cutover";

export type McpEnvelopeV2CutoverResult = Readonly<{
  convertedOAuthClientSecrets: number;
  convertedOAuthTokens: number;
  convertedPersonalConfigs: number;
  convertedRuntimeConfigs: number;
  convertedSharedConfigs: number;
}>;

class McpEnvelopeCutoverError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "McpEnvelopeCutoverError";
  }
}

function decodeLegacyBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("invalid");
  return decoded;
}

function decryptLegacyMcpEnvelopeV1(envelope: string, key: Buffer): unknown {
  try {
    const [version, nonceValue, ciphertextValue, tagValue, extra] = envelope.split(".");
    if (version !== LEGACY_ENVELOPE_VERSION || !nonceValue || !ciphertextValue || !tagValue || extra) {
      throw new Error("invalid");
    }
    const nonce = decodeLegacyBase64Url(nonceValue);
    const ciphertext = decodeLegacyBase64Url(ciphertextValue);
    const tag = decodeLegacyBase64Url(tagValue);
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_PLAINTEXT_BYTES) {
      throw new Error("invalid");
    }
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("invalid");
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    throw new McpEnvelopeCutoverError("mcp_envelope_cutover_invalid_v1");
  }
}

function convertEnvelope(
  envelope: string,
  key: Buffer,
  context: McpEnvelopeContext
): { converted: boolean; envelope: string } {
  if (envelope.startsWith(`${LEGACY_ENVELOPE_VERSION}.`)) {
    return {
      converted: true,
      envelope: encryptMcpEnvelope(decryptLegacyMcpEnvelopeV1(envelope, key), key, context)
    };
  }
  if (envelope.startsWith(`${CURRENT_ENVELOPE_VERSION}.`)) {
    decryptMcpEnvelope(envelope, key, context);
    return { converted: false, envelope };
  }
  throw new McpEnvelopeCutoverError("mcp_envelope_cutover_unknown_version");
}

function requireUpdated(count: number): void {
  if (count !== 1) throw new McpEnvelopeCutoverError("mcp_envelope_cutover_concurrent_change");
}

export async function cutOverMcpEnvelopesToV2InTransaction(
  tx: Prisma.TransactionClient,
  key: Buffer
): Promise<McpEnvelopeV2CutoverResult> {
  await tx.$executeRaw`
    LOCK TABLE
      "McpServer",
      "McpUserServer",
      "McpOAuthClient",
      "McpOAuthConnection",
      "McpRuntimeGeneration"
    IN SHARE ROW EXCLUSIVE MODE
  `;

    const result = {
      convertedOAuthClientSecrets: 0,
      convertedOAuthTokens: 0,
      convertedPersonalConfigs: 0,
      convertedRuntimeConfigs: 0,
      convertedSharedConfigs: 0
    };

    const servers = await tx.mcpServer.findMany({
      select: { id: true, sharedConfigEnvelope: true, sharedConfigVersion: true },
      where: { sharedConfigEnvelope: { not: null } }
    });
    for (const server of servers) {
      if (!server.sharedConfigEnvelope) continue;
      const converted = convertEnvelope(
        server.sharedConfigEnvelope,
        key,
        mcpSharedConfigEnvelopeContext(server.id, server.sharedConfigVersion)
      );
      if (!converted.converted) continue;
      const updated = await tx.mcpServer.updateMany({
        data: { sharedConfigEnvelope: converted.envelope },
        where: {
          id: server.id,
          sharedConfigEnvelope: server.sharedConfigEnvelope,
          sharedConfigVersion: server.sharedConfigVersion
        }
      });
      requireUpdated(updated.count);
      result.convertedSharedConfigs += 1;
    }

    const userServers = await tx.mcpUserServer.findMany({
      select: { id: true, personalConfigEnvelope: true, personalConfigVersion: true },
      where: { personalConfigEnvelope: { not: null } }
    });
    for (const userServer of userServers) {
      if (!userServer.personalConfigEnvelope) continue;
      const converted = convertEnvelope(
        userServer.personalConfigEnvelope,
        key,
        mcpPersonalConfigEnvelopeContext(userServer.id, userServer.personalConfigVersion)
      );
      if (!converted.converted) continue;
      const updated = await tx.mcpUserServer.updateMany({
        data: { personalConfigEnvelope: converted.envelope },
        where: {
          id: userServer.id,
          personalConfigEnvelope: userServer.personalConfigEnvelope,
          personalConfigVersion: userServer.personalConfigVersion
        }
      });
      requireUpdated(updated.count);
      result.convertedPersonalConfigs += 1;
    }

    const oauthClients = await tx.mcpOAuthClient.findMany({
      select: { clientSecretEnvelope: true, clientSecretGeneration: true, id: true },
      where: { clientSecretEnvelope: { not: null } }
    });
    for (const oauthClient of oauthClients) {
      if (!oauthClient.clientSecretEnvelope) continue;
      const converted = convertEnvelope(
        oauthClient.clientSecretEnvelope,
        key,
        mcpOAuthClientSecretEnvelopeContext(
          oauthClient.id,
          oauthClient.clientSecretGeneration
        )
      );
      if (!converted.converted) continue;
      const updated = await tx.mcpOAuthClient.updateMany({
        data: { clientSecretEnvelope: converted.envelope },
        where: {
          clientSecretEnvelope: oauthClient.clientSecretEnvelope,
          clientSecretGeneration: oauthClient.clientSecretGeneration,
          id: oauthClient.id
        }
      });
      requireUpdated(updated.count);
      result.convertedOAuthClientSecrets += 1;
    }

    const oauthConnections = await tx.mcpOAuthConnection.findMany({
      select: { id: true, tokenEnvelope: true, tokenGeneration: true },
      where: { tokenEnvelope: { not: null } }
    });
    for (const connection of oauthConnections) {
      if (!connection.tokenEnvelope) continue;
      const converted = convertEnvelope(
        connection.tokenEnvelope,
        key,
        mcpOAuthTokenEnvelopeContext(connection.id, connection.tokenGeneration)
      );
      if (!converted.converted) continue;
      const updated = await tx.mcpOAuthConnection.updateMany({
        data: { tokenEnvelope: converted.envelope },
        where: {
          id: connection.id,
          tokenEnvelope: connection.tokenEnvelope,
          tokenGeneration: connection.tokenGeneration
        }
      });
      requireUpdated(updated.count);
      result.convertedOAuthTokens += 1;
    }

    const runtimeGenerations = await tx.mcpRuntimeGeneration.findMany({
      select: { effectiveConfigEnvelope: true, fingerprint: true, id: true },
      where: { effectiveConfigEnvelope: { not: null } }
    });
    for (const generation of runtimeGenerations) {
      if (!generation.effectiveConfigEnvelope) continue;
      const converted = convertEnvelope(
        generation.effectiveConfigEnvelope,
        key,
        mcpRuntimeGenerationEnvelopeContext(generation.id, generation.fingerprint)
      );
      if (!converted.converted) continue;
      const updated = await tx.mcpRuntimeGeneration.updateMany({
        data: { effectiveConfigEnvelope: converted.envelope },
        where: {
          effectiveConfigEnvelope: generation.effectiveConfigEnvelope,
          fingerprint: generation.fingerprint,
          id: generation.id
        }
      });
      requireUpdated(updated.count);
      result.convertedRuntimeConfigs += 1;
    }

    const remainder = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS "count"
      FROM (
        SELECT "sharedConfigEnvelope" AS envelope
        FROM "McpServer"
        WHERE "sharedConfigEnvelope" IS NOT NULL
        UNION ALL
        SELECT "personalConfigEnvelope"
        FROM "McpUserServer"
        WHERE "personalConfigEnvelope" IS NOT NULL
        UNION ALL
        SELECT "clientSecretEnvelope"
        FROM "McpOAuthClient"
        WHERE "clientSecretEnvelope" IS NOT NULL
        UNION ALL
        SELECT "tokenEnvelope"
        FROM "McpOAuthConnection"
        WHERE "tokenEnvelope" IS NOT NULL
        UNION ALL
        SELECT "effectiveConfigEnvelope"
        FROM "McpRuntimeGeneration"
        WHERE "effectiveConfigEnvelope" IS NOT NULL
      ) AS envelopes
      WHERE envelope NOT LIKE 'v2.%'
    `;
    if (remainder[0]?.count !== 0n) {
      throw new McpEnvelopeCutoverError("mcp_envelope_cutover_incomplete");
    }
  return result;
}

export async function cutOverMcpEnvelopesToV2(
  client: PrismaClient,
  key: Buffer
): Promise<McpEnvelopeV2CutoverResult> {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${MCP_ENVELOPE_CUTOVER_LOCK_KEY}, 0)
      )::text AS "lock"
    `;
    return cutOverMcpEnvelopesToV2InTransaction(tx, key);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 300_000
  });
}

async function main(): Promise<void> {
  const client = new PrismaClient();
  try {
    const result = await cutOverMcpEnvelopesToV2(client, getMcpEncryptionKey());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.$disconnect();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    const code = error instanceof McpEnvelopeCutoverError
      ? error.message
      : "mcp_envelope_cutover_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
