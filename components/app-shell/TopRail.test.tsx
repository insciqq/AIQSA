import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineSnapshot } from "./runState";
import { TopRail } from "./TopRail";

const idlePipeline: PipelineSnapshot = {
  answer: "idle",
  phase: "idle",
  question: "idle",
  search: "idle"
};

function renderTopRail(overrides: Partial<ComponentProps<typeof TopRail>> = {}) {
  const callbacks = {
    onCopyThread: vi.fn(),
    onOpenBranches: vi.fn(),
    onOpenDetails: vi.fn(),
    onOpenPipeline: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onShare: vi.fn(),
    onStartNewChat: vi.fn()
  };
  const props: ComponentProps<typeof TopRail> = {
    activeChatId: "chat-1",
    activeChatTitle: "Research notes",
    detailsOpen: false,
    newChatDisabled: false,
    pipeline: idlePipeline,
    ...callbacks,
    ...overrides
  };

  return {
    callbacks,
    props,
    ...render(<TopRail {...props} />)
  };
}

afterEach(cleanup);

describe("TopRail", () => {
  it("renders the current chat title once and gives a blank workspace an unambiguous title", () => {
    const { rerender, props } = renderTopRail();

    expect(screen.getByTestId("top-rail")).toHaveClass(
      "border-trace-subtle",
      "bg-answer-paper"
    );
    expect(screen.getByRole("heading", { level: 1, name: "Research notes" })).toBeVisible();
    expect(screen.getByTestId("current-chat-title")).toHaveTextContent("Research notes");
    expect(screen.getByTestId("current-chat-title")).toHaveClass("truncate", "text-ink");
    expect(screen.getByTestId("current-chat-title")).not.toHaveClass("sr-only");
    expect(screen.getAllByText("Research notes")).toHaveLength(1);
    expect(screen.queryByLabelText("AIQSA")).not.toBeInTheDocument();

    rerender(<TopRail {...props} activeChatId={null} activeChatTitle="Ignored title" />);

    expect(screen.getByRole("heading", { level: 1, name: "New chat" })).toBeVisible();
  });

  it("keeps idle and settled pipeline decoration out of the top bar", () => {
    const { rerender, props } = renderTopRail();

    expect(screen.queryByTestId("pipeline-indicator")).not.toBeInTheDocument();

    rerender(
      <TopRail
        {...props}
        pipeline={{ answer: "done", phase: "settled", question: "done", search: "skipped" }}
      />
    );

    expect(screen.queryByTestId("pipeline-indicator")).not.toBeInTheDocument();
  });

  it.each([
    {
      expected: "Working…",
      pipeline: { answer: "idle", phase: "running", question: "active", search: "idle" } as PipelineSnapshot
    },
    {
      expected: "Searching…",
      pipeline: { answer: "idle", phase: "running", question: "done", search: "active" } as PipelineSnapshot
    },
    {
      expected: "Answering…",
      pipeline: { answer: "active", phase: "running", question: "done", search: "done" } as PipelineSnapshot
    }
  ])("shows the readable $expected activity stage and opens Events", ({ expected, pipeline }) => {
    const onOpenPipeline = vi.fn();
    renderTopRail({ onOpenPipeline, pipeline });

    const indicator = screen.getByTestId("pipeline-indicator");
    expect(indicator).toHaveTextContent(expected);
    expect(indicator).toHaveAttribute("data-phase", "running");
    expect(indicator.querySelector("[data-run-activity]")).toBeInTheDocument();

    fireEvent.click(indicator);
    expect(onOpenPipeline).toHaveBeenCalledOnce();
  });

  it("shows a readable error state with the failing stage preserved", () => {
    const onOpenPipeline = vi.fn();
    renderTopRail({
      onOpenPipeline,
      pipeline: {
        answer: "idle",
        phase: "error",
        question: "done",
        search: "error"
      }
    });

    const indicator = screen.getByRole("button", { name: "Run error - open run events" });
    expect(indicator).toHaveAttribute("data-phase", "error");
    expect(indicator).toHaveTextContent("Run error");

    fireEvent.click(indicator);
    expect(onOpenPipeline).toHaveBeenCalledOnce();
  });

  it("wires New chat, conversation actions, workspace, share, and state-aware Details", async () => {
    const { callbacks, props, rerender } = renderTopRail();

    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Start new chat" }));
    const conversationActions = screen.getByRole("button", { name: "Conversation actions" });
    fireEvent.click(conversationActions);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy thread" }));
    await waitFor(() => expect(callbacks.onCopyThread).toHaveBeenCalledOnce());
    fireEvent.click(conversationActions);
    fireEvent.click(screen.getByRole("menuitem", { name: "Branch tree" }));
    await waitFor(() => expect(callbacks.onOpenBranches).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Share anonymously" }));

    const openDetails = screen.getByRole("button", { name: "Open details" });
    expect(openDetails).toHaveAttribute("aria-controls", "details-pane");
    expect(openDetails).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(openDetails);

    expect(callbacks.onOpenWorkspace).toHaveBeenCalledOnce();
    expect(callbacks.onStartNewChat).toHaveBeenCalledOnce();
    expect(callbacks.onCopyThread).toHaveBeenCalledOnce();
    expect(callbacks.onOpenBranches).toHaveBeenCalledOnce();
    expect(callbacks.onShare).toHaveBeenCalledOnce();
    expect(callbacks.onOpenDetails).toHaveBeenCalledOnce();

    rerender(<TopRail {...props} detailsOpen />);
    const closeDetails = screen.getByRole("button", { name: "Close details" });
    expect(closeDetails).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(closeDetails);
    expect(callbacks.onOpenDetails).toHaveBeenCalledTimes(2);
  });

  it("disables only the compact New chat action when its workspace owner is unavailable", () => {
    renderTopRail({ newChatDisabled: true });

    expect(screen.getByRole("button", { name: "Start new chat" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open workspace" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open details" })).toBeEnabled();
  });

  it("marks the compact Workspace entry when its Account footer needs attention", () => {
    const { props, rerender } = renderTopRail({ workspaceAttention: true });
    const workspace = screen.getByRole("button", { name: "Open workspace" });

    expect(workspace).toHaveAttribute("aria-describedby", "workspace-account-attention-description");
    expect(workspace).toHaveAttribute("title", "Open workspace — Account needs attention");
    expect(screen.getByTestId("workspace-account-attention")).toBeVisible();
    expect(document.getElementById("workspace-account-attention-description")).toHaveTextContent(
      "Open Workspace and then Account"
    );

    rerender(<TopRail {...props} workspaceAttention={false} />);
    expect(workspace).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByTestId("workspace-account-attention")).not.toBeInTheDocument();
  });

  it("does not own or render account and session controls", () => {
    renderTopRail();

    expect(screen.queryByRole("button", { name: /Account menu/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("keeps touch chrome reachable and owns conversation actions in one menu", async () => {
    const { callbacks } = renderTopRail({
      pipeline: { answer: "active", phase: "running", question: "done", search: "done" }
    });

    expect(screen.queryByLabelText("AIQSA")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-chat-title")).toHaveClass("truncate", "text-ink");
    expect(screen.getByRole("button", { name: "Open workspace" })).toHaveClass(
      "[@media(hover:none)]:!size-11"
    );
    const newChat = screen.getByRole("button", { name: "Start new chat" });
    expect(newChat).toHaveClass("lg:hidden", "[@media(hover:none)]:!size-11");
    expect(screen.getByRole("group", { name: "Workspace controls" })).toHaveClass(
      "border-r",
      "border-trace-subtle",
      "lg:hidden"
    );
    expect(screen.getByRole("group", { name: "Conversation controls" })).toContainElement(
      screen.getByRole("button", { name: "Share anonymously" })
    );
    expect(screen.queryByRole("button", { name: "Copy thread" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Branch tree" })).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-indicator")).toHaveClass(
      "[@media(hover:none)]:!h-touch",
      "[@media(hover:none)]:!min-w-touch"
    );
    expect(screen.getByRole("button", { name: "Share anonymously" })).toHaveClass(
      "inline-flex",
      "size-11",
      "lg:h-9",
      "[@media(pointer:coarse)]:!size-11"
    );
    expect(screen.getByRole("button", { name: "Open details" })).toHaveClass(
      "inline-flex",
      "size-11",
      "lg:h-9"
    );
    const conversationActions = screen.getByRole("button", { name: "Conversation actions" });
    fireEvent.click(conversationActions);

    const menu = screen.getByRole("menu", { name: "Conversation actions" });
    expect(menu).toHaveClass("border-trace-subtle", "bg-overlay-surface");
    expect(within(menu).getByRole("menuitem", { name: "Copy thread" })).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "Branch tree" })).toBeVisible();
    expect(within(menu).queryByRole("menuitem", { name: "Share anonymously" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Open details" })).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy thread" }));
    expect(conversationActions).toHaveFocus();
    await waitFor(() => expect(callbacks.onCopyThread).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: /Account menu/ })).not.toBeInTheDocument();
  });
});
