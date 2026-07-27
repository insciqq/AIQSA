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
  it("disables only a real alternate version with explicit guidance while streaming", () => {
    render(
      <DetailedInspector
        {...inspectorProps({
          activeLeafId: "answer-a",
          messages: [
            message("question-1", null, "user", "Question"),
            message("answer-a", "question-1", "assistant", "Current answer"),
            message("answer-b", "question-1", "assistant", "Alternate answer")
          ],
          streaming: true
        })}
      />
    );

    const alternateVersion = screen.getByRole("button", { name: "Open alternate version, assistant 3" });
    expect(alternateVersion).toBeDisabled();
    expect(alternateVersion.getAttribute("aria-describedby")).toContain("branch-streaming-guidance");
    expect(alternateVersion).toHaveAccessibleDescription(/Answer\. Alternate answer\. Open this alternate version/);
    expect(screen.getByRole("status")).toHaveTextContent("cannot be opened");
    expect(screen.queryByRole("button", { name: /current/i })).not.toBeInTheDocument();
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

    expect(screen.getByTestId("branch-tree")).toHaveTextContent("2 messages · one version");
    expect(screen.getByTestId("branch-tree")).toHaveTextContent("one version");
    expect(screen.queryByRole("button", { name: /Open alternate version/ })).not.toBeInTheDocument();
    expect(screen.getByText("Current").closest("div[data-active-leaf='true']")).toHaveAttribute(
      "aria-current",
      "true"
    );
    expect(screen.queryByText(/Fork point/)).not.toBeInTheDocument();
  });

  it("guides an empty conversation without presenting a fabricated branch", () => {
    render(<DetailedInspector {...inspectorProps({ messages: [], runId: null })} />);

    expect(screen.getByTestId("branch-tree")).toHaveTextContent("No conversation yet");
    expect(screen.getByTestId("branch-tree")).toHaveTextContent("Ask a question to create the first version");
    expect(screen.queryByRole("button", { name: /Open alternate version/ })).not.toBeInTheDocument();
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

    expect(screen.getByTestId("branch-tree")).toHaveTextContent("2 versions");
    expect(screen.getByText("Fork point · 2 choices")).toBeVisible();
    expect(screen.getAllByText("Branch version")).toHaveLength(2);
    expect(screen.getAllByText("Question", { selector: "span" })).toHaveLength(3);
    expect(screen.getAllByText("Answer", { selector: "span" })).toHaveLength(3);
    const activeLeaf = screen.getByText("Current").closest("div[data-active-leaf='true']");
    expect(activeLeaf).toHaveAttribute("aria-current", "true");
    fireEvent.click(activeLeaf!);
    expect(onSelectBranch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open alternate version, assistant 4" }));
    expect(onSelectBranch).toHaveBeenCalledWith("answer-a");
  });

  it("reports a first-message edit as two versions with checkout to the original branch leaf", () => {
    const onSelectBranch = vi.fn();
    render(
      <DetailedInspector
        {...inspectorProps({
          activeLeafId: "answer-edited",
          messages: [
            message("question-original", null, "user", "Original question"),
            message("answer-original", "question-original", "assistant", "Original answer"),
            message("question-edited", null, "user", "Edited question"),
            message("answer-edited", "question-edited", "assistant", "Edited answer")
          ],
          onSelectBranch
        })}
      />
    );

    expect(screen.getByTestId("branch-tree")).toHaveTextContent(
      "2 versions · 2 messages in the current version"
    );
    expect(screen.queryByText(/one version/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Open version")).toHaveLength(2);
    expect(screen.getAllByText("Current path")).toHaveLength(1);
    expect(screen.getAllByText("Branch version")).toHaveLength(2);
    expect(screen.getAllByText("Current")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Open alternate version, user 1" }));
    expect(onSelectBranch).toHaveBeenCalledWith("answer-original");
  });

  it("uses the singular message count for a one-message version", () => {
    render(
      <DetailedInspector
        {...inspectorProps({
          activeLeafId: "question-only",
          messages: [message("question-only", null, "user", "Just asked")],
          runId: null
        })}
      />
    );

    expect(screen.getByTestId("branch-tree")).toHaveTextContent("1 message · one version");
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
    expect(screen.getByText("Question", { selector: "div" })).toHaveClass("text-ink-secondary");
    expect(screen.queryByTestId("details-mode-label")).not.toBeInTheDocument();
  });

  it("exposes clear mode, pin, and close feedback", () => {
    const onClose = vi.fn();
    const onPinToggle = vi.fn();
    const { rerender } = render(
      <DetailedInspector {...inspectorProps({ onClose, onPinToggle })} />
    );

    expect(screen.queryByTestId("details-mode-label")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pin details" }));
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(onPinToggle).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<DetailedInspector {...inspectorProps({ onClose, onPinToggle, pinned: true })} />);
    expect(screen.getByTestId("details-mode-label")).toHaveTextContent("Pinned beside chat");
    expect(screen.getByRole("button", { name: "Unpin details" })).toHaveAttribute("aria-pressed", "true");
  });

  it("uses factual readable run context without inventing events or exposing an internal run id", () => {
    render(<DetailedInspector {...inspectorProps({ runId: "run-internal-123456789" })} />);

    expect(screen.getByTestId("details-summary")).toHaveTextContent("This run was recorded without events");
    expect(screen.getByTestId("details-summary")).not.toHaveTextContent("run-internal");
  });

  it("claims run events only when an event is actually present", () => {
    const { rerender } = render(
      <DetailedInspector
        {...inspectorProps({
          activeTab: "events",
          events: [{ data: { totalTokens: 20 }, type: "usage" }]
        })}
      />
    );

    expect(screen.getByTestId("details-summary")).toHaveTextContent("1 recorded event for this run");

    rerender(<DetailedInspector {...inspectorProps({ activeTab: "events", streaming: true })} />);
    expect(screen.getByTestId("details-summary")).toHaveTextContent("The run is active");
    expect(screen.getByTestId("details-summary")).toHaveTextContent("No events have arrived yet");
  });

  it("keeps the inspection plane and local scroller bounded for compact and short viewports", () => {
    render(<DetailedInspector {...inspectorProps()} />);

    expect(screen.getByTestId("details-content")).toHaveClass(
      "overflow-hidden",
      "bg-overlay-surface",
      "text-ink"
    );
    expect(screen.getByRole("tabpanel")).toHaveClass(
      "overflow-x-hidden",
      "overflow-y-auto",
      "[@media(max-height:32rem)]:py-3"
    );
    expect(screen.getByRole("button", { name: "Close details" })).toHaveClass(
      "[@media(hover:none)]:!size-11",
      "[@media(pointer:coarse)]:!size-11"
    );
  });
});
