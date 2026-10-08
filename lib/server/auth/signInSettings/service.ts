import type { AuthIdentityProvider, AuthSignInMethodSetting, Prisma } from "@prisma/client";
import {
  isSignInOutcomeCode,
  type AdminSignInMethodProblem,
  type AdminSignInMethodState,
  type AdminSignInMethodTest,
  type AdminSignInOverview,
  type AdminSignInPolicyState,
  type AdminSignInSecretAction
} from "@/lib/contracts/adminSignIn";
import {
  AUTH_SIGN_IN_METHOD_SCHEMAS,
  AUTH_SIGN_IN_METHODS,
  isAuthSessionSignInMethod,
  isExternalGroupSource,
  type AuthSignInMethod
} from "@/lib/contracts/authSignInMethods";
import { getAuthConfig } from "../config";
import type { SignInPolicySnapshot } from "../signInPolicy";
import { ENVIRONMENT_SIGN_IN_METHODS } from "../signInMethods";
import { logEvent } from "../../observability";
import { decodeSignInSlot, type ActiveSignInSettingsCache } from "./activeSettings";
import { signInMethodDefinition, type SignInMethodServerRegistry } from "./registry";
import type {
  SignInPolicyRecord,
  SignInSettingsRepository,
  SignInSettingsResult
} from "./repository";
import { readSignInSecretSlot, signInSecretFields } from "./secrets";

export const SIGN_IN_TEST_TIMEOUT_MS = 20_000;

export type SignInMethodServiceResult<T> =
  | SignInSettingsResult<T>
  | { code: "method_unavailable"; ok: false };

export type SignInSettingsService = {
  activate(input: {
    actorUserId: string;
    confirmSourceChange: boolean;
    expectedActiveVersion: number;
    expectedDraftVersion: number;
    method: AuthSignInMethod;
  }): Promise<SignInMethodServiceResult<AdminSignInMethodState>>;
  disable(input: {
    actorUserId: string;
    expectedActiveVersion: number;
    method: AuthSignInMethod;
  }): Promise<SignInMethodServiceResult<AdminSignInMethodState>>;
  /** Whether the method can be configured here: a method task registered it. */
  isAvailable(method: AuthSignInMethod): boolean;
  overview(input: { sessionId: string }): Promise<AdminSignInOverview>;
  readPolicy(): Promise<SignInPolicySnapshot>;
  saveDraft(input: {
    actorUserId: string;
    config: unknown;
    expectedDraftVersion: number;
    method: AuthSignInMethod;
    secretActions: Record<string, AdminSignInSecretAction>;
  }): Promise<SignInMethodServiceResult<AdminSignInMethodState>>;
  test(input: {
    expectedDraftVersion: number;
    method: AuthSignInMethod;
  }): Promise<SignInMethodServiceResult<{ method: AdminSignInMethodState; test: { code: string; passed: boolean } }>>;
  updatePolicy(input: {
    actorUserId: string;
    expectedVersion: number;
    passwordLoginEnabled: boolean;
    registrationEnabled: boolean;
    sessionId: string;
  }): Promise<SignInSettingsResult<AdminSignInPolicyState>>;
};

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function outcomeCode(value: string | null): string | null {
  return isSignInOutcomeCode(value) ? value : null;
}

function policyState(record: SignInPolicyRecord | null): AdminSignInPolicyState {
  return {
    passwordLoginEnabled: record?.passwordLoginEnabled ?? true,
    registrationEnabled: record?.registrationEnabled ?? true,
    updatedAt: iso(record?.updatedAt ?? null),
    version: record?.version ?? 0
  };
}

