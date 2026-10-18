import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminInviteRecord } from "@/lib/contracts/admin";
import type { AdminSignInRefusal, AdminSignInRefusals as RefusalPage } from "@/lib/contracts/adminSignInRefusals";
import { AdminSignInRefusals } from "./AdminSignInRefusals";
import type { AdminSignInRefusalsRequest, AdminSignInRefusalsResult } from "./useAdminSignInRefusals";

const times = { firstSeenAt: "2026-10-16T06:31:00.000Z", lastSeenAt: "2026-10-16T06:32:00.000Z" };
const dana = { displayName: "Dana Lee", email: "dana@example.com", id: "user-dana", status: "disabled" as const };

function refusal(overrides: Partial<AdminSignInRefusal> & Pick<AdminSignInRefusal, "id" | "subject">): AdminSignInRefusal {
  return { attempts: 1, code: "not_allowed", method: "google", ...times, ...overrides };
}

function pageOf(refusals: AdminSignInRefusal[], extra: Partial<RefusalPage> = {}): AdminSignInRefusalsResult {
  return { ok: true, page: { generatedAt: "2026-10-18T12:00:00.000Z", refusals, total: refusals.length, truncated: false, ...extra } };
}

function openInvite(email: string): AdminInviteRecord {
  return {
    acceptedAt: null, defaultGroups: [], email, expiresAt: "2026-10-25T12:00:00.000Z", id: `invite-${email}`,
    normalizedEmail: email, revokedAt: null
  };
}

function renderBlock(input: { actionsDisabled?: boolean; invites?: AdminInviteRecord[]; request: AdminSignInRefusalsRequest }) {
  const onInvite = vi.fn();
  const onOpenUser = vi.fn();
  render(
    <AdminSignInRefusals
      invites={{ actionsDisabled: input.actionsDisabled ?? false, open: input.invites ?? [] }}
      onInvite={onInvite}
      onOpenUser={onOpenUser}
      request={input.request}
    />
  );
  return { onInvite, onOpenUser };
}

function rowWith(text: string): HTMLElement {
  const row = screen.getAllByTestId("admin-sign-in-refusal").find((candidate) => candidate.textContent?.includes(text));
  if (!row) throw new Error(`No refused sign-in row with ${text}`);
  return row;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/admin?section=users");
});

