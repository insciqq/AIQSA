import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUsageLimits, AdminUsageLimitUserRow, AdminUsageUserOverride, EffectiveUsageLimit } from "@/lib/contracts/usageLimits";
import { AdminUsageLimitsSection } from "./AdminUsageLimitsSection";

const api = vi.hoisted(() => ({
  remove: vi.fn(),
  request: vi.fn(),
  saveGroup: vi.fn(),
  saveInstallation: vi.fn(),
  saveUser: vi.fn()
}));

vi.mock("./adminUsageLimitsApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./adminUsageLimitsApi")>(),
  removeUserUsageLimits: api.remove,
  requestAdminUsageLimits: api.request,
  saveGroupUsageLimits: api.saveGroup,
  saveInstallationUsageLimits: api.saveInstallation,
  saveUserUsageLimits: api.saveUser
}));

const unset = { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null };
const none: EffectiveUsageLimit = { source: null, value: null };
const research = { groupId: "g-research", kind: "group" as const, name: "Research" };
const fallback = { kind: "installation" as const };

function user(
  name: string,
  spent: number,
  effective: Partial<Record<"messagesPerDay" | "messagesPerHour" | "monthlyBudgetMicros", EffectiveUsageLimit>> & { exempt?: boolean },
  extra: Partial<AdminUsageLimitUserRow> = {}
): AdminUsageLimitUserRow {
  return {
    displayName: name,
    effective: {
      exempt: effective.exempt ?? false,
      messagesPerDay: effective.messagesPerDay ?? none,
      messagesPerHour: effective.messagesPerHour ?? { source: fallback, value: 30 },
      monthlyBudgetMicros: effective.monthlyBudgetMicros ?? { source: fallback, value: 5_000_000 }
    },
    email: `${name.toLowerCase()}@example.test`,
    messagesLastDay: 0,
    messagesLastHour: 0,
    monthSpentMicros: spent,
    override: null,
    status: "active",
    userId: `u-${name.toLowerCase()}`,
    ...extra
  };
}

const cyOverride: AdminUsageUserOverride = {
  ...unset, exempt: false, messagesPerHour: 3, monthlyBudgetMicros: 2_000_000, userId: "u-cy", version: 21
};

const limits: AdminUsageLimits = {
  groups: [
    { ...unset, archivedAt: null, groupId: "g-interns", memberCount: 1, monthlyBudgetMicros: 0, name: "Interns", version: 11 },
    { ...unset, archivedAt: "2026-09-01T00:00:00.000Z", groupId: "g-old", memberCount: 4, messagesPerDay: 5, name: "Old team", version: 12 },
    { ...unset, archivedAt: null, groupId: "g-research", memberCount: 2, monthlyBudgetMicros: 20_000_000, name: "Research", version: 13 }
  ],
  installation: { ...unset, messagesPerHour: 30, monthlyBudgetMicros: 5_000_000, monthlyCapMicros: 100_000_000, version: 4 },
  installationSpentMicros: 84_500_000,
  periodStart: "2026-10-01T00:00:00.000Z",
  resetsAt: "2026-11-01T00:00:00.000Z",
  users: [
    user("Ada", 1_000_000, {}),
    user("Bo", 17_000_000, { monthlyBudgetMicros: { source: research, value: 20_000_000 } }),
    user("Cy", 2_500_000, {
      messagesPerHour: { source: { kind: "user" }, value: 3 },
      monthlyBudgetMicros: { source: { kind: "user" }, value: 2_000_000 }
    }, { messagesLastDay: 7, messagesLastHour: 3, override: cyOverride }),
    user("Di", 9_000_000, { exempt: true, messagesPerHour: none, monthlyBudgetMicros: none },
      { override: { ...unset, exempt: true, userId: "u-di", version: 22 } }),
    user("Eve", 0, { monthlyBudgetMicros: { source: { groupId: "g-interns", kind: "group", name: "Interns" }, value: 0 } }),
    user("Ed", 0, {}, { status: "disabled" })
  ]
};

