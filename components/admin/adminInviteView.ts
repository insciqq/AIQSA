import type { AdminDeletionInfo, AdminInviteRecord } from "@/lib/contracts/admin";

export type AdminInviteStatus = "accepted" | "expired" | "open" | "revoked" | "soon";
export type AdminInviteStatusFilter = "all" | AdminInviteStatus;

export function isInviteOpen(invite: AdminInviteRecord, nowMs: number): boolean {
  return !invite.acceptedAt && !invite.revokedAt && new Date(invite.expiresAt).getTime() > nowMs;
}

export function isInviteExpiringSoon(invite: AdminInviteRecord, nowMs: number): boolean {
  if (!isInviteOpen(invite, nowMs)) {
    return false;
  }

  return new Date(invite.expiresAt).getTime() <= nowMs + 3 * 24 * 60 * 60 * 1000;
}

export function inviteStatus(invite: AdminInviteRecord, nowMs: number): AdminInviteStatus {
  if (invite.acceptedAt) {
    return "accepted";
  }

  if (invite.revokedAt) {
    return "revoked";
  }

  if (!isInviteOpen(invite, nowMs)) {
    return "expired";
  }

  return isInviteExpiringSoon(invite, nowMs) ? "soon" : "open";
}

export function filterAdminInvites(
  invites: readonly AdminInviteRecord[],
  query: string,
  statusFilter: AdminInviteStatusFilter,
  nowMs: number
): AdminInviteRecord[] {
  const normalizedQuery = query.trim().toLowerCase();

  return invites.filter((invite) => {
    const status = inviteStatus(invite, nowMs);
    const matchesStatus = statusFilter === "all" || statusFilter === status;
    const haystack = [
      invite.email,
      invite.normalizedEmail,
      status,
      ...invite.defaultGroups.map((group) => group.name)
    ]
      .join(" ")
      .toLowerCase();

    return matchesStatus && (!normalizedQuery || haystack.includes(normalizedQuery));
  });
}

export function inviteStatusLabel(status: AdminInviteStatus): string {
  const labels: Record<AdminInviteStatus, string> = {
    accepted: "accepted",
    expired: "expired",
    open: "open",
    revoked: "revoked",
    soon: "expiring soon"
  };

  return labels[status];
}

export function inviteStatusClass(status: AdminInviteStatus, selected = false): string {
  const classes: Record<AdminInviteStatus, { frame: string; text: string }> = {
    accepted: { frame: "border-positive/25 bg-positive/10", text: "text-positive" },
    expired: { frame: "border-trace-subtle bg-control-surface", text: "text-ink-secondary" },
    open: { frame: "border-proof/25 bg-proof/10", text: "text-proof" },
    revoked: { frame: "border-critical/25 bg-critical/10", text: "text-critical" },
    soon: { frame: "border-caution/25 bg-caution/10", text: "text-caution" }
  };

  const presentation = classes[status];
  return `${presentation.frame} ${selected ? "text-ink" : presentation.text}`;
}

export function inviteDeletionInfo(invite: AdminInviteRecord, nowMs: number): AdminDeletionInfo {
  return (
    invite.deletion ?? {
      canDelete: !invite.acceptedAt && (Boolean(invite.revokedAt) || new Date(invite.expiresAt).getTime() <= nowMs),
      reason: invite.acceptedAt
        ? "invite_accepted"
        : !invite.revokedAt && new Date(invite.expiresAt).getTime() > nowMs
          ? "invite_open"
          : null,
      summary: invite.acceptedAt
        ? "Accepted invites are kept for audit history."
        : !invite.revokedAt && new Date(invite.expiresAt).getTime() > nowMs
          ? "Revoke this open invite before deleting it."
          : "This stale invite can be deleted."
    }
  );
}
