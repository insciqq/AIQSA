import { act, renderHook } from "@testing-library/react";
import type { AdminGroup, AdminInviteRecord } from "@/lib/contracts/admin";
import { describe, expect, it, vi } from "vitest";
import type { AdminRunAction } from "./useAdminActionRunner";
import type { AdminConfirmationController } from "./useAdminConfirmationController";
import type { AdminFeedbackController } from "./useAdminFeedback";
import type { AdminFieldErrorController } from "./useAdminFieldErrors";
import {
  useAdminInvitesController,
  type AdminInvitesController,
  type AdminInvitesDashboard,
  type UseAdminInvitesControllerOptions
} from "./useAdminInvitesController";
import type { AdminClipboardWriter } from "./useAdminOneTimeInviteLink";

const nowMs = Date.parse("2026-07-12T00:00:00.000Z");

const activeGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-active",
  name: "Operators",
  systemRole: null,
  userCount: 1
};

const archivedGroup: AdminGroup = {
  ...activeGroup,
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Former operators"
};

function invite(overrides: Partial<AdminInviteRecord> = {}): AdminInviteRecord {
  return {
    acceptedAt: null,
    defaultGroups: [],
    email: "open@example.com",
    expiresAt: "2026-07-20T00:00:00.000Z",
    id: "invite-open",
    normalizedEmail: "open@example.com",
    revokedAt: null,
    ...overrides
  };
}

const dashboard: AdminInvitesDashboard = {
  groups: [activeGroup, archivedGroup],
  invites: [
    invite(),
    invite({
      acceptedAt: "2026-07-11T00:00:00.000Z",
      email: "accepted@example.com",
      id: "invite-accepted",
      normalizedEmail: "accepted@example.com"
    })
  ]
};

function createDependencies() {
  const feedback = {
    clearAll: vi.fn<AdminFeedbackController["clearAll"]>(),
    reportError: vi.fn<AdminFeedbackController["reportError"]>(),
    reportNotice: vi.fn<AdminFeedbackController["reportNotice"]>()
  } satisfies UseAdminInvitesControllerOptions["feedback"];
  const fieldErrors = {
    clearFieldError: vi.fn<AdminFieldErrorController["clearFieldError"]>(),
    fieldError: null,
    reportFieldError: vi.fn<AdminFieldErrorController["reportFieldError"]>()
  } satisfies UseAdminInvitesControllerOptions["fieldErrors"];
  const confirmation = {
    requestConfirmedAction: vi.fn<AdminConfirmationController["requestConfirmedAction"]>()
  } satisfies UseAdminInvitesControllerOptions["confirmation"];
  const runAction = vi.fn<AdminRunAction>().mockResolvedValue({ ok: true });
  const writeText = vi.fn<AdminClipboardWriter>().mockResolvedValue(undefined);

  return { confirmation, feedback, fieldErrors, runAction, writeText };
}

function section(controller: AdminInvitesController) {
  if (!controller.sectionProps) {
    throw new Error("Expected invite section props");
  }

  return controller.sectionProps;
}