const reportNotice = vi.fn();

function row(name: string) {
  return screen.getAllByTestId("admin-usage-user-row").find((element) => element.dataset.userId === `u-${name.toLowerCase()}`)!;
}

async function renderSection() {
  render(<AdminUsageLimitsSection reportNotice={reportNotice} />);
  await screen.findByTestId("admin-usage-limits-summary");
}

describe("AdminUsageLimitsSection", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    api.request.mockResolvedValue({ limits, ok: true });
    reportNotice.mockReset();
  });

  it("summarizes the month and lists users by budget used with their sources and meters", async () => {
    await renderSection();
    const summary = screen.getByTestId("admin-usage-limits-summary");
    expect(summary).toHaveTextContent("≈ $84.50");
    expect(summary).toHaveTextContent("of the $100.00 monthly cap for everyone");
    expect(summary).toHaveTextContent("1 user reached their budget · 1 user above 80%");
    expect(within(summary).getByRole("meter", { name: "Monthly cap used" })).toHaveAttribute("aria-valuetext", "84% used · almost reached");
    expect(within(summary).getByText(/UTC calendar month/)).toBeInTheDocument();

    expect(screen.getAllByTestId("admin-usage-user-row").map((element) => element.dataset.userId))
      .toEqual(["u-cy", "u-eve", "u-bo", "u-ada", "u-ed", "u-di"]);
    expect(row("Cy")).toHaveTextContent("Override");
    expect(row("Cy")).toHaveTextContent("Budget reached · 125%");
    expect(row("Cy")).toHaveTextContent("Last hour: 3 of 3 · limit reached");
    expect(within(row("Cy")).getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    expect(row("Bo")).toHaveTextContent("Group: Research");
    expect(row("Bo")).toHaveTextContent("85% · near budget");
    expect(within(row("Bo")).getByRole("meter")).toHaveAttribute("data-tone", "near");
    expect(row("Ada")).toHaveTextContent("Default");
    expect(row("Ada")).toHaveTextContent("20% of budget");
    expect(row("Eve")).toHaveTextContent("Budget is $0 · no spending");
    expect(row("Di")).toHaveTextContent("Exempt");
    expect(within(row("Di")).queryByRole("meter")).not.toBeInTheDocument();
    expect(row("Ed")).toHaveTextContent("Disabled");
    expect(row("Ada")).toHaveTextContent("Personal spend");
    expect(screen.getByTestId("admin-usage-limit-users"))
      .toHaveTextContent("system features count only toward the monthly cap");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search users" }), { target: { value: "bo@" } });
    expect(screen.getAllByTestId("admin-usage-user-row").map((element) => element.dataset.userId)).toEqual(["u-bo"]);
  });

  it("marks archived groups as not applying and offers no edit for them", async () => {
    await renderSection();
    const groups = screen.getAllByTestId("admin-usage-group-row");
    expect(groups.map((element) => element.textContent)).toEqual([
      expect.stringContaining("Interns"), expect.stringContaining("Research"), expect.stringContaining("Old team")
    ]);
    expect(groups[2]).toHaveTextContent("Archived · does not apply");
    expect(within(groups[2]!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(groups[1]!).getByRole("button", { name: "Edit allowance for Research" })).toBeEnabled();
  });

  it("validates the installation form inline and saves against the version it read", async () => {
    api.saveInstallation.mockResolvedValue({
      limits: { ...limits, installation: { ...limits.installation, messagesPerHour: null, monthlyCapMicros: 250_500_000, version: 5 } },
      ok: true
    });
    await renderSection();
    const cap = screen.getByRole("textbox", { name: "Monthly cap for everyone" });
    expect(cap).toHaveValue("100");
    expect(screen.getByRole("textbox", { name: "Monthly budget per user" })).toHaveValue("5");
    fireEvent.change(cap, { target: { value: "lots" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(cap).toHaveFocus());
    expect(cap).toHaveAttribute("aria-invalid", "true");
    expect(cap).toHaveAccessibleDescription("Enter a dollar amount from 0 to 1,000,000, like 25 or 12.50.");
    expect(api.saveInstallation).not.toHaveBeenCalled();

    fireEvent.change(cap, { target: { value: "250.5" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Messages per hour" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(reportNotice).toHaveBeenCalledWith("Limits saved. They apply to new messages."));
    expect(api.saveInstallation).toHaveBeenCalledWith({
      expectedVersion: 4, messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: 5_000_000, monthlyCapMicros: 250_500_000
    });
    expect(cap).toHaveValue("250.50");
    expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();
  });

  it("keeps the typed values after a stale save and rereads the saved ones", async () => {
    api.saveInstallation.mockResolvedValue({ error: "usage_limits_stale", ok: false });
    await renderSection();
    const perDay = screen.getByRole("textbox", { name: "Messages per day" });
    fireEvent.change(perDay, { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Limits changed in another session");
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
    expect(perDay).toHaveValue("40");
    expect(perDay).toHaveAccessibleDescription(/^Saved: not set\./u);
  });

  it("edits a group allowance in a sheet and asks before discarding unsaved edits", async () => {
    api.saveGroup.mockResolvedValue({ limits, ok: true });
    await renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit allowance for Research" }));
    let sheet = await screen.findByTestId("admin-usage-group-limits-sheet");
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Messages per day" }), { target: { value: "9" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm discard changes" }));
    await waitFor(() => expect(screen.queryByTestId("admin-usage-group-limits-sheet")).not.toBeInTheDocument());
    expect(api.saveGroup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Edit allowance for Research" }));
    sheet = await screen.findByTestId("admin-usage-group-limits-sheet");
    expect(within(sheet).getByRole("textbox", { name: "Monthly budget" })).toHaveValue("20");
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Messages per day" }), { target: { value: "40" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(reportNotice).toHaveBeenCalledWith("Allowance for Research saved."));
    expect(api.saveGroup).toHaveBeenCalledWith("g-research", {
      expectedVersion: 13, messagesPerDay: 40, messagesPerHour: null, monthlyBudgetMicros: 20_000_000
    });
    expect(screen.queryByTestId("admin-usage-group-limits-sheet")).not.toBeInTheDocument();
  });

  it("sets exemption and removes an override from the user sheet", async () => {
    api.saveUser.mockResolvedValue({ limits, ok: true });
    api.remove.mockResolvedValue({ limits, ok: true });
    await renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit limits for Cy" }));
    let sheet = await screen.findByTestId("admin-usage-user-limits-sheet");
    expect(within(sheet).getByRole("textbox", { name: "Monthly budget" })).toHaveValue("2");
    expect(within(sheet).getByRole("textbox", { name: "Monthly budget" }))
      .toHaveAccessibleDescription("Leave empty to inherit from groups or the default.");
    expect(within(sheet).getByRole("textbox", { name: "Messages per day" }))
      .toHaveAccessibleDescription("Leave empty for no limit, as now.");
    fireEvent.click(within(sheet).getByRole("switch", { name: "Exempt from per-user limits" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveUser).toHaveBeenCalledWith("u-cy", {
      exempt: true, expectedVersion: 21, messagesPerDay: null, messagesPerHour: 3, monthlyBudgetMicros: 2_000_000
    }));
    expect(reportNotice).toHaveBeenCalledWith("Limits for Cy saved.");

    fireEvent.click(screen.getByRole("button", { name: "Edit limits for Cy" }));
    sheet = await screen.findByTestId("admin-usage-user-limits-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove override" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("u-cy", 21));
    expect(reportNotice).toHaveBeenCalledWith("Override removed. Cy now follows group and default limits.");

    fireEvent.click(screen.getByRole("button", { name: "Edit limits for Ada" }));
    sheet = await screen.findByTestId("admin-usage-user-limits-sheet");
    expect(within(sheet).queryByRole("button", { name: "Remove override" })).not.toBeInTheDocument();
    expect(within(sheet).getByRole("textbox", { name: "Monthly budget" }))
      .toHaveAccessibleDescription("Leave empty to inherit the default, $5.00.");
  });

  it("saves a group allowance against the version it opened with and shows a newer save as a conflict", async () => {
    // Another administrator changes Research while this sheet is open.
    const newer: AdminUsageLimits = {
      ...limits,
      groups: limits.groups.map((group) => group.groupId === "g-research"
        ? { ...group, messagesPerHour: 15, monthlyBudgetMicros: 30_000_000, version: 14 }
        : group)
    };
    api.saveGroup.mockResolvedValueOnce({ error: "usage_limits_stale", ok: false }).mockResolvedValueOnce({ limits: newer, ok: true });
    await renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit allowance for Research" }));
    const sheet = await screen.findByTestId("admin-usage-group-limits-sheet");
    const perDay = within(sheet).getByRole("textbox", { name: "Messages per day" });
    fireEvent.change(perDay, { target: { value: "40" } });
    api.request.mockResolvedValue({ limits: newer, ok: true });
    // The background refresh lands while the administrator is typing.
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
    expect(perDay).toHaveValue("40");
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Limits changed in another session");
    expect(api.saveGroup).toHaveBeenLastCalledWith("g-research", expect.objectContaining({ expectedVersion: 13, messagesPerDay: 40 }));
    expect(perDay).toHaveValue("40");
    expect(within(sheet).getByRole("textbox", { name: "Monthly budget" })).toHaveAccessibleDescription(/^Saved: \$30\.00\./u);
    expect(within(sheet).getByRole("textbox", { name: "Messages per hour" })).toHaveAccessibleDescription(/^Saved: 15\./u);

    // Re-applying the reviewed draft saves it over the version now shown.
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(reportNotice).toHaveBeenCalledWith("Allowance for Research saved."));
    expect(api.saveGroup).toHaveBeenLastCalledWith("g-research", {
      expectedVersion: 14, messagesPerDay: 40, messagesPerHour: null, monthlyBudgetMicros: 20_000_000
    });
  });

  it("creates a first allowance or override without a version and treats an override created meanwhile as a conflict", async () => {
    api.saveUser.mockResolvedValueOnce({ error: "usage_limits_stale", ok: false });
    await renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit limits for Ada" }));
    const sheet = await screen.findByTestId("admin-usage-user-limits-sheet");
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Messages per day" }), { target: { value: "12" } });
    const adaOverride: AdminUsageUserOverride = { ...unset, exempt: true, userId: "u-ada", version: 30 };
    api.request.mockResolvedValue({
      limits: { ...limits, users: limits.users.map((user) => user.userId === "u-ada" ? { ...user, override: adaOverride } : user) },
      ok: true
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Limits changed in another session");
    expect(api.saveUser).toHaveBeenCalledWith("u-ada", {
      exempt: false, expectedVersion: null, messagesPerDay: 12, messagesPerHour: null, monthlyBudgetMicros: null
    });
    expect(await within(sheet).findByText(/Saved: exempt\./u)).toBeInTheDocument();
    // The override saved meanwhile can be reviewed and removed at its own version.
    api.remove.mockResolvedValueOnce({ limits, ok: true });
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove override" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("u-ada", 30));
  });

  it("shows a failed load as an error with a working retry, not as an empty page", async () => {
    api.request.mockResolvedValueOnce({ error: "usage_limits_action_failed", ok: false });
    render(<AdminUsageLimitsSection reportNotice={reportNotice} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Budgets and limits are unavailable right now.");
    expect(screen.queryByTestId("admin-usage-limits-summary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("admin-usage-limits-summary")).toBeInTheDocument();
  });
});
