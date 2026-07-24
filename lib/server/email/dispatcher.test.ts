import { describe, expect, it, vi } from "vitest";
import {
  createEmailDispatcher,
  createMemoryEmailCapture
} from "./dispatcher";
import type { SmtpCompleteConfiguration } from "./definitions";
import type { EmailRepository } from "./repository";
import { SmtpAttemptGate } from "./service";
import type { SmtpTransport } from "./smtpTransport";

const NOW = new Date("2026-07-23T14:00:00.000Z");
const message = {
  kind: "verification" as const,
  subject: "Verify your AIQSA account",
  text: "Use the one-time link supplied by AIQSA.",
  to: "user@example.com"
};

function configuration(host: string): SmtpCompleteConfiguration {
  return {
    allowInternalNetwork: false,
    authentication: { mode: "none" },
    from: { address: "noreply@example.com", displayName: "AIQSA" },
    host,
    port: 465,
    transport: "implicit_tls"
  };
}

function repository(overrides: Partial<EmailRepository> = {}): EmailRepository {
  const unused = async () => {
    throw new Error("unused");
  };
  return {
    activate: unused,
    clear: unused,
    disable: unused,
    enable: unused,
    loadActiveForSend: async () => ({ ok: true, value: { kind: "unavailable" } }),
    loadDraftForTest: unused,
    readAdminState: unused,
    recordDeliveryOutcome: async () => true,
    recordDraftTest: unused,
    saveDraft: unused,
    ...overrides
  } as EmailRepository;
}

