import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

describe("ProjectSettingsDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("focuses on open, closes on Escape, and restores prior focus on unmount", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open project";
    document.body.appendChild(trigger);
    trigger.focus();
    const onCancel = vi.fn();
    const view = render(
      <ProjectSettingsDialog
        folder={{
          id: "folder-1",
          name: "Research",
          parentId: null,
          projectMemory: "",
          sortOrder: 0
        }}
        memoryDraft=""
        saving={false}
        onCancel={onCancel}
        onMemoryDraftChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Close project settings" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();

    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("restores a durable fallback when a responsive breakpoint hides its opener", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Mobile project opener";
    document.body.appendChild(trigger);
    const fallback = document.createElement("button");
    fallback.textContent = "Desktop project fallback";
    document.body.appendChild(fallback);
    trigger.focus();
    const view = render(
      <ProjectSettingsDialog
        folder={{
          id: "folder-1",
          name: "Research",
          parentId: null,
          projectMemory: "",
          sortOrder: 0
        }}
        memoryDraft=""
        saving={false}
        onCancel={vi.fn()}
        onMemoryDraftChange={vi.fn()}
        onSave={vi.fn()}
        restoreFocus={() => fallback}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Close project settings" })).toHaveFocus());
    trigger.style.display = "none";

    view.unmount();

    expect(fallback).toHaveFocus();
    trigger.remove();
    fallback.remove();
  });

  it("asks in a shell dialog before closing with unsaved project memory edits", () => {
    const onCancel = vi.fn();

    render(
      <ProjectSettingsDialog
        folder={{
          id: "folder-1",
          name: "Research",
          parentId: null,
          projectMemory: "Saved memory",
          sortOrder: 0
        }}
        memoryDraft="Draft memory"
        saving={false}
        onCancel={onCancel}
        onMemoryDraftChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Close project settings" }));
    expect(screen.getByRole("dialog", { name: "Discard project settings changes" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close project settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("routes backdrop dismissal through the dirty-state guard", () => {
    const onCancel = vi.fn();

    render(
      <ProjectSettingsDialog
        folder={{
          id: "folder-1",
          name: "Research",
          parentId: null,
          projectMemory: "Saved memory",
          sortOrder: 0
        }}
        memoryDraft="Draft memory"
        saving={false}
        onCancel={onCancel}
        onMemoryDraftChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    const projectDialog = screen.getByRole("dialog", { name: "Project Settings Research" });
    fireEvent.mouseDown(projectDialog.parentElement!);

    expect(screen.getByRole("dialog", { name: "Discard project settings changes" })).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps focus in the dirty confirmation and restores it to project settings", async () => {
    const onCancel = vi.fn();

    render(
      <ProjectSettingsDialog
        folder={{
          id: "folder-1",
          name: "Research",
          parentId: null,
          projectMemory: "Saved memory",
          sortOrder: 0
        }}
        memoryDraft="Draft memory"
        saving={false}
        onCancel={onCancel}
        onMemoryDraftChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    const closeProjectSettings = screen.getByRole("button", { name: "Close project settings" });
    await waitFor(() => expect(closeProjectSettings).toHaveFocus());
    fireEvent.click(closeProjectSettings);

    const keepEditing = screen.getByRole("button", { name: "Keep editing" });
    const discardChanges = screen.getByRole("button", { name: "Confirm discard changes" });
    await waitFor(() => expect(keepEditing).toHaveFocus());
    expect(screen.getByLabelText("Project Settings Research", { selector: "div" })).toHaveAttribute(
      "aria-hidden",
      "true"
    );

    fireEvent.keyDown(keepEditing, { key: "Tab", shiftKey: true });
    expect(discardChanges).toHaveFocus();
    fireEvent.keyDown(discardChanges, { key: "Tab" });
    expect(keepEditing).toHaveFocus();

    fireEvent.keyDown(keepEditing, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Discard project settings changes" })).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    expect(closeProjectSettings).toHaveFocus();
  });

  it("locks edits and every close path while project memory is saving", async () => {
    const onCancel = vi.fn();

    render(
      <ProjectSettingsDialog
        folder={{
          id: "folder-1",
          name: "Research",
          parentId: null,
          projectMemory: "Saved memory",
          sortOrder: 0
        }}
        memoryDraft="Draft memory"
        saving
        onCancel={onCancel}
        onMemoryDraftChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Project Settings Research" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Close project settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByLabelText("Project memory")).toBeDisabled();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement!);

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Discard project settings changes" })).not.toBeInTheDocument();
  });
});
