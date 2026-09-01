import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  RunAnswerV2,
  RunComposerActionV2,
  RunLifecycleAnnouncerV2
} from "./RunLifecycleV2";
import {
  settledRunPresentationV2,
  type RunPresentationV2
} from "./runPresentation";
import { MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE } from "@/lib/contracts/runs";

function presentation(
  overrides: Partial<RunPresentationV2> = {}
): RunPresentationV2 {
  return {
    kind: "idle",
    runId: null,
    ...overrides
  };
}

describe("Run lifecycle v2", () => {
  it("settles the answer chrome only on authoritative terminal presentations", () => {
    for (const kind of ["cancelled", "complete", "recoverable_error", "terminal_error"] as const) {
      expect(settledRunPresentationV2(presentation({ kind }))).toBe(true);
    }
    for (const kind of ["activity", "connection_lost", "idle", "streaming"] as const) {
      expect(settledRunPresentationV2(presentation({ kind }))).toBe(false);
    }
  });

  it("keeps run and request UUIDs out of the streaming chrome", () => {
    const runId = "396b627a-1c9f-4e58-9d1f-2b9a5c1e7a10";
    render(
      <RunAnswerV2
        content="Частичный ответ"
        presentation={presentation({
          activity: { kind: "provider", label: "Thinking…" },
          kind: "activity",
          runId
        })}
      />
    );

    expect(screen.getByTestId("run-status-line")).toHaveTextContent("Thinking…");
    expect(screen.queryByTestId("conversation-message-actions")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu
    );
  });

  it("renders explicit activity without an invented empty answer", () => {
    render(
      <RunAnswerV2
        content=""
        presentation={presentation({
          activity: { kind: "preparing", label: "Preparing request…" },
          kind: "activity"
        })}
      />
    );

    expect(screen.getByTestId("run-status-line")).toHaveTextContent("Preparing request…");
    expect(screen.queryByText("This message has no text.")).toBeNull();
  });

  it("keeps tool history inline, collapsed, and leaves a visible budget warning", () => {
    render(
      <RunAnswerV2
        content="Answer"
        presentation={presentation({ kind: "complete" })}
        toolActivity={{
          calls: [{
            durationMs: 1250,
            round: 1,
            serverName: "AWS Documentation",
            status: "complete",
            toolName: "search_documentation"
          }],
          warning: { kind: "rounds", limit: 8 }
        }}
      />
    );

    const disclosure = screen.getByTestId("tool-activity-disclosure");
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByText("1 tool call")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Tool round limit (8) stopped further tool use."
    );
    fireEvent.click(screen.getByText("1 tool call"));
    expect(disclosure).toHaveAttribute("open");
    // Tool rows read as plain language: no raw `search_documentation`.
    expect(screen.getByText("Used AWS Documentation: search documentation")).toBeVisible();
    expect(screen.getByText("1.3 s · round 1")).toBeVisible();
    expect(screen.queryByText(/search_documentation/u)).toBeNull();
  });

  it("restores the semantic shimmering tool status from persisted running activity", () => {
    render(
      <RunAnswerV2
        content=""
        presentation={presentation({
          activity: { kind: "provider", label: "Thinking…" },
          kind: "activity"
        })}
        toolActivity={{
          calls: [{ round: 1, serverName: "Auto tools", status: "running", toolName: "find_tools" }]
        }}
      />
    );

    const status = screen.getByText("Finding relevant tools…");
    expect(status).toHaveClass("v2-run-shimmer");
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("keeps partial output for streaming, cancellation, and connection loss", async () => {
    const refresh = vi.fn(async () => undefined);
    const regenerate = vi.fn();
    const { rerender } = render(
      <RunAnswerV2
        content="Partial **answer**"
        presentation={presentation({ kind: "streaming", runId: "run-a" })}
      />
    );
    expect(screen.getByRole("article", { name: "Answer" })).toHaveClass(
      "v2-run-answer-streaming"
    );
    expect(screen.getByText("answer")).toBeVisible();

    rerender(
      <RunAnswerV2
        content="Partial **answer**"
        onRegenerate={regenerate}
        presentation={presentation({ kind: "cancelled", runId: "run-a" })}
      />
    );
    expect(screen.getByText("Stopped")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(regenerate).toHaveBeenCalledOnce();

    rerender(
      <RunAnswerV2
        content="Partial **answer**"
        onRefresh={refresh}
        presentation={presentation({ kind: "connection_lost", runId: "run-a" })}
      />
    );
    expect(screen.getByTestId("run-connection-lost")).toHaveTextContent(
      "Connection lost·Refresh"
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.getByText("answer")).toBeVisible();
  });

  it("presents retryable and terminal errors with distinct recovery actions", () => {
    const retry = vi.fn();
    const selectModel = vi.fn();
    const regenerate = vi.fn();
    const { rerender } = render(
      <RunAnswerV2
        content="Partial result"
        onRetry={retry}
        presentation={presentation({
          failure: {
            code: "provider_stream_reset",
            message: "Частичный результат сохранён.",
            recovery: "retry"
          },
          kind: "recoverable_error"
        })}
      />
    );

    const interrupted = screen.getByRole("region", { name: "Answer interrupted by an error" });
    expect(interrupted).toHaveTextContent("Answer interrupted by a provider error");
    expect(interrupted).toHaveTextContent("Support reference provider_stream_reset");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(
      <RunAnswerV2
        content=""
        onRegenerate={regenerate}
        onSelectModel={selectModel}
        presentation={presentation({
          failure: {
            code: "context_budget_exceeded",
            message: "Choose a model with a larger context.",
            recovery: "change_parameters"
          },
          kind: "terminal_error"
        })}
      />
    );
    const failed = screen.getByRole("region", { name: "Run failed" });
    expect(failed).toHaveTextContent("Request not completed");
    expect(failed).toHaveTextContent("Choose a model with a larger context.");
    expect(failed).toHaveTextContent("Support reference context_budget_exceeded");
    fireEvent.click(screen.getByRole("button", { name: "Choose model…" }));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(selectModel).toHaveBeenCalledOnce();
    expect(regenerate).toHaveBeenCalledOnce();
  });

  it("offers only Auto retry and an explicit Load all fallback for discovery failure", () => {
    const retry = vi.fn();
    const useLoadAll = vi.fn();
    render(
      <RunAnswerV2
        content=""
        onRegenerate={vi.fn()}
        onRetry={retry}
        onSelectModel={vi.fn()}
        onUseLoadAll={useLoadAll}
        presentation={presentation({
          failure: {
            code: MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
            message: "Automatic tool discovery is unavailable.",
            recovery: "change_parameters"
          },
          kind: "terminal_error"
        })}
      />
    );

    expect(screen.getByRole("region", {
      name: "Automatic tool discovery is unavailable"
    })).toHaveTextContent("Automatic tool discovery is unavailable");
    expect(screen.queryByRole("button", { name: "Choose model…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Load all" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(useLoadAll).toHaveBeenCalledOnce();
  });

  it("changes Send to Stop but cannot cancel before a durable run id", () => {
    const send = vi.fn();
    const stop = vi.fn();
    const { rerender } = render(
      <RunComposerActionV2 active={false} onSend={send} onStop={stop} runId={null} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(send).toHaveBeenCalledOnce();

    rerender(<RunComposerActionV2 active onSend={send} onStop={stop} runId={null} />);
    const unavailableStop = screen.getByRole("button", { name: "Stop answer" });
    expect(unavailableStop).toBeDisabled();
    expect(unavailableStop).toHaveAccessibleDescription(
      "The run is not yet acknowledged by the server."
    );

    rerender(<RunComposerActionV2 active onSend={send} onStop={stop} runId="run-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Stop answer" }));
    expect(stop).toHaveBeenCalledWith("run-a");
  });

  it("keeps a disabled Send reason attached to the stable action", () => {
    render(
      <RunComposerActionV2
        active={false}
        onSend={vi.fn()}
        runId={null}
        sendDisabled
        sendDisabledReason="Type a message."
      />
    );

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" }))
      .toHaveAccessibleDescription("Type a message.");
  });

  it("announces only a continuously selected source and never replays historical terminal state", async () => {
    const working = presentation({
      activity: { kind: "search", label: "Searching the web…" },
      kind: "activity",
      runId: "run-a"
    });
    const complete = presentation({ kind: "complete", runId: "run-a" });
    const { rerender } = render(
      <RunLifecycleAnnouncerV2
        activeChatId="chat-a"
        presentation={working}
        sourceChatId="chat-a"
      />
    );

    await waitFor(() => expect(screen.getByTestId("run-lifecycle-announcer")).toHaveTextContent(
      "Searching the web…"
    ));
    rerender(
      <RunLifecycleAnnouncerV2
        activeChatId="chat-a"
        presentation={complete}
        sourceChatId="chat-a"
      />
    );
    await waitFor(() => expect(screen.getByTestId("run-lifecycle-announcer")).toHaveTextContent(
      "Answer ready. The message field is available."
    ));

    rerender(
      <RunLifecycleAnnouncerV2
        activeChatId="chat-b"
        presentation={complete}
        sourceChatId="chat-a"
      />
    );
    await waitFor(() => expect(screen.getByTestId("run-lifecycle-announcer")).toBeEmptyDOMElement());
    rerender(
      <RunLifecycleAnnouncerV2
        activeChatId="chat-a"
        presentation={complete}
        sourceChatId="chat-a"
      />
    );
    await waitFor(() => expect(screen.getByTestId("run-lifecycle-announcer")).toBeEmptyDOMElement());
  });
});
