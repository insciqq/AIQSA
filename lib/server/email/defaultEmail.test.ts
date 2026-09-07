// @vitest-environment node

import type { AdminEmailState } from "../../contracts/email";

const configuration = {
  allowInternalNetwork: false,
  authentication: { mode: "none" as const },
  from: { address: "noreply@example.com", displayName: "AIQSA" },
  host: "smtp.example.com",
  port: 465,
  transport: "implicit_tls" as const
};

function state(draftVersion: number, tested: boolean, activeVersion: number): AdminEmailState {
  return {
    active: {
      activatedAt: null,
      activatedByUserId: null,
      configuration: activeVersion > 0 ? configuration : null,
      enabled: activeVersion > 0,
      passwordConfigured: false,
      version: activeVersion
    },
    configurationUpdatedAt: null,
    configurationUpdatedByUserId: null,
    draft: {
      configuration,
      passwordConfigured: false,
      test: tested
        ? { attemptedAt: "2026-07-23T13:00:00.000Z", code: "accepted", tested: true, version: draftVersion }
        : null,
      version: draftVersion
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
}

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  capture: vi.fn(),
  loadDraftForTest: vi.fn(),
  networkSend: vi.fn(async () => {
    throw new Error("network SMTP must not run in deterministic test mode");
  }),
  readAdminState: vi.fn(),
  recordDraftTest: vi.fn(),
  saveDraft: vi.fn()
}));

vi.mock("../auth/config", () => ({
  isTestAuthEnabled: () => true
}));

vi.mock("../auth/testMailer", () => ({
  captureTestAuthEmail: mocks.capture
}));

vi.mock("../prisma", () => ({ prisma: {} }));

vi.mock("./repository", () => ({
  createPrismaEmailRepository: () => ({
    activate: mocks.activate,
    loadDraftForTest: mocks.loadDraftForTest,
    readAdminState: mocks.readAdminState,
    recordDraftTest: mocks.recordDraftTest,
    saveDraft: mocks.saveDraft
  })
}));

vi.mock("./smtpTransport", () => ({
  createSmtpTransport: () => ({ send: mocks.networkSend })
}));

import { adminEmailService } from "./defaultEmail";

describe("default email test-mode wiring", () => {
  it("routes Admin test messages to deterministic capture without DNS or SMTP sockets", async () => {
    mocks.readAdminState.mockResolvedValue({ ok: true, value: state(3, false, 0) });
    mocks.saveDraft.mockResolvedValue({ ok: true, value: state(4, false, 0) });
    mocks.loadDraftForTest.mockResolvedValue({ ok: true, value: { configuration, draftVersion: 4 } });
    mocks.recordDraftTest.mockResolvedValue({ ok: true, value: state(4, true, 0) });
    mocks.activate.mockResolvedValue({ ok: true, value: state(4, true, 1) });

    const result = await adminEmailService.testAndActivate({
      actorUserId: "admin-1",
      configuration,
      expectedActiveVersion: 0,
      expectedDraftVersion: 3,
      passwordAction: { confirm: true, kind: "clear" },
      testRecipient: "operator@example.com"
    });

    expect(result).toMatchObject({
      ok: true,
      value: { email: { active: { enabled: true, version: 1 } }, test: { code: "accepted", tested: true } }
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
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1",
      expectedActiveVersion: 0,
      expectedDraftVersion: 4
    }));
  });
});
