import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  InspectorTabs,
  inspectorPanelId,
  inspectorTabId,
  inspectorTabs,
  type InspectorTabId
} from "./InspectorTabs";

describe("InspectorTabs", () => {
  it("exposes one controlled tab stop with stable tab and panel relationships", () => {
    const onTabChange = vi.fn();

    const { rerender } = render(<InspectorTabs activeTab="branch" onTabChange={onTabChange} />);

    expect(screen.getByRole("tablist", { name: "Details tabs" })).toHaveAttribute("aria-orientation", "horizontal");
    const branchTab = screen.getByRole("tab", { name: "Branch" });
    expect(branchTab).toHaveAttribute("aria-selected", "true");
    expect(branchTab).toHaveAttribute("tabindex", "0");
    expect(branchTab).toHaveClass("focus-visible:ring-2", "focus-visible:ring-focus");
    expect(branchTab).toHaveClass("text-ink", "after:bg-proof");

    for (const tab of inspectorTabs) {
      const element = screen.getByRole("tab", { name: tab.label });
      expect(element).toHaveAttribute("id", inspectorTabId(tab.id));
      expect(element).toHaveAttribute("aria-controls", inspectorPanelId(tab.id));
      expect(element).toHaveAttribute("aria-selected", String(tab.id === "branch"));
      expect(element).toHaveAttribute("tabindex", tab.id === "branch" ? "0" : "-1");
    }

    expect(screen.queryByRole("tab", { name: "Prompt" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(onTabChange).toHaveBeenCalledWith("events");

    rerender(<InspectorTabs activeTab="events" onTabChange={onTabChange} />);
    expect(branchTab).toHaveAttribute("aria-selected", "false");
    expect(branchTab).toHaveAttribute("tabindex", "-1");
    expect(branchTab).toHaveClass("text-ink-muted", "hover:text-ink");
    expect(screen.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Events" })).toHaveAttribute("tabindex", "0");
  });

  it("moves focus and requests selection with Arrow, Home, End, and wraparound keys", () => {
    const onTabChange = vi.fn();

    render(<InspectorTabs activeTab="events" onTabChange={onTabChange} />);

    const branchTab = screen.getByRole("tab", { name: "Branch" });
    const eventsTab = screen.getByRole("tab", { name: "Events" });
    eventsTab.focus();
    fireEvent.keyDown(eventsTab, { key: "ArrowRight" });
    expect(onTabChange).toHaveBeenLastCalledWith("branch");
    expect(branchTab).toHaveFocus();

    fireEvent.keyDown(branchTab, { key: "ArrowLeft" });
    expect(onTabChange).toHaveBeenLastCalledWith("events");
    expect(eventsTab).toHaveFocus();

    fireEvent.keyDown(eventsTab, { key: "Home" });
    expect(onTabChange).toHaveBeenLastCalledWith("branch");
    expect(branchTab).toHaveFocus();

    fireEvent.keyDown(branchTab, { key: "End" });
    expect(onTabChange).toHaveBeenLastCalledWith("events");
    expect(eventsTab).toHaveFocus();

    fireEvent.keyDown(eventsTab, { key: "ArrowDown" });
    expect(onTabChange).toHaveBeenLastCalledWith("branch");
    expect(branchTab).toHaveFocus();

    fireEvent.keyDown(branchTab, { key: "ArrowUp" });
    expect(onTabChange).toHaveBeenLastCalledWith("events");
    expect(eventsTab).toHaveFocus();

    const callCount = onTabChange.mock.calls.length;
    fireEvent.keyDown(eventsTab, { key: "PageDown" });
    expect(onTabChange).toHaveBeenCalledTimes(callCount);
    expect(eventsTab).toHaveFocus();
  });

  it.each<InspectorTabId>(["branch", "events"])("keeps %s selection controlled across rerenders", (activeTab) => {
    const onTabChange = vi.fn();
    const { rerender } = render(<InspectorTabs activeTab={activeTab} onTabChange={onTabChange} />);

    for (const tab of inspectorTabs) {
      const element = screen.getByRole("tab", { name: tab.label });
      expect(element).toHaveAttribute("aria-selected", String(tab.id === activeTab));
      expect(element).toHaveAttribute("tabindex", tab.id === activeTab ? "0" : "-1");
    }

    rerender(<InspectorTabs activeTab={activeTab} onTabChange={onTabChange} />);
    expect(onTabChange).not.toHaveBeenCalled();
  });
});
