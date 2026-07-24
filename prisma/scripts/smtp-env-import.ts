import type { Prisma, SmtpControl } from "@prisma/client";
import type { AdminEmailConfiguration } from "../../lib/contracts/email";
import {
  normalizeSmtpConfiguration,
  normalizeSmtpPassword,
  SmtpDefinitionError
} from "../../lib/server/email/definitions";
import {
  encryptSmtpPassword,
  SMTP_CONTROL_OWNER_ID
} from "../../lib/server/email/passwordEnvelope";

export type LegacySmtpImportCandidate = Readonly<{
  configuration: AdminEmailConfiguration;
  password: string | null;
}>;

export type LegacySmtpImportResult = Readonly<{
  imported: boolean;
  skippedConfigured: boolean;
}>;

export class LegacySmtpImportError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "LegacySmtpImportError";
  }
}

function text(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function secret(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function flag(value: string | undefined, fallback: boolean, field: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new LegacySmtpImportError(`smtp_env_invalid_${field}`);
}

function port(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new LegacySmtpImportError("smtp_env_invalid_port");
  }
  return parsed;
}

function mailbox(value: string): { address: string; displayName: string | null } {
  const bracketed = /^(.*?)\s*<([^<>]+)>$/u.exec(value);
  if (!bracketed) return { address: value, displayName: null };
  const rawName = bracketed[1]?.trim() ?? "";
  const displayName = rawName.startsWith('"') && rawName.endsWith('"')
    ? rawName.slice(1, -1).trim()
    : rawName;
  return {
    address: bracketed[2]?.trim() ?? "",
    displayName: displayName || null
  };
}

function errorCode(error: unknown): string {
  if (!(error instanceof SmtpDefinitionError)) return "smtp_env_invalid_configuration";
  if (error.code === "smtp_host_invalid") return "smtp_env_invalid_host";
  if (error.code === "smtp_from_invalid") return "smtp_env_invalid_from";
  if (error.code === "smtp_port_invalid") return "smtp_env_invalid_port";
  if (error.code === "smtp_password_invalid" || error.code === "smtp_authentication_invalid") {
    return "smtp_env_invalid_credentials";
  }
  return "smtp_env_invalid_transport";
}

export function parseLegacySmtpEnvironment(
  env: Record<string, string | undefined>
): LegacySmtpImportCandidate | null {
  const host = text(env.AIQSA_SMTP_HOST);
  const from = text(env.AIQSA_SMTP_FROM);
  const username = text(env.AIQSA_SMTP_USER);
  const password = secret(env.AIQSA_SMTP_PASSWORD);

  // Port, transport flags and timeout limits were commonly present as defaults.
  // Without an endpoint, sender or credentials they do not constitute SMTP setup.
  if (!host && !from && !username && !password) return null;
  if (!host || !from) throw new LegacySmtpImportError("smtp_env_partial_configuration");
  if (Boolean(username) !== Boolean(password)) {
    throw new LegacySmtpImportError("smtp_env_partial_credentials");
  }

  const secure = flag(env.AIQSA_SMTP_SECURE, false, "secure");
  const startTls = flag(env.AIQSA_SMTP_STARTTLS, !secure, "starttls");
  const transport = secure
    ? "implicit_tls" as const
    : startTls
      ? "starttls_required" as const
      : "plaintext_internal_no_auth" as const;
  if (transport === "plaintext_internal_no_auth" && username) {
    throw new LegacySmtpImportError("smtp_env_plaintext_credentials_forbidden");
  }

  try {
    const configuration = normalizeSmtpConfiguration({
      allowInternalNetwork: transport === "plaintext_internal_no_auth",
      authentication: username
        ? { mode: "password", username }
        : { mode: "none" },
      from: mailbox(from),
      host,
      port: port(env.AIQSA_SMTP_PORT, secure ? 465 : 587),
      transport
    });
    return {
      configuration,
      password: password ? normalizeSmtpPassword(password) : null
    };
  } catch (error) {
    if (error instanceof LegacySmtpImportError) throw error;
    throw new LegacySmtpImportError(errorCode(error));
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function pristine(record: SmtpControl): boolean {
  return record.draftConfig === null &&
    record.draftPasswordEnvelope === null &&
    record.draftSecretGeneration === null &&
    record.draftVersion === 0 &&
    record.testedDraftVersion === null &&
    record.activeConfig === null &&
    record.activePasswordEnvelope === null &&
    record.activeSecretGeneration === null &&
    record.activeVersion === 0 &&
    record.enabled === false &&
    record.secretGenerationCounter === 0;
}

export async function importLegacySmtpEnvironment(
  tx: Pick<Prisma.TransactionClient, "smtpControl">,
  key: Buffer,
  env: Record<string, string | undefined>
): Promise<LegacySmtpImportResult> {
  const candidate = parseLegacySmtpEnvironment(env);
  if (!candidate) return { imported: false, skippedConfigured: false };

  const current = await tx.smtpControl.findUnique({
    where: { id: SMTP_CONTROL_OWNER_ID }
  });
  if (!current) throw new LegacySmtpImportError("smtp_env_control_missing");
  if (!pristine(current)) return { imported: false, skippedConfigured: true };

  const generation = candidate.password ? 1 : null;
  await tx.smtpControl.update({
    data: {
      draftConfig: json(candidate.configuration),
      draftPasswordEnvelope: candidate.password
        ? encryptSmtpPassword({ generation: 1, key, password: candidate.password })
        : null,
      draftSecretGeneration: generation,
      draftVersion: 1,
      enabled: false,
      secretGenerationCounter: generation ?? 0
    },
    where: { id: SMTP_CONTROL_OWNER_ID }
  });
  return { imported: true, skippedConfigured: false };
}
