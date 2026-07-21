import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminGroup, AdminInviteRecord } from "@/lib/contracts/admin";
import {
  AdminInvitesSection,
  type AdminInvitesSectionActions,
  type AdminInvitesSectionProps
} from "./AdminInvitesSection";

const nowMs = Date.parse("2026-07-12T00:00:00.000Z");

const groups: AdminGroup[] = [
  {
    accessGrants: [],
    archivedAt: null,
    id: "group-1",
    name: "operators",
    userCount: 1
  }
];

const openInvite: AdminInviteRecord = {
  acceptedAt: null,
  deletion: {
    canDelete: false,
    reason: "invite_open",
    summary: "Revoke this open invite before deleting it."
  },
  defaultGroups: [{ groupId: "group-1", name: "operators", role: "member" }],
  email: "open@example.com",
  expiresAt: "2026-07-20T00:00:00.000Z",
  id: "invite-open",
  normalizedEmail: "open@example.com",
  revokedAt: null
};

const revokedInvite: AdminInviteRecord = {
  acceptedAt: null,
  deletion: {
    canDelete: true,
    reason: null,
    summary: "This stale invite can be deleted."
  },
  defaultGroups: [],
  email: "revoked@example.com",
  expiresAt: "2026-07-20T00:00:00.000Z",
  id: "invite-revoked",
  normalizedEmail: "revoked@example.com",
  revokedAt: "2026-07-11T00:00:00.000Z"
};

const acceptedInvite: AdminInviteRecord = {
  acceptedAt: "2026-07-10T00:00:00.000Z",
  deletion: {
    canDelete: false,
    reason: "invite_accepted",
    summary: "Accepted invites are kept for audit history."
  },
  defaultGroups: [],
  email: "accepted@example.com",
  expiresAt: "2026-07-20T00:00:00.000Z",
  id: "invite-accepted",
  normalizedEmail: "accepted@example.com",
  revokedAt: null
};

function actions(): AdminInvitesSectionActions {
  return {
    changeEmail: vi.fn<AdminInvitesSectionActions["changeEmail"]>(),
    changeGroups: vi.fn<AdminInvitesSectionActions["changeGroups"]>(),
    changeQuery: vi.fn<AdminInvitesSectionActions["changeQuery"]>(),
    changeSendEmail: vi.fn<AdminInvitesSectionActions["changeSendEmail"]>(),
    changeStatusFilter: vi.fn<AdminInvitesSectionActions["changeStatusFilter"]>(),
    copyOneTimeUrl: vi.fn<AdminInvitesSectionActions["copyOneTimeUrl"]>(),
    createInvite: vi.fn<AdminInvitesSectionActions["createInvite"]>(),
    requestDeleteInvite: vi.fn<AdminInvitesSectionActions["requestDeleteInvite"]>(),
    requestRevokeInvite: vi.fn<AdminInvitesSectionActions["requestRevokeInvite"]>()
  };
}

function props(
  sectionActions: AdminInvitesSectionActions,
  overrides: Partial<AdminInvitesSectionProps> = {}
): AdminInvitesSectionProps {
  return {
    actions: sectionActions,
    data: {
      groups,
      invites: [openInvite],
      nowMs,
      totalInviteCount: 1
    },
    state: {
      email: "friend@example.com",
      emailDelivery: null,
      emailError: null,
      formOpen: true,
      groupIds: [],
      oneTimeUrl: null,
      oneTimeUrlCopied: false,
      query: "",
      sendEmail: true,
      statusFilter: "all"
    },
    status: {
      actionsDisabled: false
    },
    ...overrides
  };
}

function rowFor(email: string): HTMLTableRowElement {
  const row = screen.getByText(email).closest("tr");
  if (!row) {
    throw new Error(`Expected invite row for ${email}`);
  }

  return row;
}

