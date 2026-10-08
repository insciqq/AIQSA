import {
  Prisma,
  type AuthIdentityProvider,
  type AuthSignInMethodSetting,
  type AuthSignInPolicy,
  type PrismaClient
} from "@prisma/client";
import type { AdminSignInSecretAction } from "@/lib/contracts/adminSignIn";
import type { AuthSignInMethod } from "@/lib/contracts/authSignInMethods";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import {
  applySignInSecretActions,
  encryptSignInSecrets,
  readSignInSecretSlot
} from "./secrets";

export const SIGN_IN_POLICY_ID = "installation";

/** Session sign-in methods that prove an administrator can get back in without a local password. */
export const LOCKOUT_SAFE_SIGN_IN_METHODS: ReadonlySet<string> = new Set([
  "google",
  "yandex",
  "oidc",
  "ldap",
  "saml",
  "trusted_header"
]);

export type SignInSettingsFailureCode =
  | "active_conflict"
  | "draft_conflict"
  | "encryption_unavailable"
  | "invalid_configuration"
  | "invalid_state"
  | "lockout_risk"
  | "not_configured"
  | "not_tested"
  | "policy_conflict"
  | "secret_unreadable"
  | "source_changed";

export type SignInSettingsResult<T> =
  | { ok: true; value: T }
  | { affectedIdentities?: number; code: SignInSettingsFailureCode; ok: false };

export type SignInPolicyRecord = Pick<
  AuthSignInPolicy,
  "passwordLoginEnabled" | "registrationEnabled" | "updatedAt" | "version"
>;

export type SignInSettingsRepository = {
  activate(input: {
    actorUserId: string;
    expectedActiveVersion: number;
    expectedDraftVersion: number;
    /** The administrator confirmed that identities of another source stop signing in. */
    confirmSourceChange: boolean;
    /**
     * Decrypts and validates the draft about to become active and names the source its
     * identities will be bound to; identities of `provider` bound to another source stop
     * signing in, so their count needs `confirmSourceChange`.
     */
    inspectDraft(row: AuthSignInMethodSetting):
      | { problem: SignInSettingsFailureCode }
      | { problem: null; source: { provider: AuthIdentityProvider; source: string } | null };
    method: AuthSignInMethod;
    now: Date;
    requiresTest: boolean;
  }): Promise<SignInSettingsResult<AuthSignInMethodSetting>>;
  /**
   * Turns an admin configuration off. While password sign-in is off, the method the acting
   * session signed in with stays on unless its environment fallback keeps it active.
   */
  disable(input: {
    actorUserId: string;
    /** Methods whose environment fallback is configured (Google and Yandex). */
    environmentMethods: ReadonlySet<string>;
    expectedActiveVersion: number;
    method: AuthSignInMethod;
    now: Date;
    /** The acting administrator's current session, for the lockout guard. */
    sessionId: string;
  }): Promise<SignInSettingsResult<AuthSignInMethodSetting>>;
  /** Enabled rows, the only ones sign-in reads. */
  loadEnabled(): Promise<AuthSignInMethodSetting[]>;
  read(method: AuthSignInMethod): Promise<AuthSignInMethodSetting | null>;
  readAll(): Promise<AuthSignInMethodSetting[]>;
  readPolicy(): Promise<SignInPolicyRecord | null>;
  readSessionSignInMethod(sessionId: string): Promise<string | null>;
  /** Content-free sign-in health of the active version; false when the version moved on. */
  recordHealth(input: { activeVersion: number; at: Date; code: string; method: AuthSignInMethod }): Promise<boolean>;
  recordDraftTest(input: {
    at: Date;
    code: string;
    draftVersion: number;
    method: AuthSignInMethod;
    passed: boolean;
  }): Promise<SignInSettingsResult<AuthSignInMethodSetting>>;
  saveDraft(input: {
    actorUserId: string;
    config: Prisma.InputJsonValue;
    expectedDraftVersion: number;
    method: AuthSignInMethod;
    now: Date;
    secretActions: Record<string, AdminSignInSecretAction>;
    /** The method's secret schema; a draft must carry every required secret. */
    validateSecrets(secrets: Record<string, string>): boolean;
  }): Promise<SignInSettingsResult<AuthSignInMethodSetting>>;
  updatePolicy(input: {
    actorUserId: string;
    /** Methods whose environment fallback is configured (Google and Yandex). */
    environmentMethods: ReadonlySet<string>;
    expectedVersion: number;
    now: Date;
    passwordLoginEnabled: boolean;
    registrationEnabled: boolean;
    /** The acting administrator's current session, for the lockout guard. */
    sessionId: string;
  }): Promise<SignInSettingsResult<SignInPolicyRecord>>;
};

