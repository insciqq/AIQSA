import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminActionResult } from "@/components/admin/adminApi";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmedActionRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminGroup, AdminInviteRecord } from "@/lib/contracts/admin";
import { useAdminInvitesController } from "./useAdminInvitesController";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const groups: AdminGroup[] = [
  { accessGrants: [], archivedAt: null, id: "group-active", name: "Active group", systemRole: null, userCount: 2 },
  { accessGrants: [], archivedAt: "2026-07-01T00:00:00.000Z", id: "group-archived", name: "Archived group", systemRole: null, userCount: 0 }
];

function invite(overrides: Partial<AdminInviteRecord> & { id: string }): AdminInviteRecord {
  return {
    acceptedAt: null,
    defaultGroups: [],
    email: `${overrides.id}@example.com`,
    expiresAt: "2026-09-13T12:00:00.000Z",
    normalizedEmail: `${overrides.id}@example.com`,
    revokedAt: null,
    ...overrides
  };
}

function harness(
  runAction: AdminRunAction,
  invites: AdminInviteRecord[] = []
) {
  const confirmations: AdminConfirmedActionRequest[] = [];
  const feedback = { clearAll: vi.fn(), reportError: vi.fn(), reportNotice: vi.fn() };
  const writeText = vi.fn(async () => undefined);
  const view = renderHook(
    ({ dashboard }) => useAdminInvitesController({
      actionsDisabled: false,
      confirmation: { requestConfirmedAction: (config) => { confirmations.push(config); } },
      dashboard,
      feedback,
      nowMs: NOW,
      runAction,
      writeText
    }),
    { initialProps: { dashboard: { groups, invites } } }
  );
  return { confirmations, feedback, view, writeText };
}

describe("useAdminInvitesController", () => {
  it("validates the email locally, creates with active groups only, and keeps the one-time link", async () => {
    const runAction: AdminRunAction = vi.fn(async (): Promise<AdminActionResult> => ({
      emailDelivery: "sent",
      invite: { id: "invite-new" },
      inviteUrl: "https://aiqsa.local/login?invite=test-token"
    }));
    const { feedback, view, writeText } = harness(runAction);

    await act(async () => {
      expect(await view.result.current.actions.createInvite({ email: "  ", groupIds: [], sendEmail: true }))
        .toEqual({ message: "Enter the invited email address.", ok: false });
    });
    expect(runAction).not.toHaveBeenCalled();

    await act(async () => {
      expect(await view.result.current.actions.createInvite({
        email: " friend@example.com ",
        groupIds: ["group-active", "group-archived"],
        sendEmail: true
      })).toEqual({ delivery: "sent", ok: true });
    });
    expect(runAction).toHaveBeenCalledWith(
      { action: "create_invite", email: "friend@example.com", groupIds: ["group-active"], sendEmail: true },
      "Invite created.",
      { successNotice: false }
    );
    expect(feedback.reportNotice).toHaveBeenCalledWith("Invite created and email sent.");
    expect(view.result.current.fresh).toEqual({
      copied: false,
      copyError: null,
      delivery: "sent",
      email: "friend@example.com",
      inviteId: "invite-new",
      url: "https://aiqsa.local/login?invite=test-token"
    });

    await act(async () => {
      await view.result.current.actions.copyFreshLink();
    });
    expect(writeText).toHaveBeenCalledWith("https://aiqsa.local/login?invite=test-token");
    expect(view.result.current.fresh?.copied).toBe(true);

    view.rerender({ dashboard: { groups, invites: [invite({ id: "invite-new", revokedAt: "2026-09-07T12:30:00.000Z" })] } });
    expect(view.result.current.fresh).toBeNull();
  });

  it("reports delivery failures as errors and passes server errors back to the sheet", async () => {
    const runAction: AdminRunAction = vi.fn()
      .mockResolvedValueOnce({ emailDelivery: "failed", inviteUrl: "https://aiqsa.local/login?invite=a" })
      .mockResolvedValueOnce({ error: "email_invalid" });
    const { feedback, view } = harness(runAction);

    await act(async () => {
      expect(await view.result.current.actions.createInvite({ email: "a@example.com", groupIds: [], sendEmail: true }))
        .toEqual({ delivery: "failed", ok: true });
    });
    expect(feedback.reportError).toHaveBeenCalledWith("Invite created, but the email could not be sent. Copy and share the link.");
    expect(view.result.current.fresh?.inviteId).toBeNull();

    await act(async () => {
      const result = await view.result.current.actions.createInvite({ email: "b@example.com", groupIds: [], sendEmail: false });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ message: expect.stringMatching(/email/iu) });
    });
  });

  it("splits open and stale invites and confirms revoke and delete", () => {
    const invites = [
      invite({ id: "open" }),
      invite({ expiresAt: "2026-09-01T00:00:00.000Z", id: "expired" }),
      invite({ acceptedAt: "2026-09-02T00:00:00.000Z", id: "accepted" })
    ];
    const { confirmations, view } = harness(vi.fn(async () => ({ ok: true })), invites);

    expect(view.result.current.open.map((entry) => entry.id)).toEqual(["open"]);
    expect(view.result.current.stale.map((entry) => entry.id)).toEqual(["expired"]);
    act(() => {
      view.result.current.actions.requestRevokeInvite({ email: "open@example.com", id: "open" });
      view.result.current.actions.requestDeleteInvite({ email: "expired@example.com", id: "expired" });
    });
    expect(confirmations.map((config) => [config.testId, config.body])).toEqual([
      ["admin-confirm-revoke-invite", { action: "revoke_invite", inviteId: "open" }],
      ["admin-confirm-delete-invite", { action: "delete_invite", inviteId: "expired" }]
    ]);
  });
});
