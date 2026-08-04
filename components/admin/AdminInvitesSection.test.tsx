import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminGroup, AdminInviteRecord } from "@/lib/contracts/admin";
import { AdminInvitesSection, type AdminInvitesSectionActions, type AdminInvitesSectionProps } from "./AdminInvitesSection";

const nowMs = Date.parse("2026-07-12T00:00:00.000Z");
const groups: AdminGroup[] = [{ accessGrants: [], archivedAt: null, id: "group-1", name: "operators", systemRole: null, userCount: 1 }];

const openInvite: AdminInviteRecord = {
  acceptedAt: null,
  deletion: { canDelete: false, reason: "invite_open", summary: "Revoke this open invite before deleting it." },
  defaultGroups: [{ groupId: "group-1", name: "operators", role: "member" }],
  email: "open@example.com",
  expiresAt: "2026-07-20T00:00:00.000Z",
  id: "invite-open",
  normalizedEmail: "open@example.com",
  revokedAt: null
};

const revokedInvite: AdminInviteRecord = {
  acceptedAt: null,
  deletion: { canDelete: true, reason: null, summary: "This stale invite can be deleted." },
  defaultGroups: [],
  email: "revoked@example.com",
  expiresAt: "2026-07-20T00:00:00.000Z",
  id: "invite-revoked",
  normalizedEmail: "revoked@example.com",
  revokedAt: "2026-07-11T00:00:00.000Z"
};

const acceptedInvite: AdminInviteRecord = {
  acceptedAt: "2026-07-10T00:00:00.000Z",
  deletion: { canDelete: false, reason: "invite_accepted", summary: "Accepted invites are kept for audit history." },
  defaultGroups: [],
  email: "accepted@example.com",
  expiresAt: "2026-07-20T00:00:00.000Z",
  id: "invite-accepted",
  normalizedEmail: "accepted@example.com",
  revokedAt: null
};

function actions(): AdminInvitesSectionActions {
  return {
    backToList: vi.fn(),
    changeEmail: vi.fn(),
    changeGroups: vi.fn(),
    changeQuery: vi.fn(),
    changeSendEmail: vi.fn(),
    changeStatusFilter: vi.fn(),
    copyOneTimeUrl: vi.fn(),
    createInvite: vi.fn(),
    requestDeleteInvite: vi.fn(),
    requestRevokeInvite: vi.fn(),
    selectInvite: vi.fn()
  };
}

function props(sectionActions: AdminInvitesSectionActions, overrides: Partial<AdminInvitesSectionProps> = {}): AdminInvitesSectionProps {
  return {
    actions: sectionActions,
    data: { groups, invites: [openInvite], nowMs, selectedInvite: null, totalInviteCount: 1 },
    state: {
      compactDetailOpen: false,
      email: "friend@example.com",
      emailDelivery: null,
      emailError: null,
      formOpen: false,
      groupIds: [],
      oneTimeUrl: null,
      oneTimeUrlCopied: false,
      query: "",
      sendEmail: true,
      statusFilter: "all"
    },
    status: { actionsDisabled: false },
    ...overrides
  };
}

