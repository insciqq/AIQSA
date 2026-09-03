import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { UiV2RovingTree } from "./RovingTreeV2";

function TreeHarness({ onMenu = vi.fn() }: { onMenu?(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <UiV2RovingTree label="Chats">
      <div data-v2-tree-row="true">
        <button
          aria-expanded={open}
          aria-level={1}
          aria-selected="false"
          data-v2-tree-item="true"
          role="treeitem"
          tabIndex={-1}
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          Folder
        </button>
        <button
          aria-label="Folder actions"
          data-v2-row-menu-trigger="true"
          tabIndex={-1}
          type="button"
          onClick={onMenu}
        />
      </div>
      {open ? (
        <div role="group">
          <button
            aria-level={2}
            aria-selected="false"
            data-v2-tree-item="true"
            role="treeitem"
            tabIndex={-1}
            type="button"
          >
            Child chat
          </button>
        </div>
      ) : null}
      <button
        aria-current="page"
        aria-level={1}
        aria-selected="true"
        data-v2-tree-item="true"
        role="treeitem"
        tabIndex={-1}
        type="button"
      >
        Current chat
      </button>
    </UiV2RovingTree>
  );
}

describe("UiV2RovingTree", () => {
  it("keeps one Tab stop and supports Arrow, Home, and End navigation", () => {
    render(<TreeHarness />);
    const tree = screen.getByRole("tree", { name: "Chats" });
    const folder = within(tree).getByRole("treeitem", { name: "Folder" });
    const current = within(tree).getByRole("treeitem", { name: "Current chat" });

    expect(within(tree).getAllByRole("treeitem").filter((item) => item.tabIndex === 0))
      .toEqual([current]);
    current.focus();
    fireEvent.keyDown(current, { key: "ArrowUp" });
    expect(folder).toHaveFocus();
    fireEvent.keyDown(folder, { key: "End" });
    expect(current).toHaveFocus();
    fireEvent.keyDown(current, { key: "Home" });
    expect(folder).toHaveFocus();
    fireEvent.keyDown(folder, { key: "ArrowDown" });
    expect(current).toHaveFocus();
  });

  it("expands, enters, leaves, and collapses folder branches", () => {
    render(<TreeHarness />);
    const folder = screen.getByRole("treeitem", { name: "Folder" });
    folder.focus();

    fireEvent.keyDown(folder, { key: "ArrowRight" });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    const child = screen.getByRole("treeitem", { name: "Child chat" });
    fireEvent.keyDown(folder, { key: "ArrowRight" });
    expect(child).toHaveFocus();
    fireEvent.keyDown(child, { key: "ArrowLeft" });
    expect(folder).toHaveFocus();
    fireEvent.keyDown(folder, { key: "ArrowLeft" });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "Child chat" })).toBeNull();
  });

  it("routes Shift+F10 and the Context Menu key to the focused row action", () => {
    const onMenu = vi.fn();
    render(<TreeHarness onMenu={onMenu} />);
    const folder = screen.getByRole("treeitem", { name: "Folder" });
    folder.focus();

    expect(fireEvent.contextMenu(folder)).toBe(false);
    fireEvent.keyDown(folder, { key: "F10", shiftKey: true });
    fireEvent.keyDown(folder, { key: "ContextMenu" });

    expect(onMenu).toHaveBeenCalledTimes(2);
  });
});
