import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  type SecretEnvelopeContext
} from "../secrets/envelope";

const MAX_PROVIDER_SECRET_BYTES = 16 * 1_024;

type StoredProviderCredential = {
  secret: string;
  version: 1;
};

function context(credentialId: string, valueId: string): SecretEnvelopeContext {
  return {
    ownerId: credentialId,
    purpose: "provider_credential",
    valueId
  };
}

export function normalizeProviderCredentialSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_PROVIDER_SECRET_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("provider_credential_secret_invalid");
  }
  return value;
}

export function encryptProviderCredentialSecret(input: {
  credentialId: string;
  key: Buffer;
  secret: string;
  valueId: string;
}): string {
  return encryptSecretEnvelope(
    {
      secret: normalizeProviderCredentialSecret(input.secret),
      version: 1
    } satisfies StoredProviderCredential,
    input.key,
    context(input.credentialId, input.valueId)
  );
}

export function decryptProviderCredentialSecret(input: {
  credentialId: string;
  envelope: string;
  key: Buffer;
  valueId: string;
}): string {
  const stored = decryptSecretEnvelope<StoredProviderCredential>(
    input.envelope,
    input.key,
    context(input.credentialId, input.valueId)
  );
  if (stored.version !== 1) {
    throw new Error("provider_credential_secret_invalid");
  }
  return normalizeProviderCredentialSecret(stored.secret);
}