describe("AdminInvitesSection", () => {
  it("keeps history and detail mounted and delegates list filtering and selection", () => {
    const sectionActions = actions();
    render(<AdminInvitesSection {...props(sectionActions)} />);

    expect(screen.getByTestId("admin-invites-index")).toHaveClass("block");
    expect(screen.getByTestId("admin-invites-index")).not.toHaveClass("lg:block");
    expect(screen.getByTestId("admin-invites-detail-pane")).toHaveClass("hidden");
    expect(screen.getByTestId("admin-invites-detail-pane")).not.toHaveClass("lg:block");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search invites"), { target: { value: "accepted" } });
    fireEvent.click(screen.getByRole("button", { name: "Expiring soon" }));
    fireEvent.click(screen.getByRole("button", { name: "Accepted" }));
    fireEvent.click(within(screen.getByTestId("admin-invite-row")).getByRole("button", { name: "Details" }));

    expect(sectionActions.changeQuery).toHaveBeenCalledWith("accepted");
    expect(sectionActions.changeStatusFilter).toHaveBeenNthCalledWith(1, "soon");
    expect(sectionActions.changeStatusFilter).toHaveBeenNthCalledWith(2, "accepted");
    expect(sectionActions.selectInvite).toHaveBeenCalledWith(openInvite.id);
  });

  it("keeps create separate from history and exposes every one-time delivery outcome", () => {
    const sectionActions = actions();
    const inviteUrl = "https://aiqsa.example/login?invite=one-time-token";
    const view = render(
      <AdminInvitesSection
        {...props(sectionActions, {
          state: {
            compactDetailOpen: true,
            email: "friend@example.com",
            emailDelivery: "sent",
            emailError: "Enter the invited email address.",
            formOpen: true,
            groupIds: [],
            oneTimeUrl: inviteUrl,
            oneTimeUrlCopied: false,
            query: "open",
            sendEmail: true,
            statusFilter: "open"
          }
        })}
      />
    );

    const email = screen.getByLabelText("Email");
    expect(email).toHaveAccessibleDescription("Enter the invited email address.");
    fireEvent.change(email, { target: { value: "next@example.com" } });
    fireEvent.click(screen.getByLabelText("operators"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Send invitation email" }));
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    expect(screen.getByLabelText("Invite create-account link")).toHaveValue(inviteUrl);
    expect(screen.getByText(/invitation email was sent/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(sectionActions.changeEmail).toHaveBeenCalledWith("next@example.com");
    expect(sectionActions.changeGroups).toHaveBeenCalledWith(["group-1"]);
    expect(sectionActions.changeSendEmail).toHaveBeenCalledWith(false);
    expect(sectionActions.createInvite).toHaveBeenCalledTimes(1);
    expect(sectionActions.copyOneTimeUrl).toHaveBeenCalledTimes(1);

    for (const [delivery, copy] of [
      ["not_requested", /No invitation email was sent/],
      ["unavailable", /Email delivery is not configured/],
      ["failed", /email could not be sent/]
    ] as const) {
      view.rerender(
        <AdminInvitesSection
          {...props(sectionActions, {
            state: {
              compactDetailOpen: true,
              email: "",
              emailDelivery: delivery,
              emailError: null,
              formOpen: true,
              groupIds: [],
              oneTimeUrl: inviteUrl,
              oneTimeUrlCopied: false,
              query: "",
              sendEmail: true,
              statusFilter: "all"
            }
          })}
        />
      );
      expect(screen.getByText(copy)).toBeVisible();
    }
  });

  it("delegates revoke, stale delete, and accepted audit retention from invite detail", () => {
    const sectionActions = actions();
    const view = render(
      <AdminInvitesSection
        {...props(sectionActions, {
          data: { groups, invites: [openInvite, revokedInvite, acceptedInvite], nowMs, selectedInvite: openInvite, totalInviteCount: 3 },
          state: { ...props(sectionActions).state, compactDetailOpen: true }
        })}
      />
    );
    const inviteList = within(screen.getByTestId("admin-invites-list"));
    const selectedOpenRow = inviteList.getByText(openInvite.email).closest<HTMLElement>("[data-testid='admin-invite-row']");
    const unselectedRevokedRow = inviteList.getByText(revokedInvite.email).closest<HTMLElement>("[data-testid='admin-invite-row']");
    expect(selectedOpenRow).not.toBeNull();
    expect(unselectedRevokedRow).not.toBeNull();
    expect(within(selectedOpenRow!).getByText("open", { exact: true })).toHaveClass("text-ink");
    expect(within(unselectedRevokedRow!).getByText("revoked", { exact: true })).toHaveClass("text-critical");
    fireEvent.click(screen.getByRole("button", { name: "Revoke invite" }));
    expect(sectionActions.requestRevokeInvite).toHaveBeenCalledWith({ email: openInvite.email, id: openInvite.id });

    view.rerender(
      <AdminInvitesSection
        {...props(sectionActions, {
          data: { groups, invites: [openInvite, revokedInvite, acceptedInvite], nowMs, selectedInvite: revokedInvite, totalInviteCount: 3 },
          state: { ...props(sectionActions).state, compactDetailOpen: true }
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete invite" }));
    expect(sectionActions.requestDeleteInvite).toHaveBeenCalledWith({ email: revokedInvite.email, id: revokedInvite.id });

    view.rerender(
      <AdminInvitesSection
        {...props(sectionActions, {
          data: { groups, invites: [openInvite, revokedInvite, acceptedInvite], nowMs, selectedInvite: acceptedInvite, totalInviteCount: 3 },
          state: { ...props(sectionActions).state, compactDetailOpen: true }
        })}
      />
    );
    expect(screen.getByText("Accepted invites are kept for audit history.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Delete invite/ })).not.toBeInTheDocument();
  });

  it("distinguishes empty history and keeps manual copy enabled during another mutation", () => {
    const sectionActions = actions();
    const view = render(
      <AdminInvitesSection
        {...props(sectionActions, {
          data: { groups, invites: [], nowMs, selectedInvite: null, totalInviteCount: 0 }
        })}
      />
    );
    expect(screen.getByText("No invites")).toBeVisible();

    view.rerender(
      <AdminInvitesSection
        {...props(sectionActions, {
          data: { groups, invites: [], nowMs, selectedInvite: null, totalInviteCount: 2 },
          state: {
            compactDetailOpen: true,
            email: "friend@example.com",
            emailDelivery: "failed",
            emailError: null,
            formOpen: true,
            groupIds: [],
            oneTimeUrl: "https://aiqsa.example/login?invite=one-time-token",
            oneTimeUrlCopied: true,
            query: "missing",
            sendEmail: true,
            statusFilter: "all"
          },
          status: { actionsDisabled: true }
        })}
      />
    );
    expect(screen.getByText("No invites match this view")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create invite" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copied" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    expect(sectionActions.copyOneTimeUrl).toHaveBeenCalledTimes(1);
  });
});