describe("AdminSignInRefusals", () => {
  it("lists who was refused with the method, reason and attempts, and the action that fits each", async () => {
    const request = vi.fn<AdminSignInRefusalsRequest>(async () => pageOf([
      refusal({ attempts: 2, id: "stranger", method: "yandex", subject: { account: null, email: "ana@example.com", kind: "email" } }),
      refusal({ id: "known-email", subject: { account: dana, email: dana.email, kind: "email" } }),
      refusal({ attempts: 4, code: "invalid_credentials", id: "account", method: "password", subject: { account: dana, kind: "account" } }),
      refusal({ code: "account_conflict", id: "unverified", method: "saml", subject: { kind: "no_verified_email" } }),
      refusal({ attempts: 9, id: "overflow", subject: { kind: "overflow" } })
    ]));
    const { onInvite, onOpenUser } = renderBlock({ request });

    const block = screen.getByTestId("admin-sign-in-refusals");
    expect(await within(block).findByRole("heading", { name: "Refused sign-ins · 5" })).toBeInTheDocument();
    expect(within(block).getAllByTestId("admin-sign-in-refusal")).toHaveLength(5);

    const stranger = rowWith("ana@example.com");
    expect(stranger).toHaveTextContent("Yandex · Not allowed to sign in · 2 attempts");
    fireEvent.click(within(stranger).getByRole("button", { name: "Invite ana@example.com" }));
    expect(onInvite).toHaveBeenCalledExactlyOnceWith("ana@example.com");
    expect(within(stranger).queryByRole("link")).not.toBeInTheDocument();

    const knownEmail = within(block).getAllByTestId("admin-sign-in-refusal")[1]!;
    expect(knownEmail).toHaveTextContent("Dana Lee");
    expect(knownEmail).toHaveTextContent("dana@example.com · disabled · Google · Not allowed to sign in · 1 attempt");
    expect(within(knownEmail).queryByRole("button", { name: /Invite/u })).not.toBeInTheDocument();
    const open = within(knownEmail).getByRole("link", { name: "Open user Dana Lee" });
    expect(open).toHaveAttribute("href", "/admin?section=users&resource=user-dana");
    fireEvent.click(open);
    expect(onOpenUser).toHaveBeenCalledExactlyOnceWith("user-dana");

    const account = rowWith("Wrong password");
    expect(account).toHaveTextContent("Dana Lee");
    expect(account).toHaveTextContent("dana@example.com · disabled · Password · Wrong password · 4 attempts");
    expect(within(account).getByRole("link", { name: "Open user Dana Lee" })).toBeInTheDocument();

    const unverified = rowWith("No verified email");
    expect(unverified).toHaveTextContent("SAML · Could not be linked to the existing account · 1 attempt");
    expect(within(unverified).queryByRole("button")).not.toBeInTheDocument();
    expect(within(unverified).queryByRole("link")).not.toBeInTheDocument();

    const overflow = rowWith("daily limit reached");
    expect(overflow).toHaveTextContent("Google · Not allowed to sign in · 9 attempts");
    expect(within(overflow).queryByRole("button")).not.toBeInTheDocument();

    expect(within(block).getByText(/Kept for 30 days/u)).toHaveTextContent(
      "An email is recorded only when the sign-in method verified it; password and two-factor attempts only for existing accounts."
    );
    expect(block.textContent).not.toMatch(/email:|no_verified_email|overflow|not_allowed|invalid_credentials/u);
  });

  it("marks an email that already has an open invite instead of offering another", async () => {
    const request = vi.fn<AdminSignInRefusalsRequest>(async () => pageOf([
      refusal({ id: "invited", subject: { account: null, email: "ana@example.com", kind: "email" } })
    ]));
    renderBlock({ invites: [openInvite("ana@example.com")], request });

    const row = await screen.findByTestId("admin-sign-in-refusal");
    expect(within(row).getByText("Invited")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Invite/u })).not.toBeInTheDocument();
  });

  it("holds Invite while another administrator action runs", async () => {
    const request = vi.fn<AdminSignInRefusalsRequest>(async () => pageOf([
      refusal({ id: "stranger", subject: { account: null, email: "ana@example.com", kind: "email" } })
    ]));
    renderBlock({ actionsDisabled: true, request });

    expect(await screen.findByRole("button", { name: "Invite ana@example.com" })).toBeDisabled();
  });

  it("shows the newest five, the rest on demand, and says when the list was cut", async () => {
    const entries = Array.from({ length: 7 }, (_, index) =>
      refusal({ id: `entry-${index}`, subject: { account: null, email: `person-${index}@example.com`, kind: "email" } }));
    const request = vi.fn<AdminSignInRefusalsRequest>(async () => pageOf(entries, { total: 640, truncated: true }));
    renderBlock({ request });

    const block = screen.getByTestId("admin-sign-in-refusals");
    expect(await within(block).findAllByTestId("admin-sign-in-refusal")).toHaveLength(5);
    expect(within(block).getByText("Showing the newest 7 of 640.")).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button", { name: "Show 2 more" }));
    expect(within(block).getAllByTestId("admin-sign-in-refusal")).toHaveLength(7);
    expect(within(block).queryByRole("button", { name: /Show \d+ more/u })).not.toBeInTheDocument();
  });

  it("tells loading apart from a quiet month", async () => {
    let resolve!: (result: AdminSignInRefusalsResult) => void;
    const request = vi.fn<AdminSignInRefusalsRequest>(() => new Promise((next) => { resolve = next; }));
    renderBlock({ request });

    expect(screen.getByText("Loading refused sign-ins…")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Refused sign-ins" })).toBeInTheDocument();
    await act(async () => { resolve(pageOf([])); });
    expect(await screen.findByTestId("admin-sign-in-refusals-empty")).toHaveTextContent("No refused sign-ins in the last 30 days.");
    expect(screen.getByRole("heading", { name: "Refused sign-ins · 0" })).toBeInTheDocument();
    expect(screen.queryByText("Loading refused sign-ins…")).not.toBeInTheDocument();
  });

  it("offers Try again after a failed read and shows the list it then gets", async () => {
    const request = vi.fn<AdminSignInRefusalsRequest>()
      .mockResolvedValueOnce({ error: "unavailable", ok: false })
      .mockResolvedValueOnce(pageOf([refusal({ id: "later", subject: { account: null, email: "ana@example.com", kind: "email" } })]));
    renderBlock({ request });

    const unavailable = await screen.findByTestId("admin-sign-in-refusals-unavailable");
    expect(unavailable).toHaveTextContent("Refused sign-ins could not be loaded.");
    expect(screen.queryByTestId("admin-sign-in-refusals-empty")).not.toBeInTheDocument();
    fireEvent.click(within(unavailable).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("admin-sign-in-refusal")).toHaveTextContent("ana@example.com");
  });
});
