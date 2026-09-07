import { describe, expect, it, vi } from "vitest";
import type { AdminEmailConfiguration, AdminEmailState } from "../../contracts/email";
import type { SmtpCompleteConfiguration } from "./definitions";
import {
  createAdminEmailService,
  SmtpAttemptGate
} from "./service";
import type { EmailRepository } from "./repository";
import type { SmtpTransport } from "./smtpTransport";

const NOW = new Date("2026-07-23T13:00:00.000Z");
const PASSWORD = "write-only-password";

const previousActive: AdminEmailConfiguration = {
  allowInternalNetwork: false,
  authentication: { mode: "none" },
  from: { address: "noreply@example.com", displayName: "AIQSA" },
  host: "smtp.old.example.com",
  port: 465,
  transport: "implicit_tls"
};

const nextConfiguration: AdminEmailConfiguration = {
  allowInternalNetwork: false,
  authentication: { mode: "password", username: "mailer@example.com" },
  from: { address: "noreply@example.com", displayName: "AIQSA" },
  host: "smtp.example.com",
  port: 587,
  transport: "starttls_required"
};

/**
 * A small in-memory stand-in for the Prisma repository that keeps the same
 * version and tested-draft rules, so the service composition (store, send,
 * record, activate) is exercised end to end without a database.
 */
function memoryRepository(initial: AdminEmailState): EmailRepository & { calls: string[]; state(): AdminEmailState } {
  let state = structuredClone(initial);
  let password: string | null = null;
  const calls: string[] = [];
  const ok = <T>(value: T) => ({ ok: true as const, value });

  return {
    calls,
    state: () => state,
    async readAdminState() {
      calls.push("read");
      return ok(state);
    },
    async saveDraft(request) {
      calls.push("save");
      if (request.expectedDraftVersion !== state.draft.version) return { ok: false, code: "draft_conflict" };
      const action = request.passwordAction as { kind: string; password?: string };
      if (action.kind === "replace") password = action.password ?? null;
      if (action.kind === "clear") password = null;
      state = {
        ...state,
        draft: {
          configuration: request.configuration as AdminEmailConfiguration,
          passwordConfigured: password !== null,
          test: null,
          version: state.draft.version + 1
        }
      };
      return ok(state);
    },
    async loadDraftForTest(expectedDraftVersion) {
      calls.push("load");
      if (expectedDraftVersion !== state.draft.version || !state.draft.configuration) {
        return { ok: false, code: "draft_conflict" };
      }
      const configuration = state.draft.configuration;
      return ok({
        configuration: (configuration.authentication.mode === "password"
          ? { ...configuration, authentication: { ...configuration.authentication, password: password ?? "" } }
          : configuration) as SmtpCompleteConfiguration,
        draftVersion: state.draft.version
      });
    },
    async recordDraftTest(request) {
      calls.push(`record:${request.code}`);
      if (request.draftVersion !== state.draft.version) return { ok: false, code: "draft_conflict" };
      state = {
        ...state,
        draft: {
          ...state.draft,
          test: {
            attemptedAt: request.at.toISOString(),
            code: request.code,
            tested: request.code === "accepted",
            version: request.draftVersion
          }
        }
      };
      return ok(state);
    },
    async activate(request) {
      calls.push("activate");
      if (request.expectedDraftVersion !== state.draft.version) return { ok: false, code: "draft_conflict" };
      if (request.expectedActiveVersion !== state.active.version) return { ok: false, code: "active_conflict" };
      if (!state.draft.test?.tested) return { ok: false, code: "not_tested" };
      state = {
        ...state,
        active: {
          activatedAt: request.now.toISOString(),
          activatedByUserId: request.actorUserId,
          configuration: state.draft.configuration,
          enabled: true,
          passwordConfigured: state.draft.passwordConfigured,
          version: state.active.version + 1
        }
      };
      return ok(state);
    },
    async enable() {
      throw new Error("not used");
    },
    async disable() {
      throw new Error("not used");
    },
    async clear() {
      throw new Error("not used");
    },
    async loadActiveForSend() {
      return ok({ kind: "unavailable" as const });
    },
    async recordDeliveryOutcome() {
      return true;
    }
  };
}

function stateWithPreviousActive(): AdminEmailState {
  return {
    active: {
      activatedAt: "2026-07-01T00:00:00.000Z",
      activatedByUserId: "admin-0",
      configuration: previousActive,
      enabled: true,
      passwordConfigured: false,
      version: 3
    },
    configurationUpdatedAt: "2026-07-01T00:00:00.000Z",
    configurationUpdatedByUserId: "admin-0",
    draft: { configuration: previousActive, passwordConfigured: false, test: null, version: 4 },
    health: {
      activeVersion: 3,
      degraded: false,
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    }
  };
}

