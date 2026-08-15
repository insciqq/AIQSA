import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantsPanelV2, FilesPanelV2, LibraryV2, MemoryPanelV2 } from "./LibraryV2";
import type { LibraryNavigationGuardV2 } from "./contracts";

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
        memory={{
          administratorDisabled: true,
          automaticLearning: false,
          disabledReason: "Policy disabled",
          explicitCrudAvailable: true,
          facts: [{ id: "fact", scope: "Global", statement: "Prefers compact answers" }],
          healthDetail: "Recall stopped",
          healthLabel: "Memory does not participate",
          referenceChatHistory: false,
          useMemoryFacts: false
        }}
        onManage={onManage}
      />
    );

    expect(screen.getByText("Memory is disabled by the administrator")).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toEqual([
      expect.objectContaining({ disabled: true }),
      expect.objectContaining({ disabled: true }),
      expect.objectContaining({ disabled: true })
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Manage memories" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(screen.queryByText(/temperature|profile/i)).not.toBeInTheDocument();
  });

  it("labels uploads private without advertising disabled generated files", () => {
    render(
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
    expect(screen.getByText("Files are private and visible only to you.")).toBeInTheDocument();
    expect(screen.getByText("Upload · Private")).toBeInTheDocument();
    expect(screen.queryByText(/generated files/i)).not.toBeInTheDocument();
  });
});
