import type { PrismaClient } from "@prisma/client";
import {
  SPEECH_TO_TEXT_PROVIDER_FAMILIES,
  type AdminSpeechToTextUnavailableReason,
  type CatalogDictation,
  type SpeechToTextProviderFamily
} from "../../contracts/speechToText";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import {
  normalizeProviderConnectionConfiguration,
  providerAuthenticationMode,
  type ProviderConnectionConfiguration
} from "../providers/providerConfiguration";
import { getSecretEncryptionKey } from "../secrets/envelope";

export const SPEECH_TO_TEXT_POLICY_ID = "installation";

export type SpeechToTextDb = Pick<PrismaClient, "providerConnection" | "providerCredential" | "providerCredentialVersion" | "systemModelPolicy">;

/** One connection's current installation authority: its configuration and default key. */
export type SpeechToTextConnectionBinding = Readonly<{
  connection: ProviderConnectionConfiguration;
  connectionDisplayName: string;
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  family: SpeechToTextProviderFamily;
  /** Null exactly for a no-authentication connection; otherwise rechecks revocation on every call. */
  secret: (() => Promise<string>) | null;
}>;

export type SpeechToTextBindingResolution =
  | Readonly<{ binding: SpeechToTextConnectionBinding; ok: true }>
  | Readonly<{ ok: false; reason: Extract<AdminSpeechToTextUnavailableReason, "connection_unavailable" | "credential_unavailable"> }>;

export type SpeechToTextRoleResolution =
  | Readonly<{ binding: SpeechToTextConnectionBinding; modelId: string; ok: true }>
  | Readonly<{ ok: false; reason: "not_configured" | AdminSpeechToTextUnavailableReason }>;

export function isSpeechToTextFamily(value: string): value is SpeechToTextProviderFamily {
  return (SPEECH_TO_TEXT_PROVIDER_FAMILIES as readonly string[]).includes(value);
}

function evidenceMode(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).authenticationMode : undefined;
}

export class SpeechToTextCredentialRevokedError extends Error {
  readonly code = "credential_revoked";
  constructor() {
    super("credential_revoked");
    this.name = "SpeechToTextCredentialRevokedError";
  }
}

/**
 * The connection's enabled active configuration and its enabled, unrevoked
 * default key. The role is installation work: no user assignment applies and
 * nothing substitutes for a missing key.
 */
export async function resolveSpeechToTextConnection(
  db: SpeechToTextDb,
  connectionId: string,
  options: Readonly<{ encryptionKey?: () => Buffer }> = {}
): Promise<SpeechToTextBindingResolution> {
  const row = await db.providerConnection.findUnique({
    select: { activeConfig: true, activeVersion: true, defaultCredentialId: true, displayName: true, enabled: true, family: true, id: true },
    where: { id: connectionId }
  });
  if (!row || !row.enabled || row.activeVersion < 1 || row.activeConfig === null || !isSpeechToTextFamily(row.family)) {
    return { ok: false, reason: "connection_unavailable" };
  }
  let connection: ProviderConnectionConfiguration;
  try {
    connection = normalizeProviderConnectionConfiguration(row.activeConfig);
  } catch {
    return { ok: false, reason: "connection_unavailable" };
  }
  const bearer = providerAuthenticationMode(connection) === "bearer";
  if (row.family === "openrouter" && !bearer) return { ok: false, reason: "connection_unavailable" };
  if (!row.defaultCredentialId) return { ok: false, reason: "credential_unavailable" };
  const credential = await db.providerCredential.findFirst({
    select: { activeVersion: { select: { id: true, revokedAt: true, secretEnvelope: true, testEvidence: true } }, enabled: true, id: true },
    where: { connectionId: row.id, id: row.defaultCredentialId }
  });
  const version = credential?.activeVersion;
  if (!credential || !credential.enabled || !version || version.revokedAt ||
    (bearer ? !version.secretEnvelope || evidenceMode(version.testEvidence) === "none"
      : version.secretEnvelope !== null || evidenceMode(version.testEvidence) !== "none")) {
    return { ok: false, reason: "credential_unavailable" };
  }
  const credentialId = credential.id;
  const credentialVersionId = version.id;
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;
  return {
    binding: {
      connection,
      connectionDisplayName: row.displayName,
      connectionId: row.id,
      credentialId,
      credentialVersionId,
      family: row.family,
      secret: bearer ? async () => {
        // Emergency revocation is checked immediately before every request.
        const current = await db.providerCredentialVersion.findFirst({
          select: { credentialId: true, id: true, revokedAt: true, secretEnvelope: true },
          where: { credentialId, id: credentialVersionId }
        });
        if (!current || current.revokedAt || !current.secretEnvelope) throw new SpeechToTextCredentialRevokedError();
        return decryptProviderCredentialSecret({
          credentialId: current.credentialId,
          envelope: current.secretEnvelope,
          key: encryptionKey(),
          valueId: current.id
        });
      } : null
    },
    ok: true
  };
}

/**
 * The administrator's Speech to text role as it can execute now: the saved
 * connection and model with the default key the passing test used. A replaced
 * key needs a new test; nothing falls back to another connection or model.
 */
export async function resolveSpeechToTextRole(
  db: SpeechToTextDb,
  options: Readonly<{ encryptionKey?: () => Buffer }> = {}
): Promise<SpeechToTextRoleResolution> {
  const policy = await db.systemModelPolicy.findUnique({
    select: { speechToTextConnectionId: true, speechToTextCredentialVersionId: true, speechToTextModelId: true },
    where: { id: SPEECH_TO_TEXT_POLICY_ID }
  });
  if (!policy?.speechToTextConnectionId || !policy.speechToTextModelId) return { ok: false, reason: "not_configured" };
  const resolved = await resolveSpeechToTextConnection(db, policy.speechToTextConnectionId, options);
  if (!resolved.ok) return resolved;
  if (resolved.binding.credentialVersionId !== policy.speechToTextCredentialVersionId) {
    return { ok: false, reason: "verification_required" };
  }
  return { binding: resolved.binding, modelId: policy.speechToTextModelId, ok: true };
}

/** The user catalog's projection: whether the composer shows a microphone and whether it works. */
export function catalogDictation(resolution: SpeechToTextRoleResolution): CatalogDictation {
  if (resolution.ok) return { available: true, unavailableReason: null };
  return { available: false, unavailableReason: resolution.reason === "not_configured" ? "not_configured" : "unavailable" };
}