export function createSignInSettingsService(input: {
  activeSettings: Pick<ActiveSignInSettingsCache, "invalidate">;
  encryptionKey: () => Buffer;
  env?: () => Record<string, string | undefined>;
  now?: () => Date;
  registry: SignInMethodServerRegistry;
  repository: SignInSettingsRepository;
  testTimeoutMs?: number;
}): SignInSettingsService {
  const now = input.now ?? (() => new Date());
  const env = input.env ?? (() => process.env);
  const repository = input.repository;

  const definition = (method: AuthSignInMethod) => signInMethodDefinition(input.registry, method);

  function environmentMethods(): Set<string> {
    const { oauthProviders } = getAuthConfig(env());
    return new Set(ENVIRONMENT_SIGN_IN_METHODS.filter((method) => Boolean(oauthProviders[method])));
  }

  function secretFlags(
    method: AuthSignInMethod,
    envelope: string | null,
    generation: number | null
  ): { flags: Record<string, boolean>; readable: boolean } {
    const fields = signInSecretFields(method);
    try {
      const stored = readSignInSecretSlot({ envelope, generation, key: input.encryptionKey, method });
      return { flags: Object.fromEntries(fields.map((field) => [field, Boolean(stored[field])])), readable: true };
    } catch {
      return { flags: Object.fromEntries(fields.map((field) => [field, false])), readable: false };
    }
  }

  function parsedConfig(method: AuthSignInMethod, value: Prisma.JsonValue | null) {
    if (value === null) return { config: null, valid: true };
    const parsed = AUTH_SIGN_IN_METHOD_SCHEMAS[method].config.safeParse(value);
    return parsed.success ? { config: parsed.data, valid: true } : { config: null, valid: false };
  }

  function stateFrom(method: AuthSignInMethod, row: AuthSignInMethodSetting | null, envMethods: Set<string>): AdminSignInMethodState {
    const draftConfig = parsedConfig(method, row?.draftConfig ?? null);
    const activeConfig = parsedConfig(method, row?.activeConfig ?? null);
    const draftSecrets = secretFlags(method, row?.draftSecretEnvelope ?? null, row?.draftSecretGeneration ?? null);
    const activeSecrets = secretFlags(method, row?.activeSecretEnvelope ?? null, row?.activeSecretGeneration ?? null);
    const testCode = outcomeCode(row?.draftTestCode ?? null);
    const test: AdminSignInMethodTest | null = row && row.draftTestAt && testCode && row.draftTestVersion === row.draftVersion
      ? {
          attemptedAt: row.draftTestAt.toISOString(),
          code: testCode,
          passed: row.testedDraftVersion === row.draftVersion,
          version: row.draftVersion
        }
      : null;
    const enabled = row?.enabled ?? false;
    const activeProblem: AdminSignInMethodProblem | null = !activeConfig.valid
      ? "invalid_configuration"
      : activeSecrets.readable ? null : "secret_unreadable";
    const draftProblem: AdminSignInMethodProblem | null = !draftConfig.valid
      ? "invalid_configuration"
      : draftSecrets.readable ? null : "secret_unreadable";
    const environmentConfigured = envMethods.has(method);
    const healthCurrent = row !== null && row.healthActiveVersion === row.activeVersion;

    return {
      active: {
        activatedAt: iso(row?.activatedAt ?? null),
        config: activeConfig.config,
        enabled,
        secrets: activeSecrets.flags,
        version: row?.activeVersion ?? 0
      },
      draft: {
        config: draftConfig.config,
        matchesActive: enabled && row !== null && row.draftConfig !== null &&
          row.draftSecretEnvelope === row.activeSecretEnvelope &&
          JSON.stringify(row.draftConfig) === JSON.stringify(row.activeConfig),
        secrets: draftSecrets.flags,
        test,
        version: row?.draftVersion ?? 0
      },
      environmentConfigured,
      health: {
        lastAcceptedAt: healthCurrent ? iso(row.lastAcceptedAt) : null,
        lastAttemptAt: healthCurrent ? iso(row.lastAttemptAt) : null,
        lastFailureAt: healthCurrent ? iso(row.lastFailureAt) : null,
        lastFailureCode: healthCurrent ? outcomeCode(row.lastFailureCode) : null
      },
      method,
      problem: enabled ? activeProblem ?? draftProblem : draftProblem,
      requiresTest: Boolean(definition(method)?.test),
      status: enabled ? "active_admin" : environmentConfigured ? "active_environment" : "off"
    } as AdminSignInMethodState;
  }

  const methodState = (method: AuthSignInMethod, row: AuthSignInMethodSetting) => stateFrom(method, row, environmentMethods());

  function audit(code: string): void {
    logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "completed", code });
  }

  return {
    isAvailable: (method) => definition(method) !== null,

    async overview({ sessionId }) {
      const [rows, policy, sessionMethod] = await Promise.all([
        repository.readAll(),
        repository.readPolicy(),
        repository.readSessionSignInMethod(sessionId)
      ]);
      const byMethod = new Map(rows.map((row) => [row.method, row]));
      const envMethods = environmentMethods();
      return {
        appBaseUrl: getAuthConfig(env()).appBaseUrl,
        currentSessionSignInMethod: isAuthSessionSignInMethod(sessionMethod) ? sessionMethod : null,
        methods: AUTH_SIGN_IN_METHODS
          .filter((method) => definition(method) !== null)
          .map((method) => stateFrom(method, byMethod.get(method) ?? null, envMethods)),
        policy: policyState(policy)
      };
    },

    async readPolicy() {
      const state = policyState(await repository.readPolicy());
      return { passwordLoginEnabled: state.passwordLoginEnabled, registrationEnabled: state.registrationEnabled };
    },

    async saveDraft(request) {
      if (!definition(request.method)) return { code: "method_unavailable", ok: false };
      const schemas = AUTH_SIGN_IN_METHOD_SCHEMAS[request.method];
      const config = schemas.config.safeParse(request.config);
      if (!config.success) return { code: "invalid_configuration", ok: false };
      const result = await repository.saveDraft({
        actorUserId: request.actorUserId,
        config: config.data as Prisma.InputJsonValue,
        expectedDraftVersion: request.expectedDraftVersion,
        method: request.method,
        now: now(),
        secretActions: request.secretActions,
        validateSecrets: (secrets) => schemas.secrets.safeParse(secrets).success
      });
      return result.ok ? { ok: true, value: methodState(request.method, result.value) } : result;
    },

    async test(request) {
      const tester = definition(request.method);
      if (!tester) return { code: "method_unavailable", ok: false };
      const row = await repository.read(request.method);
      if (!row || row.draftVersion !== request.expectedDraftVersion) return { code: "draft_conflict", ok: false };
      if (row.draftConfig === null) return { code: "not_configured", ok: false };
      const draft = decodeSignInSlot({
        config: row.draftConfig,
        key: input.encryptionKey,
        method: request.method,
        secretEnvelope: row.draftSecretEnvelope,
        secretGeneration: row.draftSecretGeneration
      });
      if (!draft.ok) return { code: draft.code, ok: false };

      let verdict: { code: string; passed: boolean } = { code: "no_test_required", passed: true };
      if (tester.test) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.testTimeoutMs ?? SIGN_IN_TEST_TIMEOUT_MS);
        try {
          const result = await tester.test({
            appBaseUrl: getAuthConfig(env()).appBaseUrl,
            config: draft.config,
            secrets: draft.secrets,
            signal: controller.signal
          });
          verdict = isSignInOutcomeCode(result.code) && typeof result.passed === "boolean"
            ? { code: result.code, passed: result.passed }
            : { code: "test_failed", passed: false };
        } catch {
          verdict = { code: controller.signal.aborted ? "test_timeout" : "test_failed", passed: false };
        } finally {
          clearTimeout(timer);
        }
      }

      const recorded = await repository.recordDraftTest({
        at: now(),
        code: verdict.code,
        draftVersion: row.draftVersion,
        method: request.method,
        passed: verdict.passed
      });
      return recorded.ok
        ? { ok: true, value: { method: methodState(request.method, recorded.value), test: verdict } }
        : recorded;
    },

    async activate(request) {
      const methodDefinition = definition(request.method);
      if (!methodDefinition) return { code: "method_unavailable", ok: false };
      const result = await repository.activate({
        actorUserId: request.actorUserId,
        confirmSourceChange: request.confirmSourceChange,
        expectedActiveVersion: request.expectedActiveVersion,
        expectedDraftVersion: request.expectedDraftVersion,
        inspectDraft: (row) => {
          const draft = decodeSignInSlot({
            config: row.draftConfig,
            key: input.encryptionKey,
            method: request.method,
            secretEnvelope: row.draftSecretEnvelope,
            secretGeneration: row.draftSecretGeneration
          });
          if (!draft.ok) return { problem: draft.code };
          const source = methodDefinition.identitySource && isExternalGroupSource(request.method)
            ? methodDefinition.identitySource(draft.config)
            : null;
          return {
            problem: null,
            source: source === null ? null : { provider: request.method as AuthIdentityProvider, source }
          };
        },
        method: request.method,
        now: now(),
        requiresTest: Boolean(methodDefinition.test)
      });
      if (!result.ok) return result;
      input.activeSettings.invalidate();
      audit("sign_in_method_activated");
      return { ok: true, value: methodState(request.method, result.value) };
    },

    async disable(request) {
      if (!definition(request.method)) return { code: "method_unavailable", ok: false };
      const result = await repository.disable({
        actorUserId: request.actorUserId,
        expectedActiveVersion: request.expectedActiveVersion,
        method: request.method,
        now: now()
      });
      if (!result.ok) return result;
      input.activeSettings.invalidate();
      audit("sign_in_method_disabled");
      return { ok: true, value: methodState(request.method, result.value) };
    },

    async updatePolicy(request) {
      const result = await repository.updatePolicy({
        actorUserId: request.actorUserId,
        environmentMethods: environmentMethods(),
        expectedVersion: request.expectedVersion,
        now: now(),
        passwordLoginEnabled: request.passwordLoginEnabled,
        registrationEnabled: request.registrationEnabled,
        sessionId: request.sessionId
      });
      if (!result.ok) return result;
      audit("sign_in_policy_updated");
      return { ok: true, value: policyState(result.value) };
    }
  };
}
