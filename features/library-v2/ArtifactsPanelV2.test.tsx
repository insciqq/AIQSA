import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactsPanelV2 } from "./ArtifactsPanelV2";
import type { ArtifactLibraryItem } from "@/components/app-shell/artifactLibraryStore";

const item: ArtifactLibraryItem = { id: "artifact", title: "A useful quarterly chart", kind: "chart", currentVersionId: "v1", sourceChatId: "chat",
  version: { versionNumber: 1 }, publicationCount: 2, updatedAt: "2026-09-21T08:00:00.000Z" };
function props(overrides: Partial<Parameters<typeof ArtifactsPanelV2>[0]> = {}) {
  return { recent: [item], archived: [], filter: "recent" as const, error: null, loadState: "ready" as const,
    mutations: {}, onChange: vi.fn(async () => undefined), onFilterChange: vi.fn(), onOpen: vi.fn(), onOpenChat: vi.fn(async () => undefined), onRetry: vi.fn(), ...overrides };
}
describe("Library artifacts", () => {
  it("duplicates from the row menu and names the new artifact in its confirmation", async () => {
    const copy = { ...item, id: "copy", title: "Copy of quarterly chart", publicationCount: 0 };
    const value = props({ filter: "published", onChange: vi.fn(async () => copy) });
    render(<ArtifactsPanelV2 {...value} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search artifacts" }), { target: { value: item.title } });
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${item.title}` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(await screen.findByRole("status")).toHaveTextContent(`Duplicated as “${copy.title}”`);
    expect(value.onChange).toHaveBeenCalledWith(item.id, "duplicate");
    expect(value.onFilterChange).toHaveBeenCalledWith("recent");
    expect(screen.getByRole("searchbox", { name: "Search artifacts" })).toHaveValue("");
  });
  it("opens rows and confirms publication-revoking archive with its title", async () => {
    const value = props();
    render(<ArtifactsPanelV2 {...value} />);
    fireEvent.click(screen.getByRole("button", { name: `Open ${item.title}` }));
    expect(value.onOpen).toHaveBeenCalledWith(item);
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${item.title}` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(value.onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(`Archive “${item.title}”? Its 2 published links will be revoked.`);
    fireEvent.click(screen.getByRole("button", { name: "Archive artifact" }));
    await waitFor(() => expect(value.onChange).toHaveBeenCalledWith(item.id, { archived: true }));
    expect(await screen.findByRole("status")).toHaveTextContent("Versions are kept");
  });
  it("keeps a failed rename editable and cancellation restores the row menu focus", async () => {
    const value = props({ onChange: vi.fn(async () => { throw new Error("Could not save the title."); }) });
    render(<ArtifactsPanelV2 {...value} />);
    const trigger = screen.getByRole("button", { name: `Actions for ${item.title}` });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Artifact title" }), { target: { value: "New title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the title.");
    expect(screen.getByRole("textbox", { name: "Artifact title" })).toHaveValue("New title");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Artifact title" }), { key: "Escape" });
    expect(trigger).toHaveFocus();
  });
  it("distinguishes loading, load failure, empty and filtered results", () => {
    const { rerender } = render(<ArtifactsPanelV2 {...props({ recent: null, loadState: "loading" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading artifacts…");
    rerender(<ArtifactsPanelV2 {...props({ recent: null, loadState: "error", error: "The list did not load." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The list did not load.");
    expect(screen.queryByText("No artifacts yet")).not.toBeInTheDocument();
    rerender(<ArtifactsPanelV2 {...props({ recent: [], loadState: "ready" })} />);
    expect(screen.getByText("No artifacts yet")).toBeVisible();
    rerender(<ArtifactsPanelV2 {...props()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search artifacts" }), { target: { value: "missing" } });
    expect(screen.getByText("No artifacts match “missing”.")).toBeVisible();
  });
});
