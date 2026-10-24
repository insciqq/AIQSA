import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSettingsRowsV2 } from "./AccountSettingsRowsV2";
import { ChatDefaultsRowsV2 } from "./ChatDefaultsRowsV2";
import { DataSettingsRowsV2, deleteAllSummary } from "./DataSettingsRowsV2";

const accountApi = vi.hoisted(() => ({
  changeAccountPassword: vi.fn(),
  loadAccountProfile: vi.fn(),
  // The two-factor row has its own tests; here it stays out of the way.
  loadTwoFactorStatus: vi.fn(() => new Promise(() => undefined)),
  updateAccountDisplayName: vi.fn()
}));

vi.mock("@/components/app-shell/accountApi", () => ({
  ACCOUNT_EXPORT_ALL_CHATS_HREF: "/api/me/chats/export",
  ...accountApi
}));

const strategies = [
  { displayName: "Off", kind: "none" as const, strategyId: "search-disabled" },
  { displayName: "Web search", kind: "web_search" as const, strategyId: "next-search" },
  { displayName: "Google", kind: "gemini_google_search" as const, strategyId: "google" }
];

describe("ChatDefaultsRowsV2", () => {
  it("persists the search sources and MCP and Skills modes", () => {
    const onSearchPlan = vi.fn();
    const onMcpMode = vi.fn();
    const onSkillsMode = vi.fn();
    render(
      <ChatDefaultsRowsV2
        mcpMode="auto"
        searchPlan={{ mode: "all_selected", optionIds: ["next-search"] }}
        searchStrategies={strategies}
        onMcpMode={onMcpMode}
        onSkillsMode={onSkillsMode}
        onSearchPlan={onSearchPlan}
      />
    );
    expect(screen.getByTestId("settings-default-search")).toHaveTextContent("Sources the model uses to search the web in every chat.");
    const search = screen.getByLabelText("Web search default");
    expect(search).toHaveTextContent("Web search");
    fireEvent.click(search);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.queryByRole("combobox")).toBeNull();
    // The last source is never unchecked here; turning off is its own action.
    expect(screen.getByRole("checkbox", { name: "Web search" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Google" }));
    expect(onSearchPlan).toHaveBeenLastCalledWith({ mode: "all_selected", optionIds: ["next-search", "google"] });

    fireEvent.keyDown(within(screen.getByRole("radiogroup", { name: "MCP tools default" })).getByRole("radio", { name: "Auto" }), { key: "ArrowRight" });
    expect(onMcpMode).toHaveBeenCalledWith("load_all");
    fireEvent.keyDown(within(screen.getByRole("radiogroup", { name: "Skills default" })).getByRole("radio", { name: "Auto" }), { key: "ArrowRight" });
    expect(onSkillsMode).toHaveBeenCalledWith("off");
    expect(screen.queryByRole("button", { name: "Knowledge default" })).toBeNull();
    expect(screen.queryByTestId("settings-default-knowledge")).toBeNull();
  });

  it("turns web search off only after a confirmation that names the cost", () => {
    const onSearchPlan = vi.fn();
    render(
      <ChatDefaultsRowsV2
        mcpMode="auto"
        searchPlan={{ mode: "all_selected", optionIds: ["next-search", "google"] }}
        searchStrategies={strategies}
        onMcpMode={vi.fn()}
        onSearchPlan={onSearchPlan}
      />
    );
    expect(screen.getByLabelText("Web search default")).toHaveTextContent("Web search, Google");
    fireEvent.click(screen.getByLabelText("Web search default"));
    fireEvent.click(screen.getByRole("button", { name: "Turn off web search" }));
    let dialog = screen.getByRole("dialog", { name: "Turn off web search" });
    expect(dialog).toHaveTextContent("Turn off web search?");
    expect(dialog).toHaveTextContent("The model will answer only from what it already knows and won't be able to check current facts. Answers will get worse.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep search on" }));
    expect(screen.queryByRole("dialog", { name: "Turn off web search" })).toBeNull();
    expect(onSearchPlan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Turn off web search" }));
    dialog = screen.getByRole("dialog", { name: "Turn off web search" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm turn off" }));
    expect(onSearchPlan).toHaveBeenCalledOnce();
    expect(onSearchPlan).toHaveBeenCalledWith({ mode: "all_selected", optionIds: [] });
  });

  it("offers the organization default only for a personal choice", () => {
    const onResetSearchPlan = vi.fn();
    const { rerender } = render(
      <ChatDefaultsRowsV2 mcpMode="auto" searchPlan={{ mode: "all_selected", optionIds: ["google"] }} searchStrategies={strategies}
        searchPreferenceSource="personal" onResetSearchPlan={onResetSearchPlan} onMcpMode={vi.fn()} onSearchPlan={vi.fn()} />
    );
    fireEvent.click(screen.getByLabelText("Web search default"));
    fireEvent.click(screen.getByRole("button", { name: "Use organization default" }));
    expect(onResetSearchPlan).toHaveBeenCalledOnce();
    rerender(
      <ChatDefaultsRowsV2 mcpMode="auto" searchPlan={{ mode: "all_selected", optionIds: ["google"] }} searchStrategies={strategies}
        searchPreferenceSource="organization" onResetSearchPlan={onResetSearchPlan} onMcpMode={vi.fn()} onSearchPlan={vi.fn()} />
    );
    expect(screen.getByLabelText("Web search default")).toHaveTextContent("Organization default · Google");
    expect(screen.queryByRole("button", { name: "Use organization default" })).toBeNull();
  });

  it("shows saved Off defaults as they are and turns search on by checking a source", () => {
    const onSearchPlan = vi.fn();
    render(
      <ChatDefaultsRowsV2
        mcpMode="off"
        searchPlan={{ mode: "all_selected", optionIds: [] }}
        searchStrategies={strategies}
        onMcpMode={vi.fn()}
        onSearchPlan={onSearchPlan}
      />
    );
    expect(screen.getByLabelText("Web search default")).toHaveTextContent("Off");
    expect(screen.queryByRole("button", { name: "Turn off web search" })).toBeNull();
    expect(
      within(screen.getByRole("radiogroup", { name: "MCP tools default" })).getByRole("radio", { name: "Off" })
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByLabelText("Web search default"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Google" }));
    expect(onSearchPlan).toHaveBeenCalledWith({ mode: "all_selected", optionIds: ["google"] });
  });
});

describe("DataSettingsRowsV2", () => {
  it("deletes only after the consequence-naming confirmation and reports the outcome", async () => {
    const onDeleteAll = vi.fn().mockResolvedValue({
      archived: 3,
      permanentDeletionAvailable: true,
      scheduled: 3,
      skipped: 1
    });
    const onDeleted = vi.fn();
    render(<DataSettingsRowsV2 accountId="account-1" onDeleteAll={onDeleteAll} onDeleted={onDeleted} />);
    expect(screen.getByRole("link", { name: "Export…" })).toHaveAttribute("href", "/api/me/chats/export");
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete all personal chats" });
    expect(dialog).toHaveTextContent("scheduled for permanent deletion");
    expect(onDeleteAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my chats" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all personal chats" }));
    expect(onDeleteAll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(screen.getByTestId("settings-delete-all")).toHaveTextContent(
      "3 chats archived and scheduled for permanent deletion · 1 skipped (active run or temporary chat)."
    );
  });

  it("names the archive-only outcome when permanent deletion is dark", () => {
    expect(deleteAllSummary({ archived: 1, permanentDeletionAvailable: false, scheduled: 0, skipped: 0 })).toBe(
      "1 chat archived; permanent deletion is not available on this installation."
    );
  });
});

const noUsageLimits = {
  installationExhausted: false,
  messages: { dayFreesAt: null, hourFreesAt: null, lastDay: 0, lastHour: 0, perDay: null, perHour: null },
  monthlyBudgetMicros: null,
  monthSpentMicros: 0,
  periodStart: "2026-10-01T00:00:00.000Z",
  resetsAt: "2026-11-01T00:00:00.000Z"
};

describe("AccountSettingsRowsV2", () => {
  beforeEach(() => {
    accountApi.loadAccountProfile.mockReset();
    accountApi.updateAccountDisplayName.mockReset();
    accountApi.changeAccountPassword.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ usageLimits: noUsageLimits })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds the user's own usage limits only when one applies", async () => {
    accountApi.loadAccountProfile.mockResolvedValue({
      displayName: "Ada", email: "ada@example.com", hasPassword: false, role: "user"
    });
    const view = render(<AccountSettingsRowsV2 accountEmail="ada@example.com" adminEntryVisible={false} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/me/usage-limits", expect.objectContaining({ cache: "no-store" })));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Ada"));
    expect(screen.queryByRole("region", { name: "Usage limits" })).toBeNull();
    view.unmount();

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      usageLimits: { ...noUsageLimits, monthlyBudgetMicros: 10_000_000, monthSpentMicros: 3_200_000 }
    })));
    render(<AccountSettingsRowsV2 accountEmail="ada@example.com" adminEntryVisible={false} />);
    expect(await screen.findByRole("region", { name: "Usage limits" })).toHaveTextContent("≈ $3.20 of $10.00");
  });

  it("publishes only server-confirmed display names, including normalized saves and empty profiles", async () => {
    const profile = { displayName: "", email: "owner@example.test", hasPassword: false, role: "user" };
    accountApi.loadAccountProfile.mockResolvedValue(profile);
    let finish!: (value: typeof profile) => void;
    accountApi.updateAccountDisplayName.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onDisplayNameChange = vi.fn();
    render(<AccountSettingsRowsV2 accountEmail={profile.email} adminEntryVisible={false}
      onDisplayNameChange={onDisplayNameChange} />);
    const name = screen.getByRole("textbox", { name: "Display name" });
    await waitFor(() => expect(name).toBeEnabled());
    expect(onDisplayNameChange.mock.calls).toEqual([[""]]);
    fireEvent.change(name, { target: { value: "  Ada   Lovelace  " } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onDisplayNameChange).toHaveBeenCalledTimes(1);
    expect(name).toBeDisabled();
    await act(async () => { finish({ ...profile, displayName: "Ada Lovelace" }); });
    expect(onDisplayNameChange.mock.calls).toEqual([[""], ["Ada Lovelace"]]);
    expect(name).toHaveValue("Ada Lovelace");
    expect(screen.getByTestId("settings-account-identity")).toHaveTextContent("Ada Lovelace");
  });

  it("keeps the committed identity and editable draft after a rejected save", async () => {
    accountApi.loadAccountProfile.mockResolvedValue({
      displayName: "Ada Lovelace", email: "owner@example.test", hasPassword: false, role: "user"
    });
    accountApi.updateAccountDisplayName.mockRejectedValue(new Error("display_name_invalid"));
    const onDisplayNameChange = vi.fn();
    render(<AccountSettingsRowsV2 accountEmail="owner@example.test" adminEntryVisible={false}
      onDisplayNameChange={onDisplayNameChange} />);
    const name = screen.getByRole("textbox", { name: "Display name" });
    await waitFor(() => expect(name).toHaveValue("Ada Lovelace"));
    fireEvent.change(name, { target: { value: "   " } });
    expect(onDisplayNameChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(name).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("display_name_invalid");
    expect(name).toHaveValue("   ");
    expect(onDisplayNameChange.mock.calls).toEqual([["Ada Lovelace"]]);
    expect(screen.getByTestId("settings-account-identity")).toHaveTextContent("Ada Lovelace");
  });

  it.each(["load", "save"])("does not publish a previous account's late %s after the keyed panel changes", async phase => {
    const previous = { displayName: "Ada Lovelace", email: "ada@example.test", hasPassword: false, role: "user" };
    const current = { ...previous, displayName: "Grace Hopper", email: "grace@example.test" };
    let finish!: (value: typeof previous) => void;
    const pending = new Promise<typeof previous>(resolve => { finish = resolve; });
    accountApi.loadAccountProfile.mockResolvedValueOnce(phase === "load" ? pending : previous)
      .mockResolvedValueOnce(current);
    accountApi.updateAccountDisplayName.mockReturnValue(pending);
    const onDisplayNameChange = vi.fn();
    const { rerender } = render(<AccountSettingsRowsV2 key="previous" accountEmail={previous.email}
      adminEntryVisible={false} onDisplayNameChange={onDisplayNameChange} />);
    if (phase === "save") {
      const name = screen.getByRole("textbox", { name: "Display name" });
      await waitFor(() => expect(name).toHaveValue(previous.displayName));
      fireEvent.change(name, { target: { value: "Late name" } });
      fireEvent.keyDown(name, { key: "Enter" });
    }
    rerender(<AccountSettingsRowsV2 key="current" accountEmail={current.email}
      adminEntryVisible={false} onDisplayNameChange={onDisplayNameChange} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(current.displayName));
    onDisplayNameChange.mockClear();
    await act(async () => { finish({ ...previous, displayName: "Late name" }); });
    expect(onDisplayNameChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-account-identity")).toHaveTextContent(current.displayName);
  });

  it("hides the password row for external-provider-only accounts", async () => {
    accountApi.loadAccountProfile.mockResolvedValue({
      displayName: "Ada", email: "ada@example.com", hasPassword: false, role: "user"
    });
    render(<AccountSettingsRowsV2 accountEmail="ada@example.com" adminEntryVisible={false} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Ada"));
    expect(screen.queryByTestId("settings-password")).toBeNull();
    expect(screen.getByTestId("settings-account-identity")).toHaveTextContent("ada@example.com · Member");
  });

  it("reports reverted drafts as clean and keeps a password request busy until it settles", async () => {
    accountApi.loadAccountProfile.mockResolvedValue({
      displayName: "Ada", email: "ada@example.com", hasPassword: true, role: "user"
    });
    let finish!: () => void;
    accountApi.changeAccountPassword.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const onDirtyChange = vi.fn();
    const onBusyChange = vi.fn();
    render(<AccountSettingsRowsV2 accountEmail="ada@example.com" adminEntryVisible={false}
      onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} />);
    const name = screen.getByRole("textbox", { name: "Display name" });
    await waitFor(() => expect(name).toHaveValue("Ada"));
    fireEvent.change(name, { target: { value: "Grace" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(name, { target: { value: "Ada" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "synthetic-current" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "synthetic-current" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "synthetic-next" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "synthetic-next" } });
    fireEvent.submit(screen.getByTestId("settings-password-form"));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByLabelText("Current password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => { finish(); });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("saves the display name on Enter and changes the password only when both entries match", async () => {
    accountApi.loadAccountProfile.mockResolvedValue({
      displayName: "Ada", email: "ada@example.com", hasPassword: true, role: "admin"
    });
    accountApi.updateAccountDisplayName.mockResolvedValue({
      displayName: "Ada L.", email: "ada@example.com", hasPassword: true, role: "admin"
    });
    accountApi.changeAccountPassword.mockResolvedValue(undefined);
    render(<AccountSettingsRowsV2 accountEmail="ada@example.com" adminEntryVisible />);
    const name = await screen.findByRole("textbox", { name: "Display name" });
    fireEvent.change(name, { target: { value: "Ada L." } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(accountApi.updateAccountDisplayName).toHaveBeenCalledWith("Ada L."));
    await waitFor(() => expect(screen.getByTestId("settings-account-identity")).toHaveTextContent("Ada L."));

    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    const form = screen.getByTestId("settings-password-form");
    const fill = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fill("Current password", "current-secret-1");
    fill("New password", "next-secret-22");
    fill("Confirm new password", "next-secret-23");
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(accountApi.changeAccountPassword).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("do not match");
    fill("Confirm new password", "next-secret-22");
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(accountApi.changeAccountPassword).toHaveBeenCalledWith({
      currentPassword: "current-secret-1",
      newPassword: "next-secret-22"
    });
    await waitFor(() => expect(screen.getByTestId("settings-password")).toHaveTextContent("Other sessions were signed out"));
  });
});