describe("useAdminInvitesController", () => {
  it("owns persistent form/filter drafts and projects them through a fixed clock and active groups", () => {
    const dependencies = createDependencies();
    const initialProps: { actionsDisabled: boolean; currentDashboard: AdminInvitesDashboard | null } = {
      actionsDisabled: false,
      currentDashboard: dashboard
    };
    const { result, rerender } = renderHook(
      ({ actionsDisabled, currentDashboard }: { actionsDisabled: boolean; currentDashboard: AdminInvitesDashboard | null }) =>
        useAdminInvitesController({
          ...dependencies,
          actionsDisabled,
          dashboard: currentDashboard,
          nowMs
      }),
      {
        initialProps
      }
    );

    act(() => {
      result.current.headerForm.toggleForm();
      section(result.current).actions.changeEmail("draft@example.com");
      section(result.current).actions.changeGroups([activeGroup.id, archivedGroup.id]);
      section(result.current).actions.changeQuery("open");
      section(result.current).actions.changeSendEmail(false);
      section(result.current).actions.changeStatusFilter("open");
    });

    expect(result.current.headerForm.formOpen).toBe(true);
    expect(section(result.current).state).toMatchObject({
      email: "draft@example.com",
      formOpen: true,
      groupIds: [activeGroup.id],
      query: "open",
      sendEmail: false,
      statusFilter: "open"
    });
    expect(section(result.current).data.nowMs).toBe(nowMs);
    expect(section(result.current).data.invites.map((record) => record.id)).toEqual(["invite-open"]);

    const refreshedDashboard: AdminInvitesDashboard = structuredClone(dashboard);
    const refreshedActiveGroup = refreshedDashboard.groups.find((group) => group.id === activeGroup.id);
    if (!refreshedActiveGroup) {
      throw new Error("Expected active group fixture");
    }
    refreshedActiveGroup.archivedAt = "2026-07-12T00:00:00.000Z";
    rerender({ actionsDisabled: true, currentDashboard: refreshedDashboard });

    expect(section(result.current).state).toMatchObject({
      email: "draft@example.com",
      formOpen: true,
      groupIds: [],
      query: "open",
      sendEmail: false,
      statusFilter: "open"
    });
    expect(section(result.current).status.actionsDisabled).toBe(true);

    rerender({ actionsDisabled: true, currentDashboard: null });
    expect(result.current.sectionProps).toBeNull();
    expect(result.current.headerForm.formOpen).toBe(true);
  });

  it("validates, submits active groups, preserves failed drafts, and keeps clipboard copying independent", async () => {
    const dependencies = createDependencies();
    const { result } = renderHook(() =>
      useAdminInvitesController({
        ...dependencies,
        actionsDisabled: true,
        dashboard,
        nowMs
      })
    );

    await act(async () => section(result.current).actions.createInvite());
    expect(dependencies.fieldErrors.reportFieldError).toHaveBeenCalledWith("invite-email", "email_required");
    expect(dependencies.runAction).not.toHaveBeenCalled();

    act(() => {
      result.current.headerForm.toggleForm();
      section(result.current).actions.changeEmail("  person@example.com  ");
      section(result.current).actions.changeGroups([activeGroup.id, archivedGroup.id]);
    });
    dependencies.runAction.mockResolvedValueOnce({
      emailDelivery: "sent",
      inviteUrl: "https://aiqsa.example/login?invite=first-token"
    });
    await act(async () => section(result.current).actions.createInvite());

    expect(dependencies.runAction).toHaveBeenNthCalledWith(
      1,
      {
        action: "create_invite",
        email: "person@example.com",
        groupIds: [activeGroup.id],
        sendEmail: true
      },
      "Invite created.",
      { successNotice: false }
    );
    expect(section(result.current).state).toMatchObject({
      email: "",
      emailDelivery: "sent",
      formOpen: true,
      groupIds: [],
      oneTimeUrl: "https://aiqsa.example/login?invite=first-token",
      oneTimeUrlCopied: false,
      sendEmail: true
    });
    expect(dependencies.feedback.reportNotice).toHaveBeenCalledWith("Invite created and email sent.");

    await act(async () => section(result.current).actions.copyOneTimeUrl());
    expect(dependencies.writeText).toHaveBeenCalledWith("https://aiqsa.example/login?invite=first-token");
    expect(section(result.current).state.oneTimeUrlCopied).toBe(true);
    expect(section(result.current).status.actionsDisabled).toBe(true);

    act(() => {
      section(result.current).actions.changeEmail("retry@example.com");
      section(result.current).actions.changeGroups([activeGroup.id]);
    });
    dependencies.runAction.mockResolvedValueOnce({ error: "email_invalid" });
    await act(async () => section(result.current).actions.createInvite());

    expect(section(result.current).state).toMatchObject({
      email: "retry@example.com",
      formOpen: true,
      groupIds: [activeGroup.id],
      emailDelivery: "sent",
      oneTimeUrl: "https://aiqsa.example/login?invite=first-token",
      oneTimeUrlCopied: true
    });
  });

  it.each([
    {
      delivery: "not_requested" as const,
      expectedError: null,
      expectedNotice: "Invite created without email. Copy and share the link below.",
      sendEmail: false
    },
    {
      delivery: "unavailable" as const,
      expectedError: "Invite created, but email delivery is not configured. Copy and share the link below.",
      expectedNotice: null,
      sendEmail: true
    },
    {
      delivery: "failed" as const,
      expectedError: "Invite created, but the email could not be sent. Copy and share the link below.",
      expectedNotice: null,
      sendEmail: true
    }
  ])("keeps the link and reports $delivery invite email delivery truthfully", async (testCase) => {
    const dependencies = createDependencies();
    dependencies.runAction.mockResolvedValueOnce({
      emailDelivery: testCase.delivery,
      inviteUrl: "https://aiqsa.example/login?invite=delivery-token"
    });
    const { result } = renderHook(() =>
      useAdminInvitesController({
        ...dependencies,
        actionsDisabled: false,
        dashboard,
        nowMs
      })
    );

    act(() => {
      section(result.current).actions.changeEmail("person@example.com");
      section(result.current).actions.changeSendEmail(testCase.sendEmail);
    });
    await act(async () => section(result.current).actions.createInvite());

    expect(dependencies.runAction).toHaveBeenCalledWith(
      {
        action: "create_invite",
        email: "person@example.com",
        groupIds: [],
        sendEmail: testCase.sendEmail
      },
      "Invite created.",
      { successNotice: false }
    );
    expect(section(result.current).state).toMatchObject({
      emailDelivery: testCase.delivery,
      oneTimeUrl: "https://aiqsa.example/login?invite=delivery-token",
      sendEmail: true
    });

    if (testCase.expectedNotice) {
      expect(dependencies.feedback.reportNotice).toHaveBeenCalledWith(testCase.expectedNotice);
      expect(dependencies.feedback.reportError).not.toHaveBeenCalled();
    } else {
      expect(dependencies.feedback.reportError).toHaveBeenCalledWith(testCase.expectedError);
      expect(dependencies.feedback.reportNotice).not.toHaveBeenCalled();
    }
  });

  it("builds exact revoke and delete confirmation targets", () => {
    const dependencies = createDependencies();
    const { result } = renderHook(() =>
      useAdminInvitesController({
        ...dependencies,
        actionsDisabled: false,
        dashboard,
        nowMs
      })
    );
    const target = { email: "person@example.com", id: "invite-1" };

    act(() => {
      section(result.current).actions.requestRevokeInvite(target);
      section(result.current).actions.requestDeleteInvite(target);
    });

    expect(dependencies.confirmation.requestConfirmedAction).toHaveBeenNthCalledWith(1, {
      body: { action: "revoke_invite", inviteId: target.id },
      confirmLabel: "Revoke invite",
      dialogLabel: "Revoke invite for person@example.com",
      message: "Invite revoked.",
      prompt: "Revoke the open invite for person@example.com? The invite link will stop working.",
      testId: "admin-confirm-revoke-invite",
      title: "Revoke invite?"
    });
    expect(dependencies.confirmation.requestConfirmedAction).toHaveBeenNthCalledWith(2, {
      body: { action: "delete_invite", inviteId: target.id },
      confirmLabel: "Delete invite",
      dialogLabel: "Delete invite for person@example.com",
      icon: "trash",
      message: "Invite deleted.",
      onSuccess: expect.any(Function),
      prompt:
        "Delete the stale invite for person@example.com? Expired or revoked invite records and their hashed tokens will be removed.",
      testId: "admin-confirm-delete-invite",
      title: "Delete stale invite?"
    });
  });
});
