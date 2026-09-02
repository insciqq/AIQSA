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
    const onKnowledgePlan = vi.fn();
    render(
      <ChatDefaultsRowsV2
        knowledgeBases={[
          { archived: false, description: "", id: "kb-1", name: "Handbook", owned: true },
          { archived: true, description: "", id: "kb-old", name: "Old", owned: true }
        ]}
        knowledgePlan={null}
        mcpMode="auto"
        searchPlan={{ mode: "all_selected", optionIds: ["next-search"] }}
        searchStrategies={strategies}
        onKnowledgePlan={onKnowledgePlan}
        onMcpMode={onMcpMode}
        onSearchPlan={onSearchPlan}
      />
    );
    const search = within(screen.getByRole("radiogroup", { name: "Web search default" }));
    expect(search.getAllByRole("radio")).toHaveLength(3);
    expect(search.getByRole("radio", { name: "Web search" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(search.getByRole("radio", { name: "Off" }));
    expect(onSearchPlan).toHaveBeenCalledWith({ mode: "all_selected", optionIds: [] });
    fireEvent.click(search.getByRole("radio", { name: "Google" }));
    expect(onSearchPlan).toHaveBeenLastCalledWith({ mode: "all_selected", optionIds: ["google"] });

    fireEvent.keyDown(screen.getByRole("radio", { name: "Auto" }), { key: "ArrowRight" });
    expect(onMcpMode).toHaveBeenCalledWith("load_all");

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
    expect(
      within(screen.getByRole("radiogroup", { name: "Web search default" })).getByRole("radio", { name: "Off" })
    ).toHaveAttribute("aria-checked", "true");
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

  it("hides the password row for external-provider-only accounts", async () => {
    accountApi.loadAccountProfile.mockResolvedValue({
      displayName: "Ada", email: "ada@example.com", hasPassword: false, role: "user"
    });
    render(<AccountSettingsRowsV2 accountEmail="ada@example.com" adminEntryVisible={false} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Ada"));
    expect(screen.queryByTestId("settings-password")).toBeNull();
    expect(screen.getByTestId("settings-account-identity")).toHaveTextContent("ada@example.com · Member");
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
