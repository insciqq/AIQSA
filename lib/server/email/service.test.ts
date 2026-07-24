import { describe, expect, it, vi } from "vitest";
import type { AdminEmailState } from "../../contracts/email";
import type { SmtpCompleteConfiguration } from "./definitions";
import {
  createAdminEmailService,
  SmtpAttemptGate
} from "./service";
import type {
  EmailRepository,
  SmtpDraftSnapshot
} from "./repository";
import type { SmtpTransport } from "./smtpTransport";

const NOW = new Date("2026-07-23T13:00:00.000Z");

const configuration: SmtpCompleteConfiguration = {
  allowInternalNetwork: false,
  authentication: { mode: "none" },
  from: { address: "noreply@example.com", displayName: "AIQSA" },
  host: "smtp.example.com",
  port: 465,
  transport: "implicit_tls"
};

const state: AdminEmailState = {
  active: {
    activatedAt: null,
    activatedByUserId: null,
    configuration: null,
    enabled: false,
    passwordConfigured: false,
    version: 0
  },
  configurationUpdatedAt: NOW.toISOString(),
  configurationUpdatedByUserId: "admin-1",
  draft: {
    configuration,
    passwordConfigured: false,
    test: null,
    version: 4
  },
  health: {
    activeVersion: null,
    degraded: false,
    lastAcceptedAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastFailureCode: null
  }
};

function repository(overrides: Partial<EmailRepository> = {}): EmailRepository {
  const unchanged = async () => ({ ok: true as const, value: state });
  return {
    activate: unchanged,
    clear: unchanged,
    disable: unchanged,
    enable: unchanged,
    loadActiveForSend: async () => ({ ok: true, value: { kind: "unavailable" } }),
    loadDraftForTest: async (draftVersion) => ({
      ok: true,
      value: { configuration, draftVersion } as SmtpDraftSnapshot
    }),
    readAdminState: unchanged,
    recordDeliveryOutcome: async () => true,
    recordDraftTest: async () => ({ ok: true, value: state }),
    saveDraft: unchanged,
    ...overrides
  };
}

describe("admin email service", () => {
  it("sends outside repository work and persists only sanitized exact-version evidence", async () => {
    const order: string[] = [];
    const recordDraftTest = vi.fn(async () => {
      order.push("record");
      return { ok: true as const, value: state };
    });
    const emailRepository = repository({
      loadDraftForTest: async () => {
        order.push("load");
        return { ok: true, value: { configuration, draftVersion: 4 } };
      },
      recordDraftTest
    });
    const transport: SmtpTransport = {
      async send(input) {
        order.push("network");
        expect(input.message).toMatchObject({
          kind: "configuration_test",
          to: "operator@example.com"
        });
        expect(input.message.text).not.toMatch(/https?:|token|reset|invite/iu);
        return { kind: "accepted" };
      }
    };
    const service = createAdminEmailService({
      now: () => NOW,
      repository: emailRepository,
      transport
    });

    expect(await service.testDraft({
      expectedDraftVersion: 4,
      recipient: "operator@example.com"
    })).toMatchObject({
      ok: true,
      value: { test: { code: "accepted", tested: true } }
    });
    expect(order).toEqual(["load", "network", "record"]);
    expect(recordDraftTest).toHaveBeenCalledWith({
      at: NOW,
      code: "accepted",
      draftVersion: 4
    });
    expect(JSON.stringify(recordDraftTest.mock.calls)).not.toContain("operator@example.com");
  });

  it("reports a stale CAS after send without retrying", async () => {
    const send = vi.fn(async () => ({ kind: "accepted" as const }));
    const service = createAdminEmailService({
      repository: repository({
        recordDraftTest: async () => ({ ok: false, code: "draft_conflict" })
      }),
      transport: { send }
    });

    expect(await service.testDraft({
      expectedDraftVersion: 4,
      recipient: "operator@example.com"
    })).toEqual({ ok: false, code: "draft_conflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails fast on concurrency saturation and records no recipient", async () => {
    const gate = new SmtpAttemptGate(1);
    const release = gate.tryAcquire();
    expect(release).not.toBeNull();
    const send = vi.fn();
    const recordDraftTest = vi.fn(async () => ({ ok: true as const, value: state }));
    const service = createAdminEmailService({
      attemptGate: gate,
      now: () => NOW,
      repository: repository({ recordDraftTest }),
      transport: { send }
    });

    expect(await service.testDraft({
      expectedDraftVersion: 4,
      recipient: "operator@example.com"
    })).toMatchObject({
      ok: true,
      value: { test: { code: "overloaded", tested: false } }
    });
    expect(send).not.toHaveBeenCalled();
    expect(recordDraftTest).toHaveBeenCalledWith({
      at: NOW,
      code: "overloaded",
      draftVersion: 4
    });
    release?.();
  });

  it("turns invalid one-use recipients into exact-draft failed evidence", async () => {
    const send = vi.fn();
    const recordDraftTest = vi.fn(async () => ({ ok: true as const, value: state }));
    const service = createAdminEmailService({
      now: () => NOW,
      repository: repository({ recordDraftTest }),
      transport: { send }
    });

    expect(await service.testDraft({
      expectedDraftVersion: 4,
      recipient: "victim@example.com\r\nBcc: attacker@example.com"
    })).toMatchObject({
      ok: true,
      value: { test: { code: "smtp_invalid_input", tested: false } }
    });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(recordDraftTest.mock.calls)).not.toContain("victim@example.com");
  });
});
