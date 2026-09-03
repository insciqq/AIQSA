import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeBaseSummary } from "@/lib/contracts/knowledge";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

function knowledgeBase(id: string, name: string): KnowledgeBaseSummary {
  return {
    archived: false,
    deletionPending: false,
    description: "",
    sourceCount: 1,
    id,
    name,
    owned: true,
    ownerDisplayName: "Owner",
    purgeScheduledAt: null,
    readiness: {
      attentionSources: 0,
      processingSources: 0,
      readySources: 1,
      state: "ready",
      supportReference: null,
      totalSources: 1
    },
    scope: { kind: "owner" },
    trashed: false,
    trashedAt: null,
    updatedAt: "2026-08-08T12:00:00.000Z",
    version: 1
  };
}

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
        saving={false}
        onCancel={onCancel}
        onSave={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Close Default Knowledge" })).toHaveFocus());
    expect(screen.getByRole("heading", { name: "Default Knowledge" })).toBeVisible();
    expect(screen.getByText(/Used for future runs in this folder/u)).toBeVisible();
    expect(screen.queryByText(/this project/u)).toBeNull();

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
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
        restoreFocus={() => fallback}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Close Default Knowledge" })).toHaveFocus());
    trigger.style.display = "none";

    view.unmount();

    expect(fallback).toHaveFocus();
    trigger.remove();
    fallback.remove();
  });

  it("does not expose legacy Project Memory or treat it as a dirty setting", () => {
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
        saving={false}
        onCancel={onCancel}
        onSave={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("Project instructions")).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved memory|Draft memory|Project Memory/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Default Knowledge" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("routes backdrop dismissal through the clean close path when only legacy memory differs", () => {
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
        saving={false}
        onCancel={onCancel}
        onSave={vi.fn()}
      />
    );

    const projectDialog = screen.getByRole("dialog", { name: "Default Knowledge for Research" });
    fireEvent.mouseDown(projectDialog.parentElement!);

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps focus in the dirty confirmation and restores it to project settings", async () => {
    const onCancel = vi.fn();

    render(
      <ProjectSettingsDialog
        folder={{
          defaultKnowledgePlan: {
            baseIds: ["retained"], mode: "explicit", sourceIds: [], version: 1
          },
          id: "folder-1",
          name: "Research",
          parentId: null,
          projectMemory: "",
          sortOrder: 0
        }}
        knowledgeBaseIds={["retained", "active"]}
        knowledgeBases={[knowledgeBase("active", "Policies")]}
        saving={false}
        onCancel={onCancel}
        onSave={vi.fn()}
      />
    );

    const closeProjectSettings = screen.getByRole("button", { name: "Close Default Knowledge" });
    await waitFor(() => expect(closeProjectSettings).toHaveFocus());
    fireEvent.click(closeProjectSettings);

    const keepEditing = screen.getByRole("button", { name: "Keep editing" });
    const discardChanges = screen.getByRole("button", { name: "Confirm discard changes" });
    await waitFor(() => expect(keepEditing).toHaveFocus());
    expect(screen.getByLabelText("Default Knowledge for Research", { selector: "div" })).toHaveAttribute(
      "aria-hidden",
      "true"
    );

    fireEvent.keyDown(keepEditing, { key: "Tab", shiftKey: true });
    expect(discardChanges).toHaveFocus();
    fireEvent.keyDown(discardChanges, { key: "Tab" });
    expect(keepEditing).toHaveFocus();

    fireEvent.keyDown(keepEditing, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Discard Default Knowledge changes" })).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    expect(closeProjectSettings).toHaveFocus();
  });

  it("keeps every close path locked during save without exposing legacy Project Memory", async () => {
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
        saving
        onCancel={onCancel}
        onSave={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Default Knowledge for Research" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Close Default Knowledge" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.queryByLabelText("Project instructions")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement!);

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Discard Default Knowledge changes" })).not.toBeInTheDocument();
  });

  it("shows the ordered project Knowledge default and guards it as a dirty edit", () => {
    const onKnowledgeBaseIdsChange = vi.fn();
    render(
      <ProjectSettingsDialog
        folder={{
          defaultKnowledgePlan: {
            baseIds: ["retained"], mode: "explicit", sourceIds: [], version: 1
          },
          id: "folder-1",
          name: "Research",
          parentId: null,
          projectMemory: "",
          sortOrder: 0
        }}
        knowledgeBaseIds={["retained", "active"]}
        knowledgeBases={[knowledgeBase("active", "Policies")]}
        saving={false}
        onCancel={vi.fn()}
        onKnowledgeBaseIdsChange={onKnowledgeBaseIdsChange}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByText("Unavailable base · selection retained · order 1")).toBeVisible();
    const activeLabel = screen.getByText(/Policies.*order 2/).closest("label");
    fireEvent.click(within(activeLabel!).getByRole("checkbox"));
    expect(onKnowledgeBaseIdsChange).toHaveBeenCalledWith(["retained"]);
    fireEvent.click(screen.getByRole("button", { name: "Close Default Knowledge" }));
    expect(screen.getByRole("dialog", { name: "Discard Default Knowledge changes" })).toBeVisible();
  });

  it("shows a project Knowledge load error with a retry action", () => {
    const onRetryKnowledge = vi.fn();
    render(
      <ProjectSettingsDialog
        folder={{
          id: "folder-1",
          name: "Research",
          parentId: null,
          projectMemory: "",
          sortOrder: 0
        }}
        knowledgeDataError="Knowledge catalog failed."
        knowledgeDataState="error"
        saving={false}
        onCancel={vi.fn()}
        onRetryKnowledge={onRetryKnowledge}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Knowledge catalog failed.");
    expect(screen.queryByText(/No Knowledge bases are available/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry Knowledge" }));
    expect(onRetryKnowledge).toHaveBeenCalledOnce();
  });
});
