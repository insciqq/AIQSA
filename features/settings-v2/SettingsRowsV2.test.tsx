import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { explicitKnowledgeSelection } from "@/lib/contracts/knowledge";
import { AccountSettingsRowsV2 } from "./AccountSettingsRowsV2";
import { ChatDefaultsRowsV2 } from "./ChatDefaultsRowsV2";
import { DataSettingsRowsV2, deleteAllSummary } from "./DataSettingsRowsV2";

const accountApi = vi.hoisted(() => ({
  changeAccountPassword: vi.fn(),
  loadAccountProfile: vi.fn(),
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
  it("persists the search engine, MCP mode and knowledge default without touching the composer", () => {
    const onSearchPlan = vi.fn();
    const onMcpMode = vi.fn();
    const onSkillsMode = vi.fn();
    const onKnowledgePlan = vi.fn();
    render(
      <ChatDefaultsRowsV2
        knowledgeBases={[
          {
            archived: false,
            description: "",
            documentCount: 1,
            id: "kb-1",
            name: "Handbook",
            owned: true,
            readinessState: "ready"
          },
          {
            archived: true,
            description: "",
            documentCount: 1,
            id: "kb-old",
            name: "Old",
            owned: true,
            readinessState: "archived"
          }
        ]}
        knowledgePlan={null}
        mcpMode="auto"
        searchPlan={{ mode: "all_selected", optionIds: ["next-search"] }}
        searchStrategies={strategies}
        onKnowledgePlan={onKnowledgePlan}
        onMcpMode={onMcpMode}
        onSkillsMode={onSkillsMode}
        onSearchPlan={onSearchPlan}
      />
    );
    const search = screen.getByLabelText("Web search default");
    expect(search).toHaveTextContent("1 source selected");
    fireEvent.click(search);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Turn off search" }));
    expect(onSearchPlan).toHaveBeenCalledWith({ mode: "all_selected", optionIds: [] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Google" }));
    expect(onSearchPlan).toHaveBeenLastCalledWith({ mode: "all_selected", optionIds: ["next-search", "google"] });

    fireEvent.keyDown(within(screen.getByRole("radiogroup", { name: "MCP tools default" })).getByRole("radio", { name: "Auto" }), { key: "ArrowRight" });
    expect(onMcpMode).toHaveBeenCalledWith("load_all");
    fireEvent.keyDown(within(screen.getByRole("radiogroup", { name: "Skills default" })).getByRole("radio", { name: "Auto" }), { key: "ArrowRight" });
    expect(onSkillsMode).toHaveBeenCalledWith("off");

    // The Knowledge default is a Signal select: a menu trigger showing the
    // current choice, options as menu items.
    const knowledge = screen.getByRole("button", { name: "Knowledge default" });
    expect(knowledge).toHaveTextContent("None");
    fireEvent.click(knowledge);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "None",
      "All my knowledge",
      "Handbook"
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Handbook" }));
    expect(onKnowledgePlan).toHaveBeenCalledWith(explicitKnowledgeSelection({ baseIds: ["kb-1"] }));
    fireEvent.click(knowledge);
    fireEvent.click(screen.getByRole("menuitem", { name: "All my knowledge" }));
    expect(onKnowledgePlan).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "all_my_knowledge" }));
    fireEvent.click(knowledge);
    fireEvent.click(screen.getByRole("menuitem", { name: "None" }));
    expect(onKnowledgePlan).toHaveBeenLastCalledWith(null);
  });

  it("keeps an unavailable saved base visible instead of silently switching", () => {
    render(
      <ChatDefaultsRowsV2
        knowledgeBases={[]}
        knowledgePlan={explicitKnowledgeSelection({ baseIds: ["kb-gone"] })}
        mcpMode="off"
        searchPlan={{ mode: "all_selected", optionIds: [] }}
        searchStrategies={strategies}
        onKnowledgePlan={vi.fn()}
        onMcpMode={vi.fn()}
        onSearchPlan={vi.fn()}
      />
    );
    const knowledge = screen.getByRole("button", { name: "Knowledge default" });
    expect(knowledge).toHaveTextContent("Unavailable base");
    fireEvent.click(knowledge);
    expect(screen.getByRole("menuitem", { name: "Unavailable base" })).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(screen.getByRole("menu", { name: "Knowledge default" }), { key: "Escape" });
    expect(screen.getByLabelText("Web search default")).toHaveTextContent("Off");
    expect(
      within(screen.getByRole("radiogroup", { name: "MCP tools default" })).getByRole("radio", { name: "Off" })
    ).toHaveAttribute("aria-checked", "true");
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
    render(<DataSettingsRowsV2 onDeleteAll={onDeleteAll} onDeleted={onDeleted} />);
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

describe("AccountSettingsRowsV2", () => {
  beforeEach(() => {
    accountApi.loadAccountProfile.mockReset();
    accountApi.updateAccountDisplayName.mockReset();
    accountApi.changeAccountPassword.mockReset();
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
