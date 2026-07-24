// @vitest-environment node

import type { AdminEmailState } from "@/lib/contracts/email";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  resolveAuth: vi.fn()
}));

vi.mock("@/lib/server/auth/defaultAuth", () => ({
  resolveRequestAuth: mocks.resolveAuth
}));

vi.mock("@/lib/server/email/defaultEmail", () => ({
  adminEmailService: {
    activate: vi.fn(),
    clear: vi.fn(),
    disable: vi.fn(),
    enable: vi.fn(),
    read: mocks.read,
    saveDraft: vi.fn(),
    testDraft: vi.fn()
  }
}));

import { GET, runtime } from "./route";

const emptyState: AdminEmailState = {
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
  draft: { configuration: null, passwordConfigured: false, test: null, version: 0 },
  health: {
    activeVersion: null,
    degraded: false,
    lastAcceptedAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastFailureCode: null
  }
};

describe("/api/admin/email", () => {
  it("wires the Node route to the active-admin email service", async () => {
    mocks.resolveAuth.mockResolvedValue({
      expiresAt: new Date("2026-07-24T00:00:00.000Z"),
      id: "session-1",
      user: {
        displayName: "Operator",
        email: "operator@example.com",
        id: "admin-1",
        role: "admin",
        status: "active"
      },
      userId: "admin-1"
    });
    mocks.read.mockResolvedValue({ ok: true, value: emptyState });

    expect(runtime).toBe("nodejs");
    const response = await GET(new Request("https://aiqsa.example/api/admin/email"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: emptyState });
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
