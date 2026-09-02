import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AssistantsPanelV2,
  FilesPanelV2,
  KnowledgePanelV2,
  LibraryV2,
  MemoryPanelV2
} from "./LibraryV2";
import type { LibraryNavigationGuardV2, MemoryOverviewV2 } from "./contracts";

function memoryOverview(
  overrides: Partial<MemoryOverviewV2> = {}
): MemoryOverviewV2 {
  return {
    administratorDisabled: false,
    automaticLearning: false,
    explicitCrudAvailable: true,
    loadState: "ready",
    referenceChatHistory: true,
    status: "ON",
    useMemoryFacts: true,
    ...overrides
  };
}

describe("LibraryV2", () => {
  it("keeps selected tab local and supports roving keyboard navigation", () => {
    render(
      <LibraryV2
        onBack={vi.fn()}
        tabs={[
          { content: <p>Assistant owner</p>, id: "assistants", label: "Assistants" },
          { content: <p>Knowledge owner</p>, id: "knowledge", label: "Knowledge" },
          { content: <p>Files owner</p>, id: "files", label: "Files" },
          { content: <p>Memory owner</p>, id: "memory", label: "Memory" }
        ]}
      />
    );

    const assistants = screen.getByRole("tab", { name: "Assistants" });
    expect(assistants).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(assistants, { key: "End" });
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Memory owner")).toBeInTheDocument();
  });

  it("delegates tab and exit intent to the focused owner guard", () => {
    let release: (() => void) | undefined;
    const guard = vi.fn<LibraryNavigationGuardV2>((_intent, proceed) => { release = proceed; });
    const onBack = vi.fn();
    render(
      <LibraryV2
        navigationGuard={guard}
        onBack={onBack}
        tabs={[
          { content: <p>Assistant owner</p>, id: "assistants", label: "Assistants" },
          { content: <p>Knowledge owner</p>, id: "knowledge", label: "Knowledge" }
        ]}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Knowledge" }));
    expect(guard).toHaveBeenCalledWith(
      { from: "assistants", kind: "tab", to: "knowledge" },
      expect.any(Function)
    );
    expect(screen.getByText("Assistant owner")).toBeInTheDocument();
    act(() => release?.());
    expect(screen.getByText("Knowledge owner")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(onBack).not.toHaveBeenCalled();
    act(() => release?.());
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("Library resource panels", () => {
  it("opens the reusable Source catalog separately from Base creation", () => {
    const onBrowseSources = vi.fn();
    const onCreate = vi.fn();
    render(
      <KnowledgePanelV2
        bases={[]}
        onBrowseSources={onBrowseSources}
        onCreate={onCreate}
      />
    );

    expect(screen.getByText(/Bases group reusable Sources/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Browse Sources" }));
    fireEvent.click(screen.getByRole("button", { name: "New base" }));
    expect(onBrowseSources).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("shows the exact Knowledge readiness instead of presenting every active Base as ready", () => {
    render(
      <KnowledgePanelV2
        bases={[
          {
            description: "No Sources yet",
            id: "empty",
            name: "Empty Base",
            owned: true,
            sourceCount: 0,
            status: "empty"
          },
          {
            description: "One Source failed",
            id: "attention",
            name: "Review Base",
            owned: true,
            sourceCount: 2,
            status: "needs_attention"
          }
        ]}
      />
    );

    expect(screen.getByText("Empty")).toBeVisible();
    expect(screen.getByText("Needs attention")).toBeVisible();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("keeps first-load and retryable Knowledge failures distinct from an empty Library", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <KnowledgePanelV2 bases={[]} loadState="loading" />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading knowledge…");
    expect(screen.queryByText("No knowledge bases yet.")).not.toBeInTheDocument();

    rerender(
      <KnowledgePanelV2
        bases={[]}
        error="Knowledge is temporarily unavailable."
        loadState="error"
        onRetry={onRetry}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Knowledge is temporarily unavailable.");
    expect(screen.queryByText("No knowledge bases yet.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps assistant selection and owned management actions explicit", () => {
    const onOpen = vi.fn();
    const onPinToggle = vi.fn();
    render(
      <AssistantsPanelV2
        assistants={[{
          archived: false,
          available: true,
          description: "Checks APIs",
          id: "assistant",
          name: "API Reviewer",
          owned: true,
          pinned: false,
          revision: 2
        }]}
        onOpen={onOpen}
        onPinToggle={onPinToggle}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Pin API Reviewer" }));
    expect(onPinToggle).toHaveBeenCalledWith("assistant", true);
    fireEvent.click(screen.getByRole("button", { name: "More actions for API Reviewer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onOpen).toHaveBeenCalledWith("assistant");
  });

  it("keeps explicit Memory CRUD reachable when admin recall is disabled", () => {
    const onManage = vi.fn();
    render(
      <MemoryPanelV2
        memory={memoryOverview({
          administratorDisabled: true,
          automaticLearning: false,
          disabledReason: "Policy disabled",
          referenceChatHistory: false,
          status: "NEEDS_ADMIN_SETUP",
          useMemoryFacts: false
        })}
        onManage={onManage}
      />
    );

    expect(screen.getByText("Memory needs administrator setup")).toBeInTheDocument();
    // The switches live only in Settings › Memory (B2): no duplicates here.
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Manage memory" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(screen.queryByText("Search chat history")).not.toBeInTheDocument();
    expect(screen.queryByText("Memory operations")).not.toBeInTheDocument();
    expect(screen.queryByText("Advanced evidence")).not.toBeInTheDocument();
    expect(screen.queryByText(/temperature|profile/i)).not.toBeInTheDocument();
  });

  it.each([
    ["ON", "Memory is on"],
    ["PREPARING", "Memory is preparing"],
    ["UNAVAILABLE", "Memory is temporarily unavailable"],
    ["NEEDS_ADMIN_SETUP", "Memory needs administrator setup"],
    ["PAUSED", "Memory is paused"]
  ] as const)("renders the exact consumer status for %s", (status, label) => {
    render(
      <MemoryPanelV2
        memory={memoryOverview({
          administratorDisabled: status === "NEEDS_ADMIN_SETUP",
          status
        })}
      />
    );

    expect(screen.getByRole("heading", { name: label })).toBeVisible();
  });

  it("routes the Memory switches to Settings instead of duplicating them", () => {
    const onOpenSettings = vi.fn();
    render(<MemoryPanelV2 memory={memoryOverview()} onOpenSettings={onOpenSettings} />);

    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Memory settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows an honest loading state and disables settings until status is ready", () => {
    render(
      <MemoryPanelV2
        memory={memoryOverview({ loadState: "loading", status: null })}
      />
    );

    expect(screen.getByRole("heading", { name: "Loading Memory settings…" })).toBeVisible();
    expect(screen.queryByText("Memory is paused")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("shows a bounded load error and delegates Retry", () => {
    const onRetry = vi.fn();
    render(
      <MemoryPanelV2
        memory={memoryOverview({ loadState: "error", status: null })}
        onRetry={onRetry}
      />
    );

    expect(screen.getByRole("heading", { name: "Memory status could not be loaded" }))
      .toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("labels uploads private without advertising disabled generated files", () => {
    const onOpen = vi.fn();
    render(
      <FilesPanelV2
        files={[{
          id: "upload",
          meta: "214 kB",
          name: "source.csv",
          private: true,
          status: "ready"
        }]}
        onOpen={onOpen}
      />
    );
    expect(screen.getByText("Files are private and visible only to you.")).toBeInTheDocument();
    expect(screen.getByText("Upload · Private")).toBeInTheDocument();
    expect(screen.queryByText(/generated files/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to source" }));
    expect(onOpen).toHaveBeenCalledWith("upload");
  });

  it("does not expose a dead source action and provides a retryable load failure", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <FilesPanelV2
        files={[{
          id: "upload",
          meta: "214 kB",
          name: "source.csv",
          private: true,
          status: "ready"
        }]}
      />
    );
    expect(screen.getByRole("button", { name: "Go to source" })).toBeDisabled();

    rerender(<FilesPanelV2 files={[]} loadState="error" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Files could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
