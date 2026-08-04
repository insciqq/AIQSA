import { describe, expect, it } from "vitest";
import type { AdminInviteRecord } from "@/lib/contracts/admin";
import {
  filterAdminInvites,
  inviteStatusClass,
  inviteStatus,
  isInviteExpiringSoon,
  isInviteOpen
} from "./adminInviteView";

const nowMs = Date.parse("2026-07-12T00:00:00.000Z");

function invite(overrides: Partial<AdminInviteRecord> = {}): AdminInviteRecord {
  return {
    acceptedAt: null,
    defaultGroups: [],
    email: "person@example.com",
    expiresAt: "2026-07-16T00:00:00.000Z",
    id: "invite-1",
    normalizedEmail: "person@example.com",
    revokedAt: null,
    ...overrides
  };
}

describe("adminInviteView", () => {
  it("keeps semantic status tones by default and readable text on selected rows", () => {
    expect(inviteStatusClass("revoked")).toBe(
      "border-critical/25 bg-critical/10 text-critical"
    );
    expect(inviteStatusClass("revoked", true)).toBe(
      "border-critical/25 bg-critical/10 text-ink"
    );
    expect(inviteStatusClass("expired")).toBe(
      "border-trace-subtle bg-control-surface text-ink-secondary"
    );
    expect(inviteStatusClass("expired", true)).toBe(
      "border-trace-subtle bg-control-surface text-ink"
    );
  });

  it("keeps open, soon, and exact-expiry boundaries deterministic", () => {
    const open = invite();
    const soon = invite({ expiresAt: "2026-07-15T00:00:00.000Z" });
    const expired = invite({ expiresAt: "2026-07-12T00:00:00.000Z" });

    expect(isInviteOpen(open, nowMs)).toBe(true);
    expect(isInviteExpiringSoon(open, nowMs)).toBe(false);
    expect(inviteStatus(open, nowMs)).toBe("open");
    expect(isInviteOpen(soon, nowMs)).toBe(true);
    expect(isInviteExpiringSoon(soon, nowMs)).toBe(true);
    expect(inviteStatus(soon, nowMs)).toBe("soon");
    expect(isInviteOpen(expired, nowMs)).toBe(false);
    expect(inviteStatus(expired, nowMs)).toBe("expired");
  });

  it("gives accepted and revoked state precedence over expiry", () => {
    expect(
      inviteStatus(
        invite({
          acceptedAt: "2026-07-11T00:00:00.000Z",
          expiresAt: "2026-07-10T00:00:00.000Z",
          revokedAt: "2026-07-11T12:00:00.000Z"
        }),
        nowMs
      )
    ).toBe("accepted");
    expect(
      inviteStatus(
        invite({
          expiresAt: "2026-07-20T00:00:00.000Z",
          revokedAt: "2026-07-11T00:00:00.000Z"
        }),
        nowMs
      )
    ).toBe("revoked");
  });

  it("filters against the fixed clock, lifecycle status, identity, and default groups", () => {
    const open = invite({ id: "open" });
    const soon = invite({
      defaultGroups: [{ groupId: "group-1", name: "Operators", role: "member" }],
      email: "soon@example.com",
      expiresAt: "2026-07-15T00:00:00.000Z",
      id: "soon",
      normalizedEmail: "soon@example.com"
    });
    const accepted = invite({
      acceptedAt: "2026-07-11T00:00:00.000Z",
      email: "accepted@example.com",
      id: "accepted",
      normalizedEmail: "accepted@example.com"
    });
    const invites = [open, soon, accepted];

    expect(filterAdminInvites(invites, "", "soon", nowMs).map((record) => record.id)).toEqual([soon.id]);
    expect(filterAdminInvites(invites, "OPERATORS", "all", nowMs).map((record) => record.id)).toEqual([soon.id]);
    expect(filterAdminInvites(invites, "accepted", "accepted", nowMs).map((record) => record.id)).toEqual([
      accepted.id
    ]);
    expect(filterAdminInvites(invites, "soon", "open", nowMs)).toEqual([]);
  });
});