describe("AdminInvitesSection", () => {
  it("wires the controlled form, filters, one-time URL, and error association", () => {
    const sectionActions = actions();
    const inviteUrl = "https://aiqsa.example/login?invite=one-time-token";

    render(
      <AdminInvitesSection
        {...props(sectionActions, {
          state: {
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
    expect(email).toHaveAttribute("id", "invite-email");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAttribute("aria-describedby", "invite-email-error");
    expect(screen.getByText("Enter the invited email address.")).toHaveAttribute("id", "invite-email-error");

    fireEvent.change(email, { target: { value: "next@example.com" } });
    expect(sectionActions.changeEmail).toHaveBeenCalledWith("next@example.com");

    fireEvent.click(screen.getByLabelText("operators"));
    expect(sectionActions.changeGroups).toHaveBeenCalledWith(["group-1"]);

    const sendEmail = screen.getByRole("checkbox", { name: "Send invitation email" });
    expect(sendEmail).toBeChecked();
    expect(sendEmail).toHaveAccessibleDescription(/configured SMTP/i);
    fireEvent.click(sendEmail);
    expect(sectionActions.changeSendEmail).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    expect(sectionActions.createInvite).toHaveBeenCalledTimes(1);

    expect(screen.getByLabelText("Invite create-account link")).toHaveValue(inviteUrl);
    expect(screen.getByText(/invitation email was sent/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(sectionActions.copyOneTimeUrl).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Search invites"), { target: { value: "accepted" } });
    expect(sectionActions.changeQuery).toHaveBeenCalledWith("accepted");
    expect(screen.getByRole("button", { name: "open" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "accepted" }));
    expect(sectionActions.changeStatusFilter).toHaveBeenCalledWith("accepted");
    expect(screen.getByRole("region", { name: "Invites table" })).toHaveAttribute("tabindex", "0");
  });

  it("delegates only the actions allowed by each invite lifecycle state", () => {
    const sectionActions = actions();

    render(
      <AdminInvitesSection
        {...props(sectionActions, {
          data: {
            groups,
            invites: [openInvite, revokedInvite, acceptedInvite],
            nowMs,
            totalInviteCount: 3
          },
          state: {
            email: "",
            emailDelivery: null,
            emailError: null,
            formOpen: false,
            groupIds: [],
            oneTimeUrl: null,
            oneTimeUrlCopied: false,
            query: "",
            sendEmail: true,
            statusFilter: "all"
          }
        })}
      />
    );

    const openRow = rowFor(openInvite.email);
    expect(within(openRow).getByText("open", { exact: true })).toBeVisible();
    expect(within(openRow).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    fireEvent.click(within(openRow).getByRole("button", { name: "Revoke" }));
    expect(sectionActions.requestRevokeInvite).toHaveBeenCalledWith({
      email: openInvite.email,
      id: openInvite.id
    });

    const revokedRow = rowFor(revokedInvite.email);
    expect(within(revokedRow).getByText("revoked", { exact: true })).toBeVisible();
    expect(within(revokedRow).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
    fireEvent.click(within(revokedRow).getByRole("button", { name: "Delete" }));
    expect(sectionActions.requestDeleteInvite).toHaveBeenCalledWith({
      email: revokedInvite.email,
      id: revokedInvite.id
    });

    const acceptedRow = rowFor(acceptedInvite.email);
    expect(within(acceptedRow).queryByRole("button")).not.toBeInTheDocument();
    expect(within(acceptedRow).getByText("Accepted invites are kept for audit history.")).toBeVisible();
  });

  it("distinguishes no invites from an empty filtered view", () => {
    const sectionActions = actions();
    const { rerender } = render(
      <AdminInvitesSection
        {...props(sectionActions, {
          data: {
            groups,
            invites: [],
            nowMs,
            totalInviteCount: 0
          }
        })}
      />
    );

    expect(screen.getByText("No invites").closest("td")).toHaveAttribute("colspan", "4");

    rerender(
      <AdminInvitesSection
        {...props(sectionActions, {
          data: {
            groups,
            invites: [],
            nowMs,
            totalInviteCount: 2
          }
        })}
      />
    );

    expect(screen.getByText("No invites match this view").closest("td")).toHaveAttribute("colspan", "4");
  });

  it("disables mutation controls without disabling manual one-time URL copy", () => {
    const sectionActions = actions();

    render(
      <AdminInvitesSection
        {...props(sectionActions, {
          data: {
            groups,
            invites: [openInvite, revokedInvite],
            nowMs,
            totalInviteCount: 2
          },
          state: {
            email: "friend@example.com",
            emailDelivery: "failed",
            emailError: null,
            formOpen: true,
            groupIds: [],
            oneTimeUrl: "https://aiqsa.example/login?invite=one-time-token",
            oneTimeUrlCopied: true,
            query: "",
            sendEmail: true,
            statusFilter: "all"
          },
          status: {
            actionsDisabled: true
          }
        })}
      />
    );

    expect(screen.getByRole("button", { name: "Create invite" })).toBeDisabled();
    expect(screen.getByText(/email could not be sent/i)).toBeVisible();
    expect(within(rowFor(openInvite.email)).getByRole("button", { name: "Revoke" })).toBeDisabled();
    expect(within(rowFor(revokedInvite.email)).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copied" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    fireEvent.click(within(rowFor(openInvite.email)).getByRole("button", { name: "Revoke" }));
    fireEvent.click(within(rowFor(revokedInvite.email)).getByRole("button", { name: "Delete" }));
    expect(sectionActions.createInvite).not.toHaveBeenCalled();
    expect(sectionActions.requestRevokeInvite).not.toHaveBeenCalled();
    expect(sectionActions.requestDeleteInvite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    expect(sectionActions.copyOneTimeUrl).toHaveBeenCalledTimes(1);
  });
});