function testAndActivateInput(repositoryState: AdminEmailState) {
  return {
    actorUserId: "admin-1",
    configuration: nextConfiguration,
    expectedActiveVersion: repositoryState.active.version,
    expectedDraftVersion: repositoryState.draft.version,
    passwordAction: { kind: "replace", password: PASSWORD },
    testRecipient: "operator@example.com"
  };
}

describe("admin email service test_and_activate", () => {
  it("stores the settings, sends the test outside repository work, then activates on acceptance", async () => {
    const repository = memoryRepository(stateWithPreviousActive());
    const transport: SmtpTransport = {
      async send(input) {
        repository.calls.push("network");
        expect(input.configuration).toMatchObject({
          authentication: { mode: "password", password: PASSWORD, username: "mailer@example.com" },
          host: "smtp.example.com"
        });
        expect(input.message).toMatchObject({ kind: "configuration_test", to: "operator@example.com" });
        expect(input.message.text).not.toMatch(/https?:|token|reset|invite/iu);
        return { kind: "accepted" };
      }
    };
    const service = createAdminEmailService({ now: () => NOW, repository, transport });

    const result = await service.testAndActivate(testAndActivateInput(repository.state()));

    expect(result).toMatchObject({ ok: true, value: { test: { code: "accepted", tested: true } } });
    expect(repository.calls).toEqual(["read", "save", "load", "network", "record:accepted", "activate"]);
    const state = repository.state();
    expect(state.active).toMatchObject({
      activatedByUserId: "admin-1",
      configuration: nextConfiguration,
      enabled: true,
      passwordConfigured: true,
      version: 4
    });
    expect(state.draft.version).toBe(5);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain("operator@example.com");
  });

  it("keeps the previous active configuration when the mail server rejects the test message", async () => {
    const repository = memoryRepository(stateWithPreviousActive());
    const send = vi.fn(async () => ({ code: "smtp_authentication_failed", kind: "failed" } as const));
    const service = createAdminEmailService({ now: () => NOW, repository, transport: { send } });

    const result = await service.testAndActivate(testAndActivateInput(repository.state()));

    expect(result).toEqual({
      ok: false,
      code: "test_failed",
      value: {
        email: repository.state(),
        test: { code: "smtp_authentication_failed", tested: false }
      }
    });
    expect(repository.calls).not.toContain("activate");
    const state = repository.state();
    expect(state.active).toEqual(stateWithPreviousActive().active);
    expect(state.draft).toMatchObject({
      configuration: nextConfiguration,
      test: { code: "smtp_authentication_failed", tested: false, version: 5 },
      version: 5
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain("operator@example.com");
  });

  it("refuses before storing or sending when the active configuration moved or the settings are invalid", async () => {
    const repository = memoryRepository(stateWithPreviousActive());
    const send = vi.fn();
    const service = createAdminEmailService({ now: () => NOW, repository, transport: { send } });

    expect(await service.testAndActivate({
      ...testAndActivateInput(repository.state()),
      expectedActiveVersion: 2
    })).toEqual({ ok: false, code: "active_conflict" });
    expect(repository.calls).toEqual(["read"]);

    expect(await service.testAndActivate({
      ...testAndActivateInput(repository.state()),
      testRecipient: "victim@example.com\r\nBcc: attacker@example.com"
    })).toEqual({ ok: false, code: "invalid_configuration" });

    expect(send).not.toHaveBeenCalled();
    expect(repository.state()).toEqual(stateWithPreviousActive());
  });

  it("reports a stale settings version after the send without activating", async () => {
    const repository = memoryRepository(stateWithPreviousActive());
    const recordDraftTest = vi.fn(async () => ({ ok: false as const, code: "draft_conflict" as const }));
    const send = vi.fn(async () => ({ kind: "accepted" as const }));
    const service = createAdminEmailService({
      now: () => NOW,
      repository: { ...repository, recordDraftTest },
      transport: { send }
    });

    expect(await service.testAndActivate(testAndActivateInput(repository.state()))).toEqual({
      ok: false,
      code: "draft_conflict"
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(repository.calls).not.toContain("activate");
    expect(repository.state().active).toEqual(stateWithPreviousActive().active);
  });

  it("fails fast on concurrency saturation without a network send and keeps the previous active configuration", async () => {
    const gate = new SmtpAttemptGate(1);
    const release = gate.tryAcquire();
    expect(release).not.toBeNull();
    const repository = memoryRepository(stateWithPreviousActive());
    const send = vi.fn();
    const service = createAdminEmailService({ attemptGate: gate, now: () => NOW, repository, transport: { send } });

    expect(await service.testAndActivate(testAndActivateInput(repository.state()))).toMatchObject({
      ok: false,
      code: "test_failed",
      value: { test: { code: "overloaded", tested: false } }
    });
    expect(send).not.toHaveBeenCalled();
    expect(repository.calls).toContain("record:overloaded");
    expect(repository.state().active).toEqual(stateWithPreviousActive().active);
    release?.();
  });
});