describe("email dispatcher", () => {
  it("gives deterministic capture absolute precedence over database and transport", async () => {
    const capture = createMemoryEmailCapture();
    const loadActiveForSend = vi.fn(async () => {
      throw new Error("database must not be read");
    });
    const send = vi.fn(async () => {
      throw new Error("network must not run");
    });
    const dispatcher = createEmailDispatcher({
      repository: repository({ loadActiveForSend }),
      testCapture: capture,
      transport: { send }
    });

    expect(await dispatcher.send(message)).toEqual({ kind: "accepted" });
    expect(capture.messages).toEqual([message]);
    expect(loadActiveForSend).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("loads a fresh immutable active snapshot for every send", async () => {
    let activeVersion = 10;
    const loadActiveForSend = vi.fn(async () => ({
      ok: true as const,
      value: {
        activeVersion: activeVersion++,
        configuration: configuration(activeVersion === 11 ? "one.example.com" : "two.example.com"),
        kind: "ready" as const
      }
    }));
    const hosts: string[] = [];
    const send = vi.fn(async (input: Parameters<SmtpTransport["send"]>[0]) => {
      hosts.push(input.configuration.host);
      return { kind: "accepted" as const };
    });
    const recordDeliveryOutcome = vi.fn(async (
      _input: Parameters<EmailRepository["recordDeliveryOutcome"]>[0]
    ) => true);
    const dispatcher = createEmailDispatcher({
      now: () => NOW,
      repository: repository({ loadActiveForSend, recordDeliveryOutcome }),
      transport: { send }
    });

    expect(await dispatcher.send(message)).toEqual({ kind: "accepted" });
    expect(await dispatcher.send(message)).toEqual({ kind: "accepted" });
    expect(loadActiveForSend).toHaveBeenCalledTimes(2);
    expect(hosts).toEqual(["one.example.com", "two.example.com"]);
    expect(recordDeliveryOutcome.mock.calls.map(([call]) => call.activeVersion)).toEqual([10, 11]);
  });

  it("distinguishes unavailable, active failures, and post-DATA ambiguity", async () => {
    const unavailable = createEmailDispatcher({
      repository: repository(),
      transport: { send: vi.fn() }
    });
    expect(await unavailable.send(message)).toEqual({ kind: "unavailable" });

    const recordFailure = vi.fn(async (
      _input: Parameters<EmailRepository["recordDeliveryOutcome"]>[0]
    ) => true);
    const unreadable = createEmailDispatcher({
      now: () => NOW,
      repository: repository({
        loadActiveForSend: async () => ({
          ok: true,
          value: { activeVersion: 3, code: "secret_unreadable", kind: "failure" }
        }),
        recordDeliveryOutcome: recordFailure
      }),
      transport: { send: vi.fn() }
    });
    expect(await unreadable.send(message)).toEqual({
      code: "secret_unreadable",
      kind: "failed"
    });
    expect(recordFailure).toHaveBeenCalledWith({
      activeVersion: 3,
      at: NOW,
      code: "secret_unreadable"
    });

    const recordAmbiguous = vi.fn(async (
      _input: Parameters<EmailRepository["recordDeliveryOutcome"]>[0]
    ) => false);
    const ambiguous = createEmailDispatcher({
      now: () => NOW,
      repository: repository({
        loadActiveForSend: async () => ({
          ok: true,
          value: { activeVersion: 7, configuration: configuration("smtp.example.com"), kind: "ready" }
        }),
        recordDeliveryOutcome: recordAmbiguous
      }),
      transport: { send: async () => ({ kind: "ambiguous_after_data" }) }
    });
    expect(await ambiguous.send(message)).toEqual({ kind: "ambiguous_after_data" });
    expect(recordAmbiguous).toHaveBeenCalledWith({
      activeVersion: 7,
      at: NOW,
      code: "ambiguous_after_data"
    });
  });

  it("keeps accepted and ambiguous transport outcomes when health recording fails", async () => {
    const recordDeliveryOutcome = vi.fn(async () => {
      throw new Error("health unavailable");
    });
    const readyRepository = () => repository({
      loadActiveForSend: async () => ({
        ok: true,
        value: {
          activeVersion: 9,
          configuration: configuration("smtp.example.com"),
          kind: "ready"
        }
      }),
      recordDeliveryOutcome
    });

    const accepted = createEmailDispatcher({
      now: () => NOW,
      repository: readyRepository(),
      transport: { send: async () => ({ kind: "accepted" }) }
    });
    await expect(accepted.send(message)).resolves.toEqual({ kind: "accepted" });

    const ambiguous = createEmailDispatcher({
      now: () => NOW,
      repository: readyRepository(),
      transport: { send: async () => ({ kind: "ambiguous_after_data" }) }
    });
    await expect(ambiguous.send(message)).resolves.toEqual({ kind: "ambiguous_after_data" });
    expect(recordDeliveryOutcome).toHaveBeenCalledTimes(2);
  });

  it("keeps pre-transport failure and overload outcomes when health recording fails", async () => {
    const recordDeliveryOutcome = vi.fn(async () => {
      throw new Error("health unavailable");
    });
    const invalidActive = createEmailDispatcher({
      now: () => NOW,
      repository: repository({
        loadActiveForSend: async () => ({
          ok: true,
          value: { activeVersion: 10, code: "secret_unreadable", kind: "failure" }
        }),
        recordDeliveryOutcome
      }),
      transport: { send: vi.fn() }
    });
    await expect(invalidActive.send(message)).resolves.toEqual({
      code: "secret_unreadable",
      kind: "failed"
    });

    const gate = new SmtpAttemptGate(1);
    const release = gate.tryAcquire();
    const overloaded = createEmailDispatcher({
      attemptGate: gate,
      now: () => NOW,
      repository: repository({
        loadActiveForSend: async () => ({
          ok: true,
          value: {
            activeVersion: 11,
            configuration: configuration("smtp.example.com"),
            kind: "ready"
          }
        }),
        recordDeliveryOutcome
      }),
      transport: { send: vi.fn() }
    });
    await expect(overloaded.send(message)).resolves.toEqual({
      code: "overloaded",
      kind: "failed"
    });
    release?.();
    expect(recordDeliveryOutcome).toHaveBeenCalledTimes(2);
  });

  it("fails fast under saturation without queueing or opening a connection", async () => {
    const gate = new SmtpAttemptGate(1);
    const release = gate.tryAcquire();
    const send = vi.fn();
    const recordDeliveryOutcome = vi.fn(async (
      _input: Parameters<EmailRepository["recordDeliveryOutcome"]>[0]
    ) => true);
    const dispatcher = createEmailDispatcher({
      attemptGate: gate,
      now: () => NOW,
      repository: repository({
        loadActiveForSend: async () => ({
          ok: true,
          value: { activeVersion: 8, configuration: configuration("smtp.example.com"), kind: "ready" }
        }),
        recordDeliveryOutcome
      }),
      transport: { send }
    });

    expect(await dispatcher.send(message)).toEqual({ code: "overloaded", kind: "failed" });
    expect(send).not.toHaveBeenCalled();
    expect(recordDeliveryOutcome).toHaveBeenCalledWith({
      activeVersion: 8,
      at: NOW,
      code: "overloaded"
    });
    release?.();
  });
});
