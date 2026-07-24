import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMessage } from "./types";
import { DetailedInspector } from "./InspectorPanels";

type InspectorProps = Parameters<typeof DetailedInspector>[0];

function inspectorProps(overrides: Partial<InspectorProps> = {}): InspectorProps {
  return {
    activeLeafId: null,
    activeTab: "branch",
    errorText: null,
    events: [],
    messages: [],
    onActiveTabChange: vi.fn(),
    onClose: vi.fn(),
    onPinToggle: vi.fn(),
    onSelectBranch: vi.fn(),
    pinned: false,
    pinningAvailable: true,
    runId: "run-123456789",
    streaming: false,
    ...overrides
  };
}

function message(
  id: string,
  parentMessageId: string | null,
  role: ThreadMessage["role"],
  content: string
): ThreadMessage {
  return { content, id, parentMessageId, role, status: "complete" };
}

describe("DetailedInspector", () => {
  it("disables branch version rows with explicit guidance while streaming", () => {
    render(
      <DetailedInspector
        {...inspectorProps({
          activeLeafId: "message-1",
          messages: [message("message-1", null, "user", "Question")],
          streaming: true
        })}
      />
    );

    const activeBranch = screen.getByRole("button", { name: "Active branch user 1" });
    expect(activeBranch).toBeDisabled();
    expect(activeBranch.getAttribute("aria-describedby")).toContain("branch-streaming-guidance");
    expect(activeBranch).toHaveAccessibleDescription(/Question\. Question\. Active leaf/);
    expect(screen.getByRole("status")).toHaveTextContent("can’t open another version");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "details-panel-branch");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("tabindex", "0");
    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("shows a simple linear path without manufacturing fork depth", () => {
    render(
      <DetailedInspector
        {...inspectorProps({
          activeLeafId: "answer-1",
          messages: [
            message("question-1", null, "user", "How does a linear path read?"),
            message("answer-1", "question-1", "assistant", "As one calm sequence.")
          ],
          runId: null
        })}
      />
    );

    expect(screen.getByTestId("branch-tree")).toHaveTextContent("2 messages on one linear path");
    expect(screen.getByTestId("branch-tree")).toHaveTextContent("single path");
    expect(screen.getAllByRole("button", { name: /Open this version, branch/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Active branch assistant 2" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Active leaf")).toBeVisible();
    expect(screen.queryByText(/Fork point/)).not.toBeInTheDocument();
  });

  it("makes real forks, role excerpts, active path, leaf, and version opening unambiguous", () => {
    const onSelectBranch = vi.fn();
    render(
      <DetailedInspector
        {...inspectorProps({
          activeLeafId: "answer-b",
          messages: [
            message("question-root", null, "user", "Compare both approaches"),
            message("answer-root", "question-root", "assistant", "Here is the shared answer."),
            message("question-a", "answer-root", "user", "Explore option A"),
            message("answer-a", "question-a", "assistant", "Option A stays independent."),
            message("question-b", "answer-root", "user", "Explore option B"),
            message("answer-b", "question-b", "assistant", "Option B is the active branch.")
          ],
          onSelectBranch
        })}
      />
    );

    expect(screen.getByTestId("branch-tree")).toHaveTextContent("2 paths");
    expect(screen.getByText("Fork point · 2 choices")).toBeVisible();
    expect(screen.getAllByText("Branch path")).toHaveLength(2);
    expect(screen.getAllByText("Question", { selector: "span" })).toHaveLength(3);
    expect(screen.getAllByText("Answer", { selector: "span" })).toHaveLength(3);
    const activeLeaf = screen.getByText("Active leaf").closest("button");
    expect(activeLeaf).toHaveAttribute("aria-current", "true");
    expect(activeLeaf).toHaveAttribute("aria-disabled", "true");
    expect(activeLeaf).toHaveAccessibleDescription(/Answer\. Option B is the active branch\. Active leaf/);
    fireEvent.click(activeLeaf!);
    expect(onSelectBranch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open this version, branch assistant 4" }));
    expect(onSelectBranch).toHaveBeenCalledWith("answer-a");
  });

  it("keeps long event errors readable without truncating the message", () => {
    const longError = `Provider rejected the request: ${"nested/path/".repeat(18)}terminal`;
    render(
      <DetailedInspector
        {...inspectorProps({
          activeTab: "events",
          errorText: longError,
          events: [{ data: { code: "provider_timeout", message: longError }, type: "error" }]
        })}
      />
    );

    const eventError = screen.getAllByText(longError).find((element) => element.tagName === "P");
    expect(eventError).toBeVisible();
    expect(eventError).toHaveClass("[overflow-wrap:anywhere]");
    expect(screen.getByTestId("details-summary")).toHaveClass("max-h-10", "leading-5", "overflow-y-auto");
    expect(screen.getByTestId("details-summary")).toHaveAttribute("title", longError);
    expect(screen.getByTestId("inspector-event-log").querySelector('[data-tone="error"]')).toBeVisible();
  });

  it("exposes clear mode, pin, and close feedback", () => {
    const onClose = vi.fn();
    const onPinToggle = vi.fn();
    const { rerender } = render(
      <DetailedInspector {...inspectorProps({ onClose, onPinToggle })} />
    );

    expect(screen.getByTestId("details-mode-label")).toHaveTextContent("Overlay");
    fireEvent.click(screen.getByRole("button", { name: "Pin details" }));
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(onPinToggle).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<DetailedInspector {...inspectorProps({ onClose, onPinToggle, pinned: true })} />);
    expect(screen.getByTestId("details-mode-label")).toHaveTextContent("Pinned");
    expect(screen.getByRole("button", { name: "Unpin details" })).toHaveAttribute("aria-pressed", "true");
  });
});
