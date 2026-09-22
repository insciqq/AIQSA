import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { memoryConsumerItemFixture } from "@/tests/support/memoryFixtures";
import type { ComponentProps } from "react";
import {
  AssistantsPanelV2,
  FilesPanelV2,
  KnowledgePanelV2,
  LibraryV2,
  libraryTabGroups,
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

function memoryPanelProps(
  overrides: Partial<ComponentProps<typeof MemoryPanelV2>> = {}
): ComponentProps<typeof MemoryPanelV2> {
  return {
    activeRef: null,
    busy: null,
    draft: "",
    hasMore: false,
    items: [],
    listError: null,
    listState: "ready",
    memory: memoryOverview(),
    mutationError: null,
    notice: null,
    onCancelRow: vi.fn(),
    onConfirmForget: vi.fn(),
    onCreate: vi.fn(),
    onDraftChange: vi.fn(),
    onEdit: vi.fn(),
    onForget: vi.fn(),
    onLoadMore: vi.fn(),
    onQueryChange: vi.fn(),
    onRetry: vi.fn(),
    onSave: vi.fn(),
    onSubmitQuery: vi.fn(),
    query: "",
    searchActive: false,
    rowMode: null,
    ...overrides
  };
}

function memoryStatusElement(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(".v2-memory-state");
  if (!element) throw new Error("Memory status is missing");
  return element;
}

describe("LibraryV2", () => {
  it("renders ten sections in visual keyboard order even when supplied in reverse", () => {
    const ids = libraryTabGroups.flatMap(group => group.tabs);
    render(<LibraryV2 onBack={vi.fn()} tabs={[...ids].reverse().map(id => ({ id, label: id, content: <p>{id} content</p> }))} />);
    expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(ids);
    for (const label of ["Behavior", "Content", "Tools"]) expect(screen.getByText(label)).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(screen.getByRole("tab", { name: "assistants" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "defaults" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "defaults" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "assistants" })).toHaveAttribute("aria-selected", "true");
  });

  it("guards changed initial targets without remounting a draft and disables busy navigation", () => {
    let release: (() => void) | undefined;
    const guard = vi.fn<LibraryNavigationGuardV2>((_intent, proceed) => { release = proceed; });
    const onBack = vi.fn();
    const tabs = [{ id: "assistants" as const, label: "Assistants", content: <input aria-label="Draft" defaultValue="" /> },
      { id: "files" as const, label: "Files", content: <p>Files content</p> }];
    const { rerender } = render(<LibraryV2 initialTab="assistants" navigationGuard={guard} tabs={tabs} onBack={onBack} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Unsaved" } });
    rerender(<LibraryV2 initialTab="files" navigationGuard={guard} tabs={tabs} onBack={onBack} />);
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("Unsaved");
    expect(guard).toHaveBeenCalledOnce();
    act(() => release?.());
    expect(screen.getByText("Files content")).toBeVisible();
    rerender(<LibraryV2 busy initialTab="files" navigationGuard={guard} tabs={tabs} onBack={onBack} />);
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeDisabled();
    for (const tab of screen.getAllByRole("tab")) expect(tab).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Files" }), { key: "Home" });
    expect(guard).toHaveBeenCalledOnce();
    expect(screen.queryByText("Tools")).toBeNull();
  });

  it("keeps Artifacts between Files and Memory in keyboard navigation", () => {
    render(<LibraryV2 initialTab="files" onBack={vi.fn()} tabs={[
      { id: "files", label: "Files", content: <p>Files</p> },
      { id: "artifacts", label: "Artifacts", content: <p>Saved artifacts</p> },
      { id: "memory", label: "Memory", content: <p>Memory</p> }
    ]} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Files" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Artifacts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("link", { name: "Artifacts" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Artifacts" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
  });

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
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Files owner")).toBeInTheDocument();
  });

  it.each(["create", "edit", "forget"] as const)("blocks an unknown %s outcome while keeping the exit available", (rowMode) => {
    const item = memoryConsumerItemFixture();
    const props = memoryPanelProps({
      activeRef: item.memoryRef, draft: "My preserved correction.", items: [item],
      mutationError: "The change could not be confirmed.", mutationOutcomeUnknown: true, rowMode
    });
    render(<MemoryPanelV2 {...props} />);
    const submit = screen.getByRole("button", {
      name: rowMode === "create" ? "Save memory" : rowMode === "edit" ? "Save" : "Forget"
    });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("could not be confirmed");
    if (rowMode !== "forget") expect(screen.getByRole("textbox")).toHaveValue("My preserved correction.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancelRow).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onConfirmForget).not.toHaveBeenCalled();
  });

  it("reveals a newly selected tab when the section strip overflows", async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    );
    const revealed: HTMLElement[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        revealed.push(this);
      }
    });

    try {
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

      const tabList = screen.getByRole("tablist", { name: "Studio sections" });
      Object.defineProperties(tabList, {
        clientWidth: { configurable: true, value: 200 },
        scrollWidth: { configurable: true, value: 500 }
      });
      const memory = screen.getByRole("tab", { name: "Memory" });
      fireEvent.click(memory);

      await waitFor(() => expect(revealed).toContain(memory));
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoView
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("renders Skills as a first-class section instead of invoking an overlay", () => {
    render(
      <LibraryV2
        onBack={vi.fn()}
        tabs={[
          { content: <p>Assistant owner</p>, id: "assistants", label: "Assistants" },
          { content: <p>Skill owner</p>, id: "skills", label: "Skills" }
        ]}
      />
    );

    const skills = screen.getByRole("tab", { name: "Skills" });
    fireEvent.click(skills);

    expect(skills).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Skill owner")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Skills" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Studio location" })).toHaveTextContent(
      "Skills"
    );
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

describe("Library sub-views", () => {
  it("leaves resource-owned editor and return focus in place", () => {
    const tabs = [{ content: <input aria-label="Name" />, id: "instructions" as const, label: "Instructions" }];
    const { rerender } = render(<LibraryV2 initialTab="instructions" onBack={vi.fn()} tabs={tabs} />);
    const input = screen.getByLabelText("Name");
    input.focus();
    rerender(<LibraryV2 initialTab="instructions" onBack={vi.fn()} tabs={tabs}
      subview={{ key: "instruction-editor-new", label: "New preset", backLabel: "Back to Instructions", focus: "resource", onBack: vi.fn() }} />);
    expect(input).toHaveFocus();
    rerender(<LibraryV2 initialTab="instructions" onBack={vi.fn()} tabs={tabs} />);
    expect(input).toHaveFocus();
  });

  it("shows the sub-view in the crumb, swaps Back to chat for its Back control, and focuses it", () => {
    const onBack = vi.fn();
    const exit = vi.fn();
    const tabs = [
      { content: <p>Assistant owner</p>, id: "assistants" as const, label: "Assistants" },
      { content: <p>Base detail</p>, id: "knowledge" as const, label: "Knowledge" }
    ];
    const { rerender } = render(
      <LibraryV2
        initialTab="knowledge"
        onBack={onBack}
        subview={{ backLabel: "Back to Knowledge", key: "detail:base-1", label: "Product docs", onBack: exit }}
        tabs={tabs}
      />
    );

    expect(screen.getByRole("navigation", { name: "Studio location" })).toHaveTextContent("Knowledge / Product docs");
    const back = screen.getByRole("button", { name: "Back to Knowledge" });
    expect(back).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Back to chat" })).not.toBeInTheDocument();
    fireEvent.click(back);
    expect(exit).toHaveBeenCalledOnce();
    expect(onBack).not.toHaveBeenCalled();

    rerender(<LibraryV2 initialTab="knowledge" onBack={onBack} subview={null} tabs={tabs} />);
    expect(screen.getByRole("navigation", { name: "Studio location" })).toHaveTextContent("Knowledge");
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Knowledge" })).toHaveFocus();
  });
});

describe("Library resource panels", () => {
  it("shows simple Base readiness, Source count, access, and updated time", () => {
    const onOpen = vi.fn();
    render(
      <KnowledgePanelV2
        bases={[{
          description: "Product references",
          id: "base-1",
          name: "Product docs",
          owned: true,
          readinessLabel: "Ready · 1 processing · 1 needs attention",
          sourceCount: 3,
          status: "needs_attention",
          updatedLabel: "Aug 18, 2026"
        }]}
        onOpen={onOpen}
      />
    );

    const row = screen.getByRole("button", { name: "Open Product docs" }).closest("li")!;
    expect(row).toHaveTextContent("Ready · 1 processing · 1 needs attention");
    expect(row).toHaveTextContent("3 documents");
    expect(row).toHaveTextContent("Yours");
    expect(row).toHaveTextContent("Updated Aug 18, 2026");
    expect(row).not.toHaveTextContent(/embedding|generation|revision|fingerprint|chunk/iu);
    fireEvent.click(screen.getByRole("button", { name: "Open Product docs" }));
    expect(onOpen).toHaveBeenCalledWith("base-1");
  });

  it("keeps existing Bases available while creation is temporarily unavailable", () => {
    const onOpen = vi.fn();
    render(
      <KnowledgePanelV2
        bases={[{ description: "", id: "base-1", name: "Product docs", owned: true, sourceCount: 1, status: "ready" }]}
        canCreate={false}
        onOpen={onOpen}
      />
    );

    expect(screen.getByText("Knowledge is temporarily unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "New base" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open Product docs" }));
    expect(onOpen).toHaveBeenCalledWith("base-1");
  });

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

    expect(screen.getByText(/A base is a set of documents an answer may read/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "All documents" }));
    fireEvent.click(screen.getByRole("button", { name: "New base" }));
    expect(onBrowseSources).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("shows the exact Knowledge readiness instead of presenting every active Base as ready", () => {
    render(
      <KnowledgePanelV2
        bases={[
          {
            description: "No documents yet",
            id: "empty",
            name: "Empty Base",
            owned: true,
            sourceCount: 0,
            status: "empty"
          },
          {
            description: "One document failed",
            id: "attention",
            name: "Review Base",
            owned: true,
            sourceCount: 2,
            status: "needs_attention"
          }
        ]}
      />
    );

    expect(screen.getByText("Empty · no documents yet")).toBeVisible();
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
          pinned: false
        }]}
        onOpen={onOpen}
        onPinToggle={onPinToggle}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions for API Reviewer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(onPinToggle).toHaveBeenCalledWith("assistant", true);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onOpen).toHaveBeenCalledWith("assistant");
  });

  it("shows human availability copy without exposing a raw reason code", () => {
    const onUnavailableAction = vi.fn();
    render(
      <AssistantsPanelV2
        assistants={[{
          archived: false,
          available: false,
          description: "Checks repositories",
          id: "assistant",
          name: "Release helper",
          owned: true,
          unavailable: {
            action: { kind: "mcp-settings", label: "Fix in Settings…" },
            explanation: "GitHub is turned off or needs attention.",
            headline: "Needs the GitHub tools"
          }
        }]}
        onUnavailableAction={onUnavailableAction}
      />
    );

    expect(screen.getByText("Needs the GitHub tools")).toBeVisible();
    const why = screen.getByRole("button", { name: "Why?" });
    expect(why).toBeEnabled();
    expect(screen.queryByText("GitHub is turned off or needs attention.")).not.toBeInTheDocument();
    fireEvent.click(why);
    expect(screen.getByText("GitHub is turned off or needs attention.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Fix in Settings…" }));
    expect(onUnavailableAction).toHaveBeenCalledWith("assistant", "mcp-settings");
    expect(screen.getByRole("button", { name: "Use Release helper" })).toBeDisabled();
    expect(screen.queryByText("tools_access")).not.toBeInTheDocument();
  });

  it("keeps explicit Memory CRUD reachable when admin recall is disabled", () => {
    const onCreate = vi.fn();
    const { container } = render(
      <MemoryPanelV2
        {...memoryPanelProps({
          memory: memoryOverview({
            administratorDisabled: true,
            automaticLearning: false,
            disabledReason: "Policy disabled",
            referenceChatHistory: false,
            status: "NEEDS_ADMIN_SETUP",
            useMemoryFacts: false
          }),
          onCreate
        })}
      />
    );

    expect(memoryStatusElement(container)).toHaveTextContent("Memory needs administrator setup");
    // The switches live only in Settings › Memory (B2): no duplicates here.
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Add memory" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Add memory" })[0]!);
    expect(onCreate).toHaveBeenCalledOnce();
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
    const { container } = render(
      <MemoryPanelV2
        {...memoryPanelProps({
          memory: memoryOverview({
            administratorDisabled: status === "NEEDS_ADMIN_SETUP",
            status
          })
        })}
      />
    );

    expect(memoryStatusElement(container)).toHaveTextContent(label);
  });

  it("keeps Memory controls beside its list without a Settings cross-link", () => {
    render(<MemoryPanelV2 {...memoryPanelProps({ settingsContent: <p>Five Memory gates</p> })} />);
    expect(screen.getByRole("complementary", { name: "How Memory works" })).toHaveTextContent("Five Memory gates");
    expect(screen.queryByRole("button", { name: "Memory settings" })).toBeNull();
  });

  it("claims automatic learning only when it is enabled and ready", () => {
    const { rerender } = render(<MemoryPanelV2 {...memoryPanelProps()} />);
    expect(screen.queryByText("Learning from your ordinary chats")).toBeNull();
    expect(screen.getByText("Saved memories may help personalize future answers.")).toBeVisible();

    rerender(<MemoryPanelV2 {...memoryPanelProps({ memory: memoryOverview({ automaticLearning: true }) })} />);
    expect(screen.getByText("Learning from your ordinary chats")).toBeVisible();

    rerender(<MemoryPanelV2 {...memoryPanelProps({ memory: memoryOverview({ automaticLearning: true, loadState: "error" }) })} />);
    expect(screen.queryByText("Learning from your ordinary chats")).toBeNull();
  });

  it("shows an honest loading state and disables settings until status is ready", () => {
    const { container } = render(
      <MemoryPanelV2
        {...memoryPanelProps({
          listState: "loading",
          memory: memoryOverview({ loadState: "loading", status: null })
        })}
      />
    );

    expect(memoryStatusElement(container)).toHaveTextContent("Loading Memory settings…");
    expect(screen.queryByText("Memory is paused")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("shows a bounded load error and delegates Retry", () => {
    const onRetry = vi.fn();
    const { container } = render(
      <MemoryPanelV2
        {...memoryPanelProps({
          listError: "memory_action_failed",
          listState: "error",
          memory: memoryOverview({ loadState: "error", status: null }),
          onRetry
        })}
      />
    );

    expect(memoryStatusElement(container)).toHaveTextContent("Memory status could not be loaded");
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("groups loaded memories and exposes only server-allowed row actions", () => {
    const onEdit = vi.fn();
    const onForget = vi.fn();
    const editable = memoryConsumerItemFixture({
      category: "ABOUT_YOU",
      memoryRef: "opaque-ref-never-render",
      statement: "I work on ingestion."
    });
    const readOnly = memoryConsumerItemFixture({
      allowedActions: [],
      category: "OTHER",
      memoryRef: "opaque-read-only",
      sourceAvailable: false,
      statement: "An uncategorized detail."
    });
    const { container } = render(
      <MemoryPanelV2 {...memoryPanelProps({ items: [editable, readOnly], onEdit, onForget })} />
    );

    expect(screen.getByRole("heading", { name: "About you 1" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Other 1" })).toBeVisible();
    expect(container.innerHTML).not.toContain(editable.memoryRef);
    expect(container.innerHTML).not.toContain(readOnly.memoryRef);
    expect(screen.getByText(/Source unavailable/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Memory actions: An uncategorized/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Memory actions: I work/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Forget" }));
    expect(onForget).toHaveBeenCalledWith(editable.memoryRef);
  });

  it("keeps all six server categories in contract order and omits empty groups", () => {
    const categories = [
      ["ABOUT_YOU", "About you"],
      ["PREFERENCES", "Preferences"],
      ["WORK", "Work"],
      ["GOALS", "Goals"],
      ["CONSTRAINTS_AND_ROUTINES", "Constraints and routines"],
      ["OTHER", "Other"]
    ] as const;
    render(
      <MemoryPanelV2
        {...memoryPanelProps({
          items: categories.map(([category], index) => memoryConsumerItemFixture({
            category,
            memoryRef: `opaque-category-${index}`,
            statement: `Category statement ${index}`
          }))
        })}
      />
    );

    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(
      categories.map(([, label]) => `${label}1`)
    );
  });

  it("does not announce partial group counts and delegates pagination", () => {
    const onLoadMore = vi.fn();
    render(
      <MemoryPanelV2
        {...memoryPanelProps({
          hasMore: true,
          items: [memoryConsumerItemFixture({ category: "ABOUT_YOU" })],
          onLoadMore
        })}
      />
    );

    expect(screen.getByRole("heading", { level: 3, name: "About you" })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 3, name: "About you 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("keeps loaded rows usable while paused", () => {
    const onEdit = vi.fn();
    const item = memoryConsumerItemFixture({ statement: "I work best before noon." });
    render(
      <MemoryPanelV2
        {...memoryPanelProps({
          items: [item],
          memory: memoryOverview({ status: "PAUSED", useMemoryFacts: false }),
          onEdit
        })}
      />
    );

    expect(screen.getByText(item.statement)).toBeVisible();
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).toBeEnabled();
    fireEvent.click(edit);
    expect(onEdit).toHaveBeenCalledWith(item.memoryRef);
  });

  it("folds a long fact to three lines until the user asks to show all", () => {
    const statement = "A".repeat(375);
    render(
      <MemoryPanelV2 {...memoryPanelProps({ items: [memoryConsumerItemFixture({ statement })] })} />
    );

    const toggle = screen.getByRole("button", { name: "Show all 375 characters" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("distinguishes empty search results and keeps loaded rows during a retryable page error", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <MemoryPanelV2 {...memoryPanelProps({ query: "draft query", searchActive: false })} />
    );
    expect(screen.getByText("Nothing saved yet")).toBeVisible();
    expect(screen.getByText(/write the first fact yourself/)).toBeVisible();

    rerender(
      <MemoryPanelV2 {...memoryPanelProps({ query: "architecture", searchActive: true })} />
    );
    expect(screen.getByText("No saved memories match this search.")).toBeVisible();

    const item = memoryConsumerItemFixture({ statement: "Keep this loaded row." });
    rerender(
      <MemoryPanelV2
        {...memoryPanelProps({
          items: [item],
          listError: "memory_action_failed",
          listState: "error",
          onRetry
        })}
      />
    );
    expect(screen.getByText(item.statement)).toBeVisible();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Saved memories could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps create and edit inline and confirms Forget in the named row", () => {
    const item = memoryConsumerItemFixture({ statement: "I prefer short answers." });
    const onSave = vi.fn();
    const onConfirmForget = vi.fn();
    const { rerender } = render(
      <MemoryPanelV2
        {...memoryPanelProps({ draft: "A new statement", rowMode: "create", onSave })}
      />
    );

    expect(screen.getByRole("textbox", { name: "New memory" })).toHaveValue("A new statement");
    expect(screen.getByText(/categorize this statement and check that it is safe/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect(onSave).toHaveBeenCalledOnce();

    rerender(
      <MemoryPanelV2
        {...memoryPanelProps({
          activeRef: item.memoryRef,
          items: [item],
          onConfirmForget,
          rowMode: "forget"
        })}
      />
    );
    expect(screen.getByRole("group", { name: /Forget I prefer short answers/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(onConfirmForget).toHaveBeenCalledOnce();
  });

  it("keeps privacy at panel level and opens a file through its row menu", () => {
    const onOpen = vi.fn();
    render(
      <FilesPanelV2
        files={[{
          byteSize: 214000,
          canOpenChat: true,
          chatId: "chat",
          chatTitle: "Quarterly brief",
          createdAt: "2026-09-21T14:00:00.000Z",
          id: "upload",
          savedAt: null,
          name: "source.csv",
          status: "ready"
        }]}
        onOpen={onOpen}
      />
    );
    expect(screen.getByText(/Files are private and visible only to you\./)).toBeInTheDocument();
    expect(screen.queryByText("Upload · Private")).not.toBeInTheDocument();
    expect(screen.queryByText(/generated files/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions for source.csv" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in chat" }));
    expect(onOpen).toHaveBeenCalledWith("upload");
  });

  it("searches loaded file names and chats without hiding pagination or claiming complete counts", () => {
    const onLoadMore = vi.fn();
    const source = { byteSize: 1200, canOpenChat: true, chatId: "chat", chatTitle: "Quarterly brief",
      createdAt: "2026-09-21T14:31:00.000Z", id: "one", name: "report.md", savedAt: null, status: "ready" as const };
    const files = [source, { ...source, id: "two", createdAt: "2026-09-21T14:02:00.000Z" },
      { ...source, id: "saved", chatId: null, chatTitle: null, canOpenChat: false, name: "template.md", savedAt: "2026-09-20T09:00:00.000Z" }];
    const { rerender } = render(<FilesPanelV2 files={files} complete={false} onLoadMore={onLoadMore} />);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("list")[0]).toHaveAccessibleName("Saved files");
    expect(screen.getByRole("list", { name: "Files from Quarterly brief" }).textContent).not.toContain("Quarterly brief");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), { target: { value: "QUARTERLY" } });
    expect(screen.getAllByRole("heading", { name: "report.md" })).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "template.md" })).not.toBeInTheDocument();
    expect(screen.getByText("Searching 3 loaded files.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Saved" }));
    expect(screen.getByText(/No loaded files match/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more files" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
    rerender(<FilesPanelV2 files={files} complete />);
    expect(screen.getByRole("button", { name: "Saved 1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "From chats 2" })).toBeVisible();
    expect(screen.queryByText(/Searching .* loaded files/)).not.toBeInTheDocument();
  });

  it("offers named downloads only for ready files and preserves file mutation feedback", () => {
    const onSave = vi.fn();
    const onUse = vi.fn();
    const source = { byteSize: 1200, canOpenChat: true, chatId: "chat", chatTitle: "Brief",
      createdAt: "2026-09-21T14:31:00.000Z", id: "one", name: "report.md", savedAt: null, status: "ready" as const };
    render(<FilesPanelV2 files={[source, { ...source, id: "two", name: "pending.txt", status: "processing" },
      { ...source, id: "three", name: "failed.txt", status: "failed", mutation: "error" }]}
      onSave={onSave} onUse={onUse} />);
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.getByText("Processing…")).toBeVisible();
    expect(screen.getByRole("link", { name: "Download report.md" })).toHaveAttribute("download");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("The file action failed.");
    fireEvent.click(screen.getByRole("button", { name: "More actions for report.md" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save file" }));
    expect(onSave).toHaveBeenCalledWith("one");
  });

  it("explains failed processing, disables an unavailable chat action, and retries load failure", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <FilesPanelV2
        files={[{
          byteSize: 214000,
          canOpenChat: true,
          chatId: "chat",
          chatTitle: "Quarterly brief",
          createdAt: "2026-09-21T14:00:00.000Z",
          id: "upload",
          savedAt: null,
          name: "source.csv",
          status: "failed"
        }]}
      />
    );
    expect(screen.getByText("Text processing failed. You can still download the file or use it in Workspace.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More actions for source.csv" }));
    expect(screen.getByRole("menuitem", { name: "Open in chat" })).toBeDisabled();

    rerender(<FilesPanelV2 files={[]} loadState="error" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Files could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
