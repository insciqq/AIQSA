import { randomBytes } from "node:crypto";
import type { AuthSignInMethodSetting } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { googleSignInMethod, yandexSignInMethod } from "./oauthClientMethod";
import type { SignInMethodServerRegistry } from "./registry";
import type { SignInSettingsRepository } from "./repository";
import { encryptSignInSecrets } from "./secrets";
import { createSignInSettingsService } from "./service";

const key = randomBytes(32);
const GOOGLE_CLIENT = "1234-abc.apps.googleusercontent.com";

function row(input: Partial<AuthSignInMethodSetting> & { method: string }): AuthSignInMethodSetting {
  return {
    activatedAt: null,
    activatedByUserId: null,
    activeConfig: null,
    activeSecretEnvelope: null,
    activeSecretGeneration: null,
    activeVersion: 0,
    configurationUpdatedAt: null,
    configurationUpdatedByUserId: null,
    createdAt: new Date("2026-10-08T00:00:00.000Z"),
    draftConfig: null,
    draftSecretEnvelope: null,
    draftSecretGeneration: null,
    draftTestAt: null,
    draftTestCode: null,
    draftTestVersion: null,
    draftVersion: 0,
    enabled: false,
    healthActiveVersion: null,
    lastAcceptedAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    secretGenerationCounter: 0,
    testedDraftVersion: null,
    ...input
  };
}

function googleDraft(input: Partial<AuthSignInMethodSetting> = {}): AuthSignInMethodSetting {
  return row({
    draftConfig: { clientId: GOOGLE_CLIENT },
    draftSecretEnvelope: encryptSignInSecrets({ generation: 1, key, method: "google", secrets: { clientSecret: "client-secret-value" } }),
    draftSecretGeneration: 1,
    draftVersion: 2,
    method: "google",
    secretGenerationCounter: 1,
    ...input
  });
}

function repository(rows: AuthSignInMethodSetting[] = []) {
  const byMethod = new Map(rows.map((entry) => [entry.method, entry]));
  const fake = {
    activate: vi.fn<SignInSettingsRepository["activate"]>(async (request) => {
      const current = byMethod.get(request.method)!;
      const draft = request.inspectDraft(current);
      if (draft.problem) return { code: draft.problem, ok: false };
      const updated = { ...current, activeConfig: current.draftConfig, activeVersion: current.activeVersion + 1, activatedAt: request.now, enabled: true };
      byMethod.set(request.method, updated);
      return { ok: true, value: updated };
    }),
    disable: vi.fn<SignInSettingsRepository["disable"]>(async (request) => {
      const updated = { ...byMethod.get(request.method)!, enabled: false };
      byMethod.set(request.method, updated);
      return { ok: true, value: updated };
    }),
    loadEnabled: vi.fn(async () => [...byMethod.values()].filter((entry) => entry.enabled)),
    read: vi.fn(async (method: string) => byMethod.get(method) ?? null),
    readAll: vi.fn(async () => [...byMethod.values()]),
    readPolicy: vi.fn<SignInSettingsRepository["readPolicy"]>(async () => null),
    readSessionSignInMethod: vi.fn(async () => "google"),
    recordDraftTest: vi.fn<SignInSettingsRepository["recordDraftTest"]>(async (request) => {
      const updated = {
        ...byMethod.get(request.method)!,
        draftTestAt: request.at,
        draftTestCode: request.code,
        draftTestVersion: request.draftVersion,
        testedDraftVersion: request.passed ? request.draftVersion : null
      };
      byMethod.set(request.method, updated);
      return { ok: true, value: updated };
    }),
    recordHealth: vi.fn(async () => true),
    saveDraft: vi.fn<SignInSettingsRepository["saveDraft"]>(async (request) => {
      const updated = row({ draftConfig: request.config as never, draftVersion: request.expectedDraftVersion + 1, method: request.method });
      byMethod.set(request.method, updated);
      return { ok: true, value: updated };
    }),
    updatePolicy: vi.fn<SignInSettingsRepository["updatePolicy"]>(async (request) => ({
      ok: true,
      value: {
        passwordLoginEnabled: request.passwordLoginEnabled,
        registrationEnabled: request.registrationEnabled,
        updatedAt: new Date("2026-10-08T01:00:00.000Z"),
        version: request.expectedVersion + 1
      }
    }))
  } satisfies SignInSettingsRepository;
  return fake;
}

function service(input: {
  env?: Record<string, string>;
  registry?: SignInMethodServerRegistry;
  repository: SignInSettingsRepository;
  testTimeoutMs?: number;
}) {
  const invalidate = vi.fn();
  return {
    invalidate,
    service: createSignInSettingsService({
      activeSettings: { invalidate },
      encryptionKey: () => key,
      env: () => ({ AIQSA_APP_BASE_URL: "https://aiqsa.example", ...input.env }),
      now: () => new Date("2026-10-08T12:00:00.000Z"),
      registry: input.registry ?? { google: googleSignInMethod, yandex: yandexSignInMethod },
      repository: input.repository,
      testTimeoutMs: input.testTimeoutMs
    })
  };
}

