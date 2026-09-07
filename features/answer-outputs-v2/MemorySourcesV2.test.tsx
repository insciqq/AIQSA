import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MemoryAnswerSource } from "@/lib/contracts/memoryClient";
import { submitMemorySourceAction } from "@/components/app-shell/memoryApi";
import { AnswerProcessV2 } from "./AnswerProcessV2";

vi.mock("@/components/app-shell/memoryApi", () => ({ submitMemorySourceAction: vi.fn() }));

function pastChat(group: number, excerpt = 0): MemoryAnswerSource {
  return {
    actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
    chatGroup: `chat-${group}`,
    date: "2026-09-06T10:00:00.000Z",
    memoryRef: `opaque-${group}-${excerpt}`,
    origin: "Same title",
    sourceAvailable: true,
    sourceType: "PAST_CHAT",
    text: `User: Excerpt ${group}.${excerpt}. ` + "A long earlier discussion. ".repeat(20)
  };
}

function visibleGroups() {
  return screen.getAllByTestId("past-chat-source").filter((group) => !group.hidden);
}

describe("compact Personal Context sources", () => {
  it("counts distinct chats, separates facts and keeps detail closed when Steps opens", () => {
    render(<AnswerProcessV2 memorySources={[
      pastChat(1), pastChat(1, 1), pastChat(2), pastChat(3), pastChat(4),
      { actions: ["CORRECT", "FORGET", "NOT_RELEVANT"], date: "2026-09-06T10:00:00.000Z",
        memoryRef: "saved-fact", sourceAvailable: true, sourceType: "SAVED_MEMORY", text: "Use SI units." }
    ]} />);
    const process = screen.getByTestId("tool-activity-disclosure") as HTMLDetailsElement;
    expect(process.querySelector(":scope > summary")).toHaveTextContent("Past chats · 4 · Memory · 1");
    process.open = true;
    const chats = screen.getByTestId("past-chats-disclosure") as HTMLDetailsElement;
    const facts = screen.getByTestId("memories-disclosure") as HTMLDetailsElement;
    expect(chats.open).toBe(false);
    expect(facts.open).toBe(false);
    chats.open = true;
    expect(visibleGroups()).toHaveLength(3);
    expect(screen.getAllByRole("link", { name: "Same title" })).toHaveLength(3);
    for (const action of screen.getAllByRole("button", { name: "Memory actions" })) {
      expect(action).not.toBeVisible();
    }
    fireEvent.click(screen.getByRole("button", { name: "Show all 4" }));
    expect(visibleGroups()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(visibleGroups()).toHaveLength(3);
    const group = screen.getAllByTestId("past-chat-source")[0]!;
    (group.querySelector("details") as HTMLDetailsElement).open = true;
    expect(within(group).getAllByTestId("memory-source-card")).toHaveLength(2);
    const text = group.querySelector(".v2-memory-source-text")!;
    expect(text).not.toHaveAttribute("data-expanded");
    fireEvent.click(within(group).getAllByRole("button", { name: "Details" })[0]!);
    expect(text).toHaveAttribute("data-expanded", "true");
    expect(within(group).getByRole("link", { name: "Same title" })).toHaveAttribute(
      "href", "/api/me/memory/source-actions/open?memoryRef=opaque-1-0"
    );
    expect(facts.open).toBe(false);
  });

  it("keeps forgotten text and navigation removed when Show less and Show all are toggled", async () => {
    vi.mocked(submitMemorySourceAction).mockResolvedValue({ status: "COMMITTED" });
    render(<AnswerProcessV2 memorySources={[pastChat(1), pastChat(2), pastChat(3), pastChat(4)]} />);
    document.querySelectorAll("details").forEach((details) => { details.open = true; });
    fireEvent.click(screen.getByRole("button", { name: "Show all 4" }));
    const group = visibleGroups()[3]!;
    fireEvent.click(within(group).getByRole("button", { name: "Memory actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Forget" }));
    await waitFor(() => expect(within(group).getByRole("status")).toHaveTextContent("forgotten"));
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(group).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show all 4" }));
    expect(group).toBeVisible();
    expect(group.querySelector(".v2-past-chat-preview")).toBeNull();
    expect(within(group).queryByRole("link", { name: "Same title" })).not.toBeInTheDocument();
    expect(group).not.toHaveTextContent("A long earlier discussion.");
  });

  it("keeps unavailable history private and renders no empty disclosure", () => {
    const { rerender } = render(<AnswerProcessV2 memorySources={[{
      actions: [], chatGroup: "chat-1", date: "2026-09-06T10:00:00.000Z",
      sourceAvailable: false, sourceType: "PAST_CHAT"
    }]} />);
    document.querySelectorAll("details").forEach((details) => { details.open = true; });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Memory actions" })).not.toBeInTheDocument();
    rerender(<AnswerProcessV2 memorySources={[]} />);
    expect(screen.queryByTestId("tool-activity-disclosure")).not.toBeInTheDocument();
  });
});
