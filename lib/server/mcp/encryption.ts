import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  getSecretEncryptionKey,
  SecretEnvelopeError,
  type SecretEnvelopeContext
} from "@/lib/server/secrets/envelope";

export type McpEnvelopeContext = SecretEnvelopeContext;

export type McpEncryptionErrorCode =
  | "mcp_encryption_invalid_envelope"
  | "mcp_encryption_invalid_key";

export class McpEncryptionError extends Error {
  constructor(code: McpEncryptionErrorCode) {
    super(code);
    this.name = "McpEncryptionError";
  }
}

function mapSecretError(error: unknown): never {
  if (error instanceof SecretEnvelopeError && error.message === "secret_encryption_invalid_key") {
    throw new McpEncryptionError("mcp_encryption_invalid_key");
  }
  throw new McpEncryptionError("mcp_encryption_invalid_envelope");
}

function versionContext(
  purpose: string,
  ownerId: string,
  generation: number,
  valuePrefix: string
): SecretEnvelopeContext {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new McpEncryptionError("mcp_encryption_invalid_envelope");
  }
  return { ownerId, purpose, valueId: `${valuePrefix}:${generation}` };
}

export function mcpSharedConfigEnvelopeContext(
  serverId: string,
  sharedConfigVersion: number
): SecretEnvelopeContext {
  return versionContext("mcp_shared_config", serverId, sharedConfigVersion, "shared-config");
}

export function mcpPersonalConfigEnvelopeContext(
  userServerId: string,
  personalConfigVersion: number
): SecretEnvelopeContext {
  return versionContext("mcp_personal_config", userServerId, personalConfigVersion, "personal-config");
}

export function mcpOAuthClientSecretEnvelopeContext(
  oauthClientId: string,
  clientSecretGeneration: number
): SecretEnvelopeContext {
  return versionContext(
    "mcp_oauth_client_secret",
    oauthClientId,
    clientSecretGeneration,
    "client-secret"
  );
}

export function mcpOAuthTokenEnvelopeContext(
  connectionId: string,
  tokenGeneration: number
): SecretEnvelopeContext {
  return versionContext("mcp_oauth_token", connectionId, tokenGeneration, "oauth-token");
}

export function mcpRuntimeGenerationEnvelopeContext(
  generationId: string,
  fingerprint: string
): SecretEnvelopeContext {
  return {
    ownerId: generationId,
    purpose: "mcp_runtime_generation_config",
    valueId: `fingerprint:${fingerprint}`
  };
}

export function getMcpEncryptionKey(
  env: Record<string, string | undefined> = process.env
): Buffer {
  try {
    return getSecretEncryptionKey(env);
  } catch (error) {
    return mapSecretError(error);
  }
}

export function encryptMcpEnvelope(
  value: unknown,
  key: Buffer,
  context: SecretEnvelopeContext
): string {
  try {
    return encryptSecretEnvelope(value, key, context);
  } catch (error) {
    return mapSecretError(error);
  }
}

export function decryptMcpEnvelope<T>(
  envelope: string,
  key: Buffer,
  context: SecretEnvelopeContext
): T {
  try {
    return decryptSecretEnvelope<T>(envelope, key, context);
  } catch (error) {
    return mapSecretError(error);
  }
}