function success<T>(value: T): SignInSettingsResult<T> {
  return { ok: true, value };
}

function failure<T>(code: SignInSettingsFailureCode, affectedIdentities?: number): SignInSettingsResult<T> {
  return affectedIdentities === undefined ? { code, ok: false } : { affectedIdentities, code, ok: false };
}

async function lockSetting(
  tx: Prisma.TransactionClient,
  method: AuthSignInMethod
): Promise<AuthSignInMethodSetting> {
  await tx.$executeRaw`
    INSERT INTO "AuthSignInMethodSetting" ("method") VALUES (${method})
    ON CONFLICT ("method") DO NOTHING
  `;
  await tx.$queryRaw`SELECT "method" FROM "AuthSignInMethodSetting" WHERE "method" = ${method} FOR UPDATE`;
  const row = await tx.authSignInMethodSetting.findUnique({ where: { method } });
  if (!row) throw new Error("auth_sign_in_method_setting_missing");
  return row;
}

const clearedHealth = {
  healthActiveVersion: null,
  lastAcceptedAt: null,
  lastAttemptAt: null,
  lastFailureAt: null,
  lastFailureCode: null
} as const;

export function createPrismaSignInSettingsRepository(input: {
  encryptionKey?: () => Buffer;
  prisma: PrismaClient;
}): SignInSettingsRepository {
  const prisma = input.prisma;
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;

  return {
    async readAll() {
      return prisma.authSignInMethodSetting.findMany({ orderBy: { method: "asc" } }).catch(retainDatabaseFailure);
    },

    async read(method) {
      return prisma.authSignInMethodSetting.findUnique({ where: { method } }).catch(retainDatabaseFailure);
    },

    async loadEnabled() {
      return prisma.authSignInMethodSetting.findMany({ where: { enabled: true } }).catch(retainDatabaseFailure);
    },

    async saveDraft(request) {
      return prisma.$transaction<SignInSettingsResult<AuthSignInMethodSetting>>(async (tx) => {
        const current = await lockSetting(tx, request.method);
        if (current.draftVersion !== request.expectedDraftVersion) return failure("draft_conflict");

        let stored: Record<string, string>;
        let readable = true;
        try {
          stored = readSignInSecretSlot({
            envelope: current.draftSecretEnvelope,
            generation: current.draftSecretGeneration,
            key: encryptionKey,
            method: request.method
          });
        } catch {
          // An unreadable draft secret can only be replaced, never carried into a new draft.
          stored = {};
          readable = false;
        }
        const next = applySignInSecretActions(stored, request.secretActions);
        if (!request.validateSecrets(next.secrets)) {
          return failure(readable ? "invalid_configuration" : "secret_unreadable");
        }

        let envelope = current.draftSecretEnvelope;
        let generation = current.draftSecretGeneration;
        let counter = current.secretGenerationCounter;
        if (next.changed || !readable) {
          if (Object.keys(next.secrets).length === 0) {
            envelope = null;
            generation = null;
          } else {
            counter += 1;
            try {
              envelope = encryptSignInSecrets({
                generation: counter,
                key: encryptionKey(),
                method: request.method,
                secrets: next.secrets
              });
            } catch {
              return failure("encryption_unavailable");
            }
            generation = counter;
          }
        }

        const updated = await tx.authSignInMethodSetting.update({
          data: {
            configurationUpdatedAt: request.now,
            configurationUpdatedByUserId: request.actorUserId,
            draftConfig: request.config,
            draftSecretEnvelope: envelope,
            draftSecretGeneration: generation,
            draftTestAt: null,
            draftTestCode: null,
            draftTestVersion: null,
            draftVersion: { increment: 1 },
            secretGenerationCounter: counter,
            testedDraftVersion: null
          },
          where: { method: request.method }
        });
        return success(updated);
      }).catch(retainDatabaseFailure);
    },

    async recordDraftTest(request) {
      const result = await prisma.authSignInMethodSetting.updateMany({
        data: {
          draftTestAt: request.at,
          draftTestCode: request.code,
          draftTestVersion: request.draftVersion,
          testedDraftVersion: request.passed ? request.draftVersion : null
        },
        where: { draftConfig: { not: Prisma.DbNull }, draftVersion: request.draftVersion, method: request.method }
      }).catch(retainDatabaseFailure);
      if (result.count !== 1) return failure("draft_conflict");
      const row = await prisma.authSignInMethodSetting.findUnique({ where: { method: request.method } }).catch(retainDatabaseFailure);
      return row ? success(row) : failure("draft_conflict");
    },

    async activate(request) {
      return prisma.$transaction<SignInSettingsResult<AuthSignInMethodSetting>>(async (tx) => {
        const current = await lockSetting(tx, request.method);
        if (current.draftVersion !== request.expectedDraftVersion) return failure("draft_conflict");
        if (current.activeVersion !== request.expectedActiveVersion) return failure("active_conflict");
        if (current.draftConfig === null) return failure("not_configured");
        if (request.requiresTest && current.testedDraftVersion !== current.draftVersion) return failure("not_tested");
        const draft = request.inspectDraft(current);
        if (draft.problem) return failure(draft.problem);

        if (draft.source) {
          const affectedIdentities = await tx.authIdentity.count({
            where: { provider: draft.source.provider, source: { not: draft.source.source } }
          });
          if (affectedIdentities > 0 && !request.confirmSourceChange) {
            return failure("source_changed", affectedIdentities);
          }
        }

        const activeVersion = current.activeVersion + 1;
        const updated = await tx.authSignInMethodSetting.update({
          data: {
            activatedAt: request.now,
            activatedByUserId: request.actorUserId,
            activeConfig: current.draftConfig as Prisma.InputJsonValue,
            activeSecretEnvelope: current.draftSecretEnvelope,
            activeSecretGeneration: current.draftSecretGeneration,
            activeVersion,
            configurationUpdatedAt: request.now,
            configurationUpdatedByUserId: request.actorUserId,
            enabled: true,
            ...clearedHealth,
            healthActiveVersion: activeVersion
          },
          where: { method: request.method }
        });
        return success(updated);
      }).catch(retainDatabaseFailure);
    },

    async disable(request) {
      return prisma.$transaction<SignInSettingsResult<AuthSignInMethodSetting>>(async (tx) => {
        // Lock order shared with updatePolicy: the policy row first, then the method row.
        const policy = await tx.$queryRaw<{ passwordLoginEnabled: boolean }[]>`
          SELECT "passwordLoginEnabled" FROM "AuthSignInPolicy" WHERE "id" = ${SIGN_IN_POLICY_ID} FOR SHARE
        `;
        const current = await lockSetting(tx, request.method);
        if (current.activeVersion !== request.expectedActiveVersion) return failure("active_conflict");
        if (current.activeConfig === null || !current.enabled) return failure("not_configured");
        if (policy[0]?.passwordLoginEnabled === false && !request.environmentMethods.has(request.method)) {
          // With passwords off, the acting administrator's own way in stays on; the bootstrap
          // token remains the break-glass sign-in.
          const session = await tx.authSession.findUnique({
            select: { signInMethod: true },
            where: { id: request.sessionId }
          });
          if (session?.signInMethod === request.method) return failure("lockout_risk");
        }
        const updated = await tx.authSignInMethodSetting.update({
          data: {
            activeVersion: current.activeVersion + 1,
            configurationUpdatedAt: request.now,
            configurationUpdatedByUserId: request.actorUserId,
            enabled: false,
            ...clearedHealth
          },
          where: { method: request.method }
        });
        return success(updated);
      }).catch(retainDatabaseFailure);
    },

    async recordHealth(request) {
      const accepted = request.code === "accepted";
      const result = await prisma.authSignInMethodSetting.updateMany({
        data: accepted
          ? { healthActiveVersion: request.activeVersion, lastAcceptedAt: request.at, lastAttemptAt: request.at }
          : {
              healthActiveVersion: request.activeVersion,
              lastAttemptAt: request.at,
              lastFailureAt: request.at,
              lastFailureCode: request.code
            },
        where: {
          activeVersion: request.activeVersion,
          enabled: true,
          method: request.method,
          OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: request.at } }]
        }
      }).catch(retainDatabaseFailure);
      return result.count === 1;
    },

    async readPolicy() {
      return prisma.authSignInPolicy.findUnique({
        select: { passwordLoginEnabled: true, registrationEnabled: true, updatedAt: true, version: true },
        where: { id: SIGN_IN_POLICY_ID }
      }).catch(retainDatabaseFailure);
    },

    async readSessionSignInMethod(sessionId) {
      const session = await prisma.authSession.findUnique({
        select: { signInMethod: true },
        where: { id: sessionId }
      }).catch(retainDatabaseFailure);
      return session?.signInMethod ?? null;
    },

    async updatePolicy(request) {
      try {
        return await prisma.$transaction<SignInSettingsResult<SignInPolicyRecord>>(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "AuthSignInPolicy" WHERE "id" = ${SIGN_IN_POLICY_ID} FOR UPDATE`;
          const current = await tx.authSignInPolicy.findUnique({ where: { id: SIGN_IN_POLICY_ID } });
          if ((current?.version ?? 0) !== request.expectedVersion) return failure("policy_conflict");

          const passwordWasEnabled = current?.passwordLoginEnabled ?? true;
          if (passwordWasEnabled && !request.passwordLoginEnabled) {
            // Turning local passwords off is allowed only from a session that proved another
            // way in that is still active; the bootstrap token stays the break-glass path.
            const session = await tx.authSession.findUnique({
              select: { revokedAt: true, signInMethod: true },
              where: { id: request.sessionId }
            });
            const method = session && !session.revokedAt ? session.signInMethod : null;
            if (!method || !LOCKOUT_SAFE_SIGN_IN_METHODS.has(method)) return failure("lockout_risk");
            const rows = await tx.$queryRaw<{ enabled: boolean }[]>`
              SELECT "enabled" FROM "AuthSignInMethodSetting" WHERE "method" = ${method} FOR SHARE
            `;
            if (rows[0]?.enabled !== true && !request.environmentMethods.has(method)) return failure("lockout_risk");
          }

          const data = {
            passwordLoginEnabled: request.passwordLoginEnabled,
            registrationEnabled: request.registrationEnabled,
            updatedByUserId: request.actorUserId
          };
          const select = { passwordLoginEnabled: true, registrationEnabled: true, updatedAt: true, version: true } as const;
          const updated = current
            ? await tx.authSignInPolicy.update({
                data: { ...data, version: { increment: 1 } },
                select,
                where: { id: SIGN_IN_POLICY_ID }
              })
            : await tx.authSignInPolicy.create({ data: { ...data, id: SIGN_IN_POLICY_ID, version: 1 }, select });
          return success(updated);
        });
      } catch (error) {
        // Two first writers race on the singleton insert; the loser re-reads like any conflict.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return failure("policy_conflict");
        }
        return retainDatabaseFailure(error);
      }
    }
  };
}
