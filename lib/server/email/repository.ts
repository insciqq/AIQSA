import { Prisma, type PrismaClient, type SmtpControl } from "@prisma/client";
import type {
  AdminEmailAttemptCode,
  AdminEmailState
} from "../../contracts/email";
import { getSecretEncryptionKey } from "../secrets/envelope";
import {
  completeSmtpConfiguration,
  normalizeSmtpConfiguration,
  type SmtpCompleteConfiguration,
  type SmtpConfiguration
} from "./definitions";
import {
  applySmtpPasswordAction,
  decryptSmtpPassword,
  normalizeSmtpPasswordAction,
  SMTP_CONTROL_OWNER_ID,
  type SmtpPasswordAction,
  type SmtpPasswordReference
} from "./passwordEnvelope";

export const SMTP_CONTROL_ID = SMTP_CONTROL_OWNER_ID;

const ATTEMPT_CODES = new Set<AdminEmailAttemptCode>([
  "accepted",
  "ambiguous_after_data",
  "invalid_configuration",
  "overloaded",
  "secret_unreadable",
  "smtp_address_forbidden",
  "smtp_authentication_failed",
  "smtp_authentication_unavailable",
  "smtp_command_timeout",
  "smtp_connect_timeout",
  "smtp_connection_failed",
  "smtp_data_rejected",
  "smtp_dns_failed",
  "smtp_ehlo_failed",
  "smtp_greeting_rejected",
  "smtp_invalid_input",
  "smtp_protocol_error",
  "smtp_recipient_rejected",
  "smtp_reply_limit",
  "smtp_sender_rejected",
  "smtp_starttls_failed",
  "smtp_starttls_unavailable",
  "smtp_tls_failed",
  "smtp_total_timeout"
]);

export type EmailRepositoryFailureCode =
  | "active_conflict"
  | "draft_conflict"
  | "encryption_unavailable"
  | "invalid_configuration"
  | "invalid_state"
  | "not_configured"
  | "not_tested"
  | "secret_unreadable";

export type EmailRepositoryResult<T> =
  | { ok: false; code: EmailRepositoryFailureCode }
  | { ok: true; value: T };

export type SmtpDraftSnapshot = {
  configuration: SmtpCompleteConfiguration;
  draftVersion: number;
};

export type SmtpActiveSnapshot =
  | { kind: "ready"; activeVersion: number; configuration: SmtpCompleteConfiguration }
  | { kind: "unavailable" }
  | {
      kind: "failure";
      activeVersion: number;
      code: "invalid_configuration" | "secret_unreadable";
    };

