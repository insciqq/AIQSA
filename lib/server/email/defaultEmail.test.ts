// @vitest-environment node

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  loadDraftForTest: vi.fn(async () => ({
    ok: true as const,
    value: {
      configuration: {
        allowInternalNetwork: false,
        authentication: { mode: "none" as const },
        from: { address: "noreply@example.com", displayName: "AIQSA" },
        host: "smtp.example.com",
        port: 465,
        transport: "implicit_tls" as const
      },
      draftVersion: 4
    }
  })),
  networkSend: vi.fn(async () => {
    throw new Error("network SMTP must not run in deterministic test mode");
  }),
  recordDraftTest: vi.fn(async (input: { at: Date; code: string; draftVersion: number }) => ({
    ok: true as const,
    value: {
      active: {
        activatedAt: null,
        activatedByUserId: null,
        configuration: null,
        enabled: false,
        passwordConfigured: false,
        version: 0
      },
      configurationUpdatedAt: null,
      configurationUpdatedByUserId: null,
      draft: {
        configuration: null,
        passwordConfigured: false,
        test: {
          attemptedAt: input.at.toISOString(),
          code: input.code,
          tested: input.code === "accepted",
          version: input.draftVersion
        },
        version: input.draftVersion
      },
      health: {
        activeVersion: null,
        degraded: false,
        lastAcceptedAt: null,
        lastAttemptAt: null,
        lastFailureAt: null,
        lastFailureCode: null
      }
    }
  }))
}));

vi.mock("../auth/config", () => ({
  isTestAuthEnabled: () => true
}));

vi.mock("../auth/testMailer", () => ({
  createTestEmailCapture: () => ({ capture: mocks.capture })
}));

vi.mock("../prisma", () => ({ prisma: {} }));

vi.mock("./repository", () => ({
  createPrismaEmailRepository: () => ({
    loadDraftForTest: mocks.loadDraftForTest,
    recordDraftTest: mocks.recordDraftTest
  })
}));

vi.mock("./smtpTransport", () => ({
  createSmtpTransport: () => ({ send: mocks.networkSend })
}));

import { adminEmailService } from "./defaultEmail";

describe("default email test-mode wiring", () => {
  it("routes Admin draft tests to deterministic capture without DNS or SMTP sockets", async () => {
    const result = await adminEmailService.testDraft({
      expectedDraftVersion: 4,
      recipient: "operator@example.com"
    });

    expect(result).toMatchObject({
      ok: true,
      value: { test: { code: "accepted", tested: true } }
    });
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledWith(expect.objectContaining({
      kind: "configuration_test",
      to: "operator@example.com"
    }));
    expect(mocks.networkSend).not.toHaveBeenCalled();
    expect(mocks.recordDraftTest).toHaveBeenCalledWith(expect.objectContaining({
      code: "accepted",
      draftVersion: 4
    }));
  });
});