describe("sign-in settings service", () => {
  it("lists registered methods with their status and only flags for secrets", async () => {
    const { service: settings } = service({
      env: { AIQSA_YANDEX_OAUTH_CLIENT_ID: "yandex-client", AIQSA_YANDEX_OAUTH_CLIENT_SECRET: "yandex-environment-secret" },
      repository: repository([googleDraft({
        activeConfig: { clientId: GOOGLE_CLIENT },
        activeSecretEnvelope: encryptSignInSecrets({ generation: 1, key, method: "google", secrets: { clientSecret: "client-secret-value" } }),
        activeSecretGeneration: 1,
        activeVersion: 1,
        activatedAt: new Date("2026-10-08T10:00:00.000Z"),
        enabled: true
      })])
    });

    const overview = await settings.overview({ sessionId: "session-1" });
    const serialized = JSON.stringify(overview);

    expect(overview.appBaseUrl).toBe("https://aiqsa.example");
    expect(overview.currentSessionSignInMethod).toBe("google");
    expect(overview.policy).toEqual({ passwordLoginEnabled: true, registrationEnabled: true, updatedAt: null, version: 0 });
    expect(overview.methods.map((method) => [method.method, method.status])).toEqual([
      ["google", "active_admin"],
      ["yandex", "active_environment"]
    ]);
    expect(overview.methods[0]).toMatchObject({
      active: { config: { clientId: GOOGLE_CLIENT }, enabled: true, secrets: { clientSecret: true }, version: 1 },
      draft: { config: { clientId: GOOGLE_CLIENT }, secrets: { clientSecret: true }, version: 2 },
      requiresTest: true
    });
    expect(overview.methods[1]).toMatchObject({ environmentConfigured: true, draft: { config: null, secrets: { clientSecret: false } } });
    expect(serialized).not.toContain("client-secret-value");
    expect(serialized).not.toContain("yandex-environment-secret");
  });

  it("refuses methods no task registered and drafts that break the method's contract", async () => {
    const repo = repository();
    const { service: settings } = service({ repository: repo });

    await expect(settings.saveDraft({
      actorUserId: "admin",
      config: { clientId: "x" },
      expectedDraftVersion: 0,
      method: "oidc",
      secretActions: {}
    })).resolves.toEqual({ code: "method_unavailable", ok: false });
    await expect(settings.saveDraft({
      actorUserId: "admin",
      config: { clientId: "x", unknown: true },
      expectedDraftVersion: 0,
      method: "google",
      secretActions: {}
    })).resolves.toEqual({ code: "invalid_configuration", ok: false });
    expect(repo.saveDraft).not.toHaveBeenCalled();

    await settings.saveDraft({
      actorUserId: "admin",
      config: { clientId: ` ${GOOGLE_CLIENT} ` },
      expectedDraftVersion: 0,
      method: "google",
      secretActions: { clientSecret: { kind: "replace", value: "client-secret-value" } }
    });
    const saved = repo.saveDraft.mock.calls[0]![0];
    expect(saved.config).toEqual({ clientId: GOOGLE_CLIENT });
    expect(saved.validateSecrets({})).toBe(false);
    expect(saved.validateSecrets({ clientSecret: "client-secret-value" })).toBe(true);
  });

  it("tests exactly the saved draft and records a content-free verdict", async () => {
    const repo = repository([googleDraft()]);
    const { service: settings } = service({ repository: repo });

    await expect(settings.test({ expectedDraftVersion: 1, method: "google" })).resolves.toEqual({ code: "draft_conflict", ok: false });

    const result = await settings.test({ expectedDraftVersion: 2, method: "google" });

    expect(result.ok && result.value.test).toEqual({ code: "format_checked", passed: true });
    expect(result.ok && result.value.method.draft.test).toMatchObject({ code: "format_checked", passed: true, version: 2 });
    expect(repo.recordDraftTest).toHaveBeenCalledWith(expect.objectContaining({ code: "format_checked", draftVersion: 2, passed: true }));
  });

  it("turns a hanging, throwing or malformed tester into a stable failure code", async () => {
    const hanging = service({
      registry: { google: { test: () => new Promise(() => undefined) } },
      repository: repository([googleDraft()]),
      testTimeoutMs: 5
    });
    const hung = await hanging.service.test({ expectedDraftVersion: 2, method: "google" });
    expect(hung.ok && hung.value.test).toEqual({ code: "test_timeout", passed: false });

    const throwing = service({
      registry: { google: { test: async () => { throw new Error("upstream said: secret=..."); } } },
      repository: repository([googleDraft()])
    });
    const thrown = await throwing.service.test({ expectedDraftVersion: 2, method: "google" });
    expect(thrown.ok && thrown.value.test).toEqual({ code: "test_failed", passed: false });

    const malformed = service({
      registry: { google: { test: async () => ({ code: "Bad Request: invalid_client", passed: true }) } },
      repository: repository([googleDraft()])
    });
    const odd = await malformed.service.test({ expectedDraftVersion: 2, method: "google" });
    expect(odd.ok && odd.value.test).toEqual({ code: "test_failed", passed: false });
  });

  it("activates with the method's test requirement and source, and drops the cached snapshot", async () => {
    const repo = repository([row({
      draftConfig: { clientId: "client", issuer: "https://idp.example/realms/new" },
      draftSecretEnvelope: encryptSignInSecrets({ generation: 1, key, method: "oidc", secrets: { clientSecret: "oidc-secret" } }),
      draftSecretGeneration: 1,
      draftVersion: 1,
      method: "oidc",
      secretGenerationCounter: 1
    })]);
    const { invalidate, service: settings } = service({
      registry: { oidc: { identitySource: (config) => config.issuer, test: async () => ({ code: "accepted", passed: true }) } },
      repository: repo
    });

    const result = await settings.activate({
      actorUserId: "admin",
      confirmSourceChange: false,
      expectedActiveVersion: 0,
      expectedDraftVersion: 1,
      method: "oidc"
    });

    expect(result.ok).toBe(true);
    const request = repo.activate.mock.calls[0]![0];
    expect(request.requiresTest).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("names the draft's identity source for the activation check", async () => {
    const draft = row({
      draftConfig: { clientId: "client", issuer: "https://idp.example/realms/new" },
      draftSecretEnvelope: encryptSignInSecrets({ generation: 1, key, method: "oidc", secrets: { clientSecret: "oidc-secret" } }),
      draftSecretGeneration: 1,
      draftVersion: 1,
      method: "oidc",
      secretGenerationCounter: 1
    });
    const repo = repository([draft]);
    const { invalidate, service: settings } = service({
      registry: { oidc: { identitySource: (config) => config.issuer } },
      repository: repo
    });
    repo.activate.mockResolvedValueOnce({ affectedIdentities: 3, code: "source_changed", ok: false });

    await expect(settings.activate({
      actorUserId: "admin",
      confirmSourceChange: false,
      expectedActiveVersion: 0,
      expectedDraftVersion: 1,
      method: "oidc"
    })).resolves.toEqual({ affectedIdentities: 3, code: "source_changed", ok: false });
    const request = repo.activate.mock.calls[0]![0];
    expect(request.requiresTest).toBe(false);
    expect(request.inspectDraft(draft)).toEqual({
      problem: null,
      source: { provider: "oidc", source: "https://idp.example/realms/new" }
    });
    expect(request.inspectDraft({ ...draft, draftSecretEnvelope: "broken" })).toEqual({ problem: "secret_unreadable" });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("disables without deleting and reads the switches with both on by default", async () => {
    const repo = repository([googleDraft({ activeConfig: { clientId: GOOGLE_CLIENT }, activeVersion: 1, enabled: true })]);
    const { invalidate, service: settings } = service({ repository: repo });

    const disabled = await settings.disable({ actorUserId: "admin", expectedActiveVersion: 1, method: "google" });

    expect(disabled.ok && disabled.value.status).toBe("off");
    expect(disabled.ok && disabled.value.active.config).toEqual({ clientId: GOOGLE_CLIENT });
    expect(invalidate).toHaveBeenCalledTimes(1);
    await expect(settings.readPolicy()).resolves.toEqual({ passwordLoginEnabled: true, registrationEnabled: true });
  });

  it("passes the environment fallbacks to the lockout guard", async () => {
    const repo = repository();
    const { service: settings } = service({
      env: { AIQSA_GOOGLE_OAUTH_CLIENT_ID: "google-client", AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret" },
      repository: repo
    });

    await settings.updatePolicy({
      actorUserId: "admin",
      expectedVersion: 0,
      passwordLoginEnabled: false,
      registrationEnabled: true,
      sessionId: "session-1"
    });

    expect(repo.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({
      environmentMethods: new Set(["google"]),
      passwordLoginEnabled: false,
      sessionId: "session-1"
    }));
  });
});

describe("Google and Yandex testers", () => {
  const signal = new AbortController().signal;

  it("check the format only", async () => {
    const test = googleSignInMethod.test!;
    await expect(test({ appBaseUrl: "https://a.example", config: { clientId: GOOGLE_CLIENT }, secrets: { clientSecret: "GOCSPX-abcdefgh" }, signal }))
      .resolves.toEqual({ code: "format_checked", passed: true });
    await expect(test({ appBaseUrl: "https://a.example", config: { clientId: "not-a-google-client" }, secrets: { clientSecret: "GOCSPX-abcdefgh" }, signal }))
      .resolves.toEqual({ code: "client_id_format_invalid", passed: false });
    await expect(yandexSignInMethod.test!({ appBaseUrl: "https://a.example", config: { clientId: "0123456789abcdef0123456789abcdef" }, secrets: { clientSecret: "has space" }, signal }))
      .resolves.toEqual({ code: "client_secret_format_invalid", passed: false });
  });
});