export type EmailRepository = {
  activate(input: {
    actorUserId: string;
    expectedActiveVersion: number;
    expectedDraftVersion: number;
    now: Date;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
  clear(input: {
    actorUserId: string;
    expectedActiveVersion: number;
    expectedDraftVersion: number;
    now: Date;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
  disable(input: {
    actorUserId: string;
    expectedActiveVersion: number;
    now: Date;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
  enable(input: {
    actorUserId: string;
    expectedActiveVersion: number;
    now: Date;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
  loadActiveForSend(): Promise<EmailRepositoryResult<SmtpActiveSnapshot>>;
  loadDraftForTest(expectedDraftVersion: number): Promise<EmailRepositoryResult<SmtpDraftSnapshot>>;
  readAdminState(): Promise<EmailRepositoryResult<AdminEmailState>>;
  recordDeliveryOutcome(input: {
    activeVersion: number;
    at: Date;
    code: AdminEmailAttemptCode;
  }): Promise<boolean>;
  recordDraftTest(input: {
    at: Date;
    code: AdminEmailAttemptCode;
    draftVersion: number;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
  saveDraft(input: {
    actorUserId: string;
    configuration: unknown;
    expectedDraftVersion: number;
    now: Date;
    passwordAction: unknown;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
};

type SmtpTransaction = Prisma.TransactionClient;

function success<T>(value: T): EmailRepositoryResult<T> {
  return { ok: true, value };
}

function failure<T>(code: EmailRepositoryFailureCode): EmailRepositoryResult<T> {
  return { ok: false, code };
}

function attemptCode(value: string | null): AdminEmailAttemptCode | null {
  return value && ATTEMPT_CODES.has(value as AdminEmailAttemptCode)
    ? value as AdminEmailAttemptCode
    : null;
}

function referenceFrom(
  envelope: string | null,
  generation: number | null
): SmtpPasswordReference | null | undefined {
  if (envelope === null && generation === null) return null;
  if (envelope === null || generation === null || generation < 1) return undefined;
  return { envelope, generation };
}

function normalizedSlot(input: {
  configuration: Prisma.JsonValue | null;
  envelope: string | null;
  generation: number | null;
}): { configuration: SmtpConfiguration | null; passwordConfigured: boolean } | null {
  const reference = referenceFrom(input.envelope, input.generation);
  if (typeof reference === "undefined") return null;
  if (input.configuration === null) {
    return reference === null ? { configuration: null, passwordConfigured: false } : null;
  }

  try {
    const configuration = normalizeSmtpConfiguration(input.configuration);
    if (configuration.authentication.mode === "none" && reference !== null) return null;
    if (configuration.authentication.mode === "password" && reference === null) return null;
    return { configuration, passwordConfigured: reference !== null };
  } catch {
    return null;
  }
}

function stateFrom(record: SmtpControl): EmailRepositoryResult<AdminEmailState> {
  const draft = normalizedSlot({
    configuration: record.draftConfig,
    envelope: record.draftPasswordEnvelope,
    generation: record.draftSecretGeneration
  });
  const active = normalizedSlot({
    configuration: record.activeConfig,
    envelope: record.activePasswordEnvelope,
    generation: record.activeSecretGeneration
  });
  if (!draft || !active || (record.enabled && active.configuration === null)) {
    return failure("invalid_state");
  }

  const testCode = attemptCode(record.draftTestCode);
  const hasTest = record.draftTestVersion !== null || record.draftTestAt !== null || record.draftTestCode !== null;
  if (
    hasTest &&
    (record.draftTestVersion !== record.draftVersion || record.draftTestAt === null || testCode === null)
  ) {
    return failure("invalid_state");
  }
  if (
    record.testedDraftVersion !== null &&
    (record.testedDraftVersion !== record.draftVersion || testCode !== "accepted")
  ) {
    return failure("invalid_state");
  }

  const lastFailureCode = attemptCode(record.lastFailureCode);
  const hasHealth = record.healthActiveVersion !== null || record.lastAttemptAt !== null ||
    record.lastAcceptedAt !== null || record.lastFailureAt !== null || record.lastFailureCode !== null;
  if (
    (record.lastFailureAt === null) !== (record.lastFailureCode === null) ||
    (record.lastFailureCode !== null && lastFailureCode === null) ||
    (hasHealth && record.healthActiveVersion !== record.activeVersion)
  ) {
    return failure("invalid_state");
  }
  const healthIsCurrent = record.healthActiveVersion === record.activeVersion;
  const degraded = healthIsCurrent && record.lastFailureAt !== null &&
    (record.lastAcceptedAt === null || record.lastFailureAt > record.lastAcceptedAt);

  return success({
    active: {
      activatedAt: record.activatedAt?.toISOString() ?? null,
      activatedByUserId: record.activatedByUserId,
      configuration: active.configuration,
      enabled: record.enabled,
      passwordConfigured: active.passwordConfigured,
      version: record.activeVersion
    },
    configurationUpdatedAt: record.configurationUpdatedAt?.toISOString() ?? null,
    configurationUpdatedByUserId: record.configurationUpdatedByUserId,
    draft: {
      configuration: draft.configuration,
      passwordConfigured: draft.passwordConfigured,
      test: hasTest && record.draftTestAt && testCode
        ? {
            attemptedAt: record.draftTestAt.toISOString(),
            code: testCode,
            tested: record.testedDraftVersion === record.draftVersion,
            version: record.draftVersion
          }
        : null,
      version: record.draftVersion
    },
    health: {
      activeVersion: record.healthActiveVersion,
      degraded,
      lastAcceptedAt: record.lastAcceptedAt?.toISOString() ?? null,
      lastAttemptAt: record.lastAttemptAt?.toISOString() ?? null,
      lastFailureAt: record.lastFailureAt?.toISOString() ?? null,
      lastFailureCode
    }
  });
}

function completeStoredSlot(input: {
  configuration: Prisma.JsonValue | null;
  encryptionKey: () => Buffer;
  envelope: string | null;
  generation: number | null;
}): EmailRepositoryResult<SmtpCompleteConfiguration> {
  if (input.configuration === null) return failure("not_configured");
  let configuration: SmtpConfiguration;
  try {
    configuration = normalizeSmtpConfiguration(input.configuration);
  } catch {
    return failure("invalid_configuration");
  }

  const reference = referenceFrom(input.envelope, input.generation);
  if (typeof reference === "undefined") return failure("invalid_configuration");
  if (configuration.authentication.mode === "none") {
    if (reference !== null) return failure("invalid_configuration");
    return success(completeSmtpConfiguration({ configuration, password: null }));
  }
  if (reference === null) return failure("invalid_configuration");

  try {
    const password = decryptSmtpPassword({
      envelope: reference.envelope,
      generation: reference.generation,
      key: input.encryptionKey()
    });
    return success(completeSmtpConfiguration({ configuration, password }));
  } catch {
    return failure("secret_unreadable");
  }
}

async function lockControl(tx: SmtpTransaction): Promise<SmtpControl> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "SmtpControl" WHERE "id" = ${SMTP_CONTROL_ID} FOR UPDATE`
  );
  const record = await tx.smtpControl.findUnique({ where: { id: SMTP_CONTROL_ID } });
  if (!record) throw new Error("smtp_control_missing");
  return record;
}

function json(configuration: SmtpConfiguration): Prisma.InputJsonValue {
  return configuration as Prisma.InputJsonValue;
}

function resetHealth(activeVersion: number): Pick<
  Prisma.SmtpControlUpdateInput,
  | "healthActiveVersion"
  | "lastAcceptedAt"
  | "lastAttemptAt"
  | "lastFailureAt"
  | "lastFailureCode"
> {
  return {
    healthActiveVersion: activeVersion,
    lastAcceptedAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastFailureCode: null
  };
}

export function createPrismaEmailRepository(input: {
  encryptionKey?: () => Buffer;
  prisma: PrismaClient;
}): EmailRepository {
  const prisma = input.prisma;
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;

  return {
    async readAdminState() {
      const record = await prisma.smtpControl.findUnique({ where: { id: SMTP_CONTROL_ID } });
      if (!record) throw new Error("smtp_control_missing");
      return stateFrom(record);
    },

    async saveDraft(request) {
      let configuration: SmtpConfiguration;
      let action: SmtpPasswordAction;
      try {
        configuration = normalizeSmtpConfiguration(request.configuration);
        action = normalizeSmtpPasswordAction(request.passwordAction);
      } catch {
        return failure("invalid_configuration");
      }

      return prisma.$transaction(async (tx) => {
        const current = await lockControl(tx);
        if (current.draftVersion !== request.expectedDraftVersion) {
          return failure("draft_conflict");
        }
        const currentReference = referenceFrom(
          current.draftPasswordEnvelope,
          current.draftSecretGeneration
        );
        if (typeof currentReference === "undefined") return failure("invalid_state");
        if (configuration.authentication.mode === "none" && action.kind !== "clear") {
          return failure("invalid_configuration");
        }

        const replacementGeneration = action.kind === "replace"
          ? current.secretGenerationCounter + 1
          : undefined;
        let nextReference: SmtpPasswordReference | null;
        try {
          nextReference = applySmtpPasswordAction({
            action,
            current: currentReference,
            key: action.kind === "replace" ? encryptionKey() : undefined,
            replacementGeneration
          });
        } catch {
          return failure(action.kind === "replace" ? "encryption_unavailable" : "invalid_configuration");
        }
        if (configuration.authentication.mode === "password" && nextReference === null) {
          return failure("invalid_configuration");
        }

        const updated = await tx.smtpControl.update({
          data: {
            configurationUpdatedAt: request.now,
            configurationUpdatedByUserId: request.actorUserId,
            draftConfig: json(configuration),
            draftPasswordEnvelope: nextReference?.envelope ?? null,
            draftSecretGeneration: nextReference?.generation ?? null,
            draftTestAt: null,
            draftTestCode: null,
            draftTestVersion: null,
            draftVersion: { increment: 1 },
            secretGenerationCounter: replacementGeneration ?? current.secretGenerationCounter,
            testedDraftVersion: null
          },
          where: { id: SMTP_CONTROL_ID }
        });
        return stateFrom(updated);
      });
    },

    async loadDraftForTest(expectedDraftVersion) {
      const record = await prisma.smtpControl.findUnique({ where: { id: SMTP_CONTROL_ID } });
      if (!record) throw new Error("smtp_control_missing");
      if (record.draftVersion !== expectedDraftVersion) return failure("draft_conflict");
      const completed = completeStoredSlot({
        configuration: record.draftConfig,
        encryptionKey,
        envelope: record.draftPasswordEnvelope,
        generation: record.draftSecretGeneration
      });
      return completed.ok
        ? success({ configuration: completed.value, draftVersion: record.draftVersion })
        : completed;
    },

    async recordDraftTest(request) {
      const result = await prisma.smtpControl.updateMany({
        data: {
          draftTestAt: request.at,
          draftTestCode: request.code,
          draftTestVersion: request.draftVersion,
          testedDraftVersion: request.code === "accepted" ? request.draftVersion : null
        },
        where: { draftVersion: request.draftVersion, id: SMTP_CONTROL_ID }
      });
      if (result.count !== 1) return failure("draft_conflict");
      const record = await prisma.smtpControl.findUnique({ where: { id: SMTP_CONTROL_ID } });
      if (!record) throw new Error("smtp_control_missing");
      return stateFrom(record);
    },

    async activate(request) {
      return prisma.$transaction(async (tx) => {
        const current = await lockControl(tx);
        if (current.draftVersion !== request.expectedDraftVersion) return failure("draft_conflict");
        if (current.activeVersion !== request.expectedActiveVersion) return failure("active_conflict");
        if (current.draftConfig === null) return failure("not_configured");
        if (current.testedDraftVersion !== current.draftVersion) return failure("not_tested");

        const completed = completeStoredSlot({
          configuration: current.draftConfig,
          encryptionKey,
          envelope: current.draftPasswordEnvelope,
          generation: current.draftSecretGeneration
        });
        if (!completed.ok) return completed;
        const activeVersion = current.activeVersion + 1;
        const updated = await tx.smtpControl.update({
          data: {
            activatedAt: request.now,
            activatedByUserId: request.actorUserId,
            activeConfig: current.draftConfig as Prisma.InputJsonValue,
            activePasswordEnvelope: current.draftPasswordEnvelope,
            activeSecretGeneration: current.draftSecretGeneration,
            activeVersion,
            configurationUpdatedAt: request.now,
            configurationUpdatedByUserId: request.actorUserId,
            enabled: true,
            ...resetHealth(activeVersion)
          },
          where: { id: SMTP_CONTROL_ID }
        });
        return stateFrom(updated);
      });
    },

    async enable(request) {
      return prisma.$transaction(async (tx) => {
        const current = await lockControl(tx);
        if (current.activeVersion !== request.expectedActiveVersion) return failure("active_conflict");
        if (current.activeConfig === null) return failure("not_configured");
        const completed = completeStoredSlot({
          configuration: current.activeConfig,
          encryptionKey,
          envelope: current.activePasswordEnvelope,
          generation: current.activeSecretGeneration
        });
        if (!completed.ok) return completed;
        const activeVersion = current.activeVersion + 1;
        const updated = await tx.smtpControl.update({
          data: {
            activeVersion,
            configurationUpdatedAt: request.now,
            configurationUpdatedByUserId: request.actorUserId,
            enabled: true,
            ...resetHealth(activeVersion)
          },
          where: { id: SMTP_CONTROL_ID }
        });
        return stateFrom(updated);
      });
    },

    async disable(request) {
      return prisma.$transaction(async (tx) => {
        const current = await lockControl(tx);
        if (current.activeVersion !== request.expectedActiveVersion) return failure("active_conflict");
        if (current.activeConfig === null) return failure("not_configured");
        const activeVersion = current.activeVersion + 1;
        const updated = await tx.smtpControl.update({
          data: {
            activeVersion,
            configurationUpdatedAt: request.now,
            configurationUpdatedByUserId: request.actorUserId,
            enabled: false,
            healthActiveVersion: null,
            lastAcceptedAt: null,
            lastAttemptAt: null,
            lastFailureAt: null,
            lastFailureCode: null
          },
          where: { id: SMTP_CONTROL_ID }
        });
        return stateFrom(updated);
      });
    },

    async clear(request) {
      return prisma.$transaction(async (tx) => {
        const current = await lockControl(tx);
        if (current.draftVersion !== request.expectedDraftVersion) return failure("draft_conflict");
        if (current.activeVersion !== request.expectedActiveVersion) return failure("active_conflict");
        const updated = await tx.smtpControl.update({
          data: {
            activatedAt: null,
            activatedByUserId: null,
            activeConfig: Prisma.DbNull,
            activePasswordEnvelope: null,
            activeSecretGeneration: null,
            activeVersion: { increment: 1 },
            configurationUpdatedAt: request.now,
            configurationUpdatedByUserId: request.actorUserId,
            draftConfig: Prisma.DbNull,
            draftPasswordEnvelope: null,
            draftSecretGeneration: null,
            draftTestAt: null,
            draftTestCode: null,
            draftTestVersion: null,
            draftVersion: { increment: 1 },
            enabled: false,
            healthActiveVersion: null,
            lastAcceptedAt: null,
            lastAttemptAt: null,
            lastFailureAt: null,
            lastFailureCode: null,
            testedDraftVersion: null
          },
          where: { id: SMTP_CONTROL_ID }
        });
        return stateFrom(updated);
      });
    },

    async loadActiveForSend() {
      const record = await prisma.smtpControl.findUnique({ where: { id: SMTP_CONTROL_ID } });
      if (!record) throw new Error("smtp_control_missing");
      if (!record.enabled) return success({ kind: "unavailable" });
      if (record.activeConfig === null) {
        return success({
          activeVersion: record.activeVersion,
          code: "invalid_configuration",
          kind: "failure"
        });
      }
      const completed = completeStoredSlot({
        configuration: record.activeConfig,
        encryptionKey,
        envelope: record.activePasswordEnvelope,
        generation: record.activeSecretGeneration
      });
      return completed.ok
        ? success({
            activeVersion: record.activeVersion,
            configuration: completed.value,
            kind: "ready"
          })
        : success({
            activeVersion: record.activeVersion,
            code: completed.code === "secret_unreadable"
              ? "secret_unreadable"
              : "invalid_configuration",
            kind: "failure"
          });
    },

    async recordDeliveryOutcome(request) {
      const accepted = request.code === "accepted";
      const result = await prisma.smtpControl.updateMany({
        data: accepted
          ? {
              healthActiveVersion: request.activeVersion,
              lastAcceptedAt: request.at,
              lastAttemptAt: request.at
            }
          : {
              healthActiveVersion: request.activeVersion,
              lastAttemptAt: request.at,
              lastFailureAt: request.at,
              lastFailureCode: request.code
            },
        where: {
          activeVersion: request.activeVersion,
          enabled: true,
          id: SMTP_CONTROL_ID,
          OR: [
            { lastAttemptAt: null },
            { lastAttemptAt: { lte: request.at } }
          ]
        }
      });
      return result.count === 1;
    }
  };
}
