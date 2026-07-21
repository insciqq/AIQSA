import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import type { CommandItem } from "./commandItems";

const items: CommandItem[] = [
  {
    current: true,
    id: "action:new-chat",
    kind: "action",
    keywords: ["new"],
    label: "New chat",
    subtitle: "Workspace"
  },
  {
    id: "model:fake:fake-qsa",
    kind: "model",
    keywords: ["fake"],
    label: "Fake QSA",
    subtitle: "fake:fake-qsa"
  }
];

describe("CommandPalette", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the active command visible and restores prior focus on unmount", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
    const trigger = document.createElement("button");
    trigger.textContent = "Open palette";
    document.body.appendChild(trigger);
    trigger.focus();

    const view = render(<CommandPalette items={items} onClose={vi.fn()} onRun={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Command search" });

    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(screen.getByRole("option", { name: /Fake QSA/ })).toHaveAttribute("aria-selected", "true");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("keeps option rows out of the tab order while containing dialog focus", async () => {
    render(<CommandPalette items={items} onClose={vi.fn()} onRun={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Command search" });
    const close = screen.getByRole("button", { name: "Close command palette" });

    await waitFor(() => expect(input).toHaveFocus());
    for (const option of screen.getAllByRole("option")) {
      expect(option).toHaveAttribute("tabindex", "-1");
    }
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(input).toHaveFocus();
  });

  it("groups categories and labels current items without hiding secondary context", () => {
    render(<CommandPalette items={items} onClose={vi.fn()} onRun={vi.fn()} />);

    expect(screen.getByRole("group", { name: "Actions" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Models" })).toBeVisible();

    const current = screen.getByRole("option", { name: /New chat.*Current/ });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current).toHaveTextContent("Action · Workspace");
    expect(screen.getByRole("option", { name: /Fake QSA/ })).toHaveTextContent("Model · fake:fake-qsa");
  });

  it("supports Arrow, Home, End, Enter, and Escape from the search field", async () => {
    const onClose = vi.fn();
    const onRun = vi.fn();
    render(<CommandPalette items={items} onClose={onClose} onRun={onRun} />);
    const input = screen.getByRole("combobox", { name: "Command search" });

    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: "End" });
    expect(screen.getByRole("option", { name: /Fake QSA/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Home" });
    expect(screen.getByRole("option", { name: /New chat/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).toHaveBeenCalledWith(items[1]);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores navigation and selection keys while the search field is composing text", async () => {
    const onClose = vi.fn();
    const onRun = vi.fn();
    render(<CommandPalette items={items} onClose={onClose} onRun={onRun} />);
    const input = screen.getByRole("combobox", { name: "Command search" });

    await waitFor(() => expect(input).toHaveFocus());
    const firstOption = screen.getByRole("option", { name: /New chat/ });
    fireEvent.keyDown(input, { isComposing: true, key: "End" });
    fireEvent.keyDown(input, { isComposing: true, key: "Enter" });
    fireEvent.keyDown(input, { isComposing: true, key: "Escape" });
    fireEvent.keyDown(input, { key: "Process" });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });

    expect(firstOption).toHaveAttribute("aria-selected", "true");
    expect(onRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers an explicit touch-reachable close action", () => {
    const onClose = vi.fn();
    render(<CommandPalette items={items} onClose={onClose} onRun={vi.fn()} />);

    const close = screen.getByRole("button", { name: "Close command palette" });
    expect(close).toHaveClass("size-11", "[@media(hover:none)]:!size-11");

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps DOM focus on the combobox while keyboard navigation selects and runs commands", async () => {
    const onRun = vi.fn();
    render(<CommandPalette items={items} onClose={vi.fn()} onRun={onRun} />);
    const input = screen.getByRole("combobox", { name: "Command search" });

    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: "End" });

    const lastOption = screen.getByRole("option", { name: /Fake QSA/ });
    expect(lastOption).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", lastOption.id);
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).toHaveBeenCalledWith(items[1]);
    expect(input).toHaveFocus();
  });

  it("shows an accessible no-results state and does not execute a stale command", () => {
    const onRun = vi.fn();
    render(<CommandPalette items={items} onClose={vi.fn()} onRun={onRun} />);
    const input = screen.getByRole("combobox", { name: "Command search" });

    fireEvent.change(input, { target: { value: "nothing matches this" } });

    expect(screen.getByRole("status")).toHaveTextContent("No matching commands");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("contains a long list in the viewport, scrolls to End, and wraps long labels", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
    const longItems: CommandItem[] = Array.from({ length: 30 }, (_, index) => ({
      id: `chat:${index}`,
      kind: "chat",
      keywords: [],
      label:
        index === 29
          ? "A very long conversation title that must remain readable on narrow command palette layouts without clipping"
          : `Conversation ${index + 1}`,
      subtitle: index === 29 ? "A deeply nested workspace with a deliberately long descriptive name" : "Workspace"
    }));
    render(<CommandPalette items={longItems} onClose={vi.fn()} onRun={vi.fn()} />);

    const input = screen.getByRole("combobox", { name: "Command search" });
    fireEvent.keyDown(input, { key: "End" });

    const lastOption = screen.getByRole("option", { name: /A very long conversation title/ });
    expect(lastOption).toHaveAttribute("aria-selected", "true");
    expect(lastOption.querySelector("[title^='A very long conversation']")).toHaveClass("[overflow-wrap:anywhere]");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toHaveClass(
      "max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]"
    );
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
  });
});
