"use client";

import {
  createSkill,
  deleteSkill,
  loadMoreSkillLibrary,
  loadSkillDetail,
  publishSkill,
  refreshSkillLibrary,
  reviseSkill,
  setSkillArchived,
  unshareSkill,
  useSkillLibraryStore
} from "@/components/app-shell/skillLibraryStore";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_INSTRUCTIONS_MAX_LENGTH,
  SKILL_MAX_SELECTED,
  SKILL_NAME_MAX_LENGTH,
  type SkillDraft,
  type SkillDetail,
  type SkillSummary
} from "@/lib/contracts/skills";
import { useEffect, useRef, useState } from "react";

type EditorState = {
  draft: SkillDraft;
  source: SkillDetail | null;
};

const emptyDraft: SkillDraft = { description: "", instructions: "", name: "" };

function scopeLabel(skill: SkillSummary): string {
  if (skill.owned) return "Yours";
  if (skill.scope.kind === "workspace") {
    return skill.scope.workspaceNames.join(", ") || "Shared Workspace";
  }
  return "Shared with everyone";
}

function editorFor(skill: SkillDetail | null): EditorState {
  return {
    draft: skill
      ? {
          description: skill.description,
          instructions: skill.instructions,
          name: skill.name
        }
      : { ...emptyDraft },
    source: skill
  };
}

function actionErrorMessage(failure: unknown): string {
  const code = failure instanceof Error ? failure.message : "skill_request_failed";
  if (code === "skill_publication_in_use") {
    return "This audience is required by a shared Assistant. Change that Assistant before unsharing the Skill.";
  }
  if (code === "skill_not_available") {
    return "This Skill is no longer available.";
  }
  return code.replaceAll("_", " ");
}

export function SkillLibraryDialog({
  onClose,
  onSelectionChange,
  selectedIds
}: Readonly<{
  onClose(): void;
  onSelectionChange(skillIds: readonly string[]): void;
  selectedIds: readonly string[];
}>) {
  const data = useSkillLibraryStore((state) => state.data);
  const error = useSkillLibraryStore((state) => state.error);
  const loadingMore = useSkillLibraryStore((state) => state.loadingMore);
  const loadState = useSkillLibraryStore((state) => state.loadState);
  const moreError = useSkillLibraryStore((state) => state.moreError);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const searchMounted = useRef(false);
  const detailRequest = useRef(0);
  const dialogRef = useDialogFocus<HTMLDivElement>({ active: true, onClose });

  useEffect(() => {
    void refreshSkillLibrary(true, "").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!searchMounted.current) {
      searchMounted.current = true;
      return;
    }
    const timeout = window.setTimeout(() => {
      void refreshSkillLibrary(true, query).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const skills = data?.skills ?? [];
  const selectedSet = new Set(selectedIds);

  function toggle(skill: SkillSummary | SkillDetail) {
    if (skill.archived) return;
    const nextIds = selectedSet.has(skill.id)
      ? selectedIds.filter((id) => id !== skill.id)
      : selectedIds.length < SKILL_MAX_SELECTED
        ? [...selectedIds, skill.id]
        : selectedIds;
    onSelectionChange(nextIds);
  }

  async function openDetail(skill: SkillSummary): Promise<void> {
    const requestId = ++detailRequest.current;
    setDetailLoading(true);
    setActionError(null);
    setNotice(null);
    setConfirmDelete(false);
    setEditor(null);
    try {
      const loaded = await loadSkillDetail(skill.id);
      if (requestId === detailRequest.current) setDetail(loaded);
    } catch (failure) {
      if (requestId !== detailRequest.current) return;
      setDetail(null);
      setActionError(actionErrorMessage(failure));
      if (failure instanceof Error && failure.message === "skill_not_available") {
        onSelectionChange(selectedIds.filter((id) => id !== skill.id));
      }
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }

  async function reloadDetail(skillId: string): Promise<void> {
    const loaded = await loadSkillDetail(skillId);
    setDetail(loaded);
  }

  async function runAction(action: () => Promise<void>, success?: string): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      return true;
    } catch (failure) {
      setActionError(actionErrorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveEditor() {
    if (!editor) return;
    const draft = {
      description: editor.draft.description.trim(),
      instructions: editor.draft.instructions.trim(),
      name: editor.draft.name.trim()
    };
    if (!draft.name || !draft.instructions) {
      setActionError("Name and instructions are required.");
      return;
    }
    if (editor.source) {
      const source = editor.source;
      const saved = await runAction(async () => {
        await reviseSkill(source, draft);
        await reloadDetail(source.id);
      }, "Skill updated.");
      if (saved) setEditor(null);
      return;
    }
    const saved = await runAction(() => createSkill(draft), "Skill created.");
    if (saved) setEditor(null);
  }

  async function share(
    skill: SkillDetail,
    publication: { scope: "installation" } | { scope: "workspace"; workspaceId: string },
    success: string
  ): Promise<void> {
    await runAction(async () => {
      await publishSkill(skill.id, publication);
      await reloadDetail(skill.id);
    }, success);
  }

  async function toggleArchived(): Promise<void> {
    const source = editor?.source;
    if (!source) return;
    const changed = await runAction(async () => {
      await setSkillArchived(source, !source.archived);
      await reloadDetail(source.id);
    }, source.archived ? "Skill restored." : "Skill archived.");
    if (changed) setEditor(null);
  }

  async function restoreArchived(skill: SkillDetail): Promise<void> {
    await runAction(async () => {
      await setSkillArchived(skill, false);
      await reloadDetail(skill.id);
    }, "Skill restored.");
  }

  async function unshare(skill: SkillDetail, publicationId: string): Promise<void> {
    await runAction(async () => {
      await unshareSkill(skill.id, publicationId);
      await reloadDetail(skill.id);
    }, "Audience removed.");
  }

  async function removePermanently(skill: SkillDetail): Promise<void> {
    const removed = await runAction(() => deleteSkill(skill.id), "Skill deleted.");
    if (!removed) return;
    onSelectionChange(selectedIds.filter((id) => id !== skill.id));
    setConfirmDelete(false);
    setDetail(null);
    setEditor(null);
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/35 p-0 sm:items-center sm:p-6" role="presentation">
      <div
        ref={dialogRef}
        aria-label="Skills"
        aria-modal="true"
        className="flex h-[94dvh] w-full max-w-5xl flex-col overflow-hidden rounded-t-2xl border border-line bg-canvas shadow-2xl sm:h-[min(780px,90dvh)] sm:rounded-2xl"
        role="dialog"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-ink">Skills</h2>
            <p className="mt-0.5 text-xs text-ink-muted">Reusable text instructions for a conversation.</p>
          </div>
          <button
            className="v2-focusable rounded-lg bg-proof px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy}
            type="button"
            onClick={() => {
              setActionError(null);
              setConfirmDelete(false);
              setDetail(null);
              setEditor(editorFor(null));
            }}
          >
            New Skill
          </button>
          <UiV2IconButton icon="close" label="Close Skills" onClick={onClose} />
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_minmax(340px,0.82fr)] md:grid-rows-1">
          <section className="flex min-h-0 flex-col border-line md:border-r" aria-label="Skill library">
            <div className="border-b border-line p-4">
              <label className="relative block">
                <span className="sr-only">Search Skills</span>
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
                  <UiV2Icon name="search" />
                </span>
                <input
                  className="v2-focusable w-full rounded-xl border border-line bg-surface py-2.5 pl-9 pr-3 text-sm text-ink"
                  placeholder="Search name, description, or author"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <p className="mt-2 text-xs text-ink-muted">
                {selectedIds.length} selected · up to {SKILL_MAX_SELECTED}. Selection order is preserved.
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
              {loadState === "loading" && !data ? (
                <p className="p-4 text-sm text-ink-muted">Loading Skills…</p>
              ) : loadState === "error" && !data ? (
                <div className="p-4 text-sm">
                  <p className="text-critical">Skills could not be loaded.</p>
                  <button
                    className="v2-focusable mt-3 text-proof"
                    type="button"
                    onClick={() => void refreshSkillLibrary(true, query).catch(() => undefined)}
                  >
                    Try again
                  </button>
                </div>
              ) : skills.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-sm font-semibold text-ink">{query ? "No matching Skills" : "No Skills yet"}</p>
                  <p className="mt-1 text-xs text-ink-muted">Create a focused workflow with plain-text instructions.</p>
                </div>
              ) : (
                <>
                  {loadState === "loading" ? (
                    <p className="px-3 pb-2 text-xs text-ink-muted" role="status">Searching…</p>
                  ) : null}
                  <ul className="space-y-1" aria-label="Available Skills">
                    {skills.map((skill) => {
                      const selected = selectedSet.has(skill.id);
                      const selectedOrder = selectedIds.indexOf(skill.id) + 1;
                      const atLimit = !selected && selectedIds.length >= SKILL_MAX_SELECTED;
                      const active = detail?.id === skill.id || editor?.source?.id === skill.id;
                      return (
                        <li
                          key={skill.id}
                          className="group flex items-start gap-3 rounded-xl px-3 py-3 hover:bg-surface"
                          data-active={active ? "true" : undefined}
                        >
                          <button
                            aria-label={`${selected ? "Remove" : "Use"} ${skill.name}`}
                            aria-pressed={selected}
                            className="v2-focusable min-w-16 shrink-0 rounded-lg border border-line px-2 py-1.5 text-xs font-medium text-proof disabled:opacity-40"
                            disabled={skill.archived || atLimit || busy}
                            type="button"
                            onClick={() => toggle(skill)}
                          >
                            {selected ? "Remove" : "Use"}
                          </button>
                          <button
                            aria-label={`Open ${skill.name}`}
                            className="v2-focusable min-w-0 flex-1 text-left"
                            type="button"
                            onClick={() => void openDetail(skill)}
                          >
                            <span className="flex items-center gap-2">
                              <strong className="truncate text-sm text-ink">{skill.name}</strong>
                              {skill.archived ? <span className="text-metadata text-ink-muted">Archived</span> : null}
                            </span>
                            <span className="mt-1 line-clamp-2 block text-xs leading-5 text-ink-secondary">
                              {skill.description || "No description"}
                            </span>
                            <span className="mt-1 block text-metadata text-ink-muted">
                              {scopeLabel(skill)} · {skill.ownerDisplayName}
                              {selected ? ` · selected ${selectedOrder}` : ""}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {data?.nextCursor ? (
                    <div className="px-3 py-4 text-center">
                      <button
                        className="v2-focusable rounded-lg border border-line px-4 py-2 text-xs font-medium text-ink-secondary disabled:opacity-50"
                        disabled={loadingMore}
                        type="button"
                        onClick={() => void loadMoreSkillLibrary().catch(() => undefined)}
                      >
                        {loadingMore ? "Loading…" : "Load more"}
                      </button>
                      {moreError ? <p className="mt-2 text-xs text-critical">More Skills could not be loaded.</p> : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </section>

          <section className="min-h-0 overflow-y-auto bg-surface/45 p-4 sm:p-6" aria-label="Skill detail">
            {actionError ? <p className="mb-4 text-xs text-critical" role="alert">{actionError}</p> : null}
            {notice ? <p className="mb-4 text-xs text-proof" role="status">{notice}</p> : null}
            {detailLoading ? (
              <p className="text-sm text-ink-muted">Loading Skill…</p>
            ) : editor ? (
              <div className="mx-auto max-w-lg">
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-ink">{editor.source ? "Edit Skill" : "New Skill"}</h3>
                    <p className="mt-1 text-xs text-ink-muted">
                      Changes apply to future uses; existing conversations stay unchanged.
                    </p>
                  </div>
                  <button
                    className="v2-focusable text-xs text-ink-muted"
                    type="button"
                    onClick={() => setEditor(null)}
                  >
                    Cancel
                  </button>
                </div>
                <label className="block text-xs font-medium text-ink-secondary">
                  Name
                  <input
                    autoFocus
                    className="v2-focusable mt-1.5 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink"
                    maxLength={SKILL_NAME_MAX_LENGTH}
                    value={editor.draft.name}
                    onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, name: event.target.value } })}
                  />
                </label>
                <label className="mt-4 block text-xs font-medium text-ink-secondary">
                  Description
                  <textarea
                    className="v2-focusable mt-1.5 min-h-20 w-full resize-y rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm leading-5 text-ink"
                    maxLength={SKILL_DESCRIPTION_MAX_LENGTH}
                    value={editor.draft.description}
                    onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, description: event.target.value } })}
                  />
                </label>
                <label className="mt-4 block text-xs font-medium text-ink-secondary">
                  Instructions
                  <textarea
                    className="v2-focusable mt-1.5 min-h-64 w-full resize-y rounded-xl border border-line bg-canvas px-3 py-3 font-mono text-[13px] leading-6 text-ink"
                    maxLength={SKILL_INSTRUCTIONS_MAX_LENGTH}
                    placeholder="Describe the workflow, decision points, and expected result."
                    value={editor.draft.instructions}
                    onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, instructions: event.target.value } })}
                  />
                </label>
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <button
                    className="v2-focusable rounded-lg bg-proof px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    disabled={busy}
                    type="button"
                    onClick={() => void saveEditor()}
                  >
                    {busy ? "Saving…" : editor.source ? "Save changes" : "Create Skill"}
                  </button>
                  {editor.source ? (
                    <button
                      className="v2-focusable rounded-lg px-3 py-2 text-sm text-ink-secondary"
                      disabled={busy}
                      type="button"
                      onClick={() => void toggleArchived()}
                    >
                      {editor.source.archived ? "Restore" : "Archive"}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : detail ? (
              <div className="mx-auto max-w-lg">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-metadata uppercase tracking-wide text-ink-muted">{scopeLabel(detail)}</p>
                    <h3 className="mt-1 text-lg font-semibold text-ink">{detail.name}</h3>
                    <p className="mt-1 text-xs text-ink-muted">By {detail.owner.displayName}</p>
                  </div>
                  <button
                    className="v2-focusable shrink-0 rounded-lg bg-proof px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    disabled={detail.archived || (!selectedSet.has(detail.id) && selectedIds.length >= SKILL_MAX_SELECTED)}
                    type="button"
                    onClick={() => toggle(detail)}
                  >
                    {selectedSet.has(detail.id) ? "Remove" : "Use"}
                  </button>
                </div>
                {detail.description ? (
                  <p className="mt-5 text-sm leading-6 text-ink-secondary">{detail.description}</p>
                ) : null}
                <div className="mt-6 border-t border-line pt-5">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Instructions</h4>
                  <pre className="mt-3 whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-ink">{detail.instructions}</pre>
                </div>

                <div className="mt-7 border-t border-line pt-5">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Current audiences</h4>
                  {detail.audiences.length === 0 ? (
                    <p className="mt-3 text-xs text-ink-muted">
                      {detail.owned ? "Only you can use this Skill." : "Available through its owner."}
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {detail.audiences.map((audience) => (
                        <li key={audience.id} className="flex items-center justify-between gap-3 text-sm text-ink-secondary">
                          <span>
                            {audience.name}
                            {audience.kind === "project" ? <small className="ml-2 text-ink-muted">Project details remain private</small> : null}
                          </span>
                          {detail.owned && detail.canUnshare ? (
                            <button
                              className="v2-focusable rounded-lg px-2 py-1 text-xs text-critical disabled:opacity-50"
                              disabled={busy}
                              type="button"
                              onClick={() => void unshare(detail, audience.id)}
                            >
                              Unshare
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {detail.owned ? (
                  <>
                    <div className="mt-7 flex flex-wrap gap-2 border-t border-line pt-5">
                      {detail.canEdit ? (
                        <button
                          className="v2-focusable rounded-lg border border-line bg-canvas px-3 py-2 text-xs font-medium text-ink-secondary"
                          type="button"
                          onClick={() => setEditor(editorFor(detail))}
                        >
                          Edit
                        </button>
                      ) : null}
                      {detail.archived ? (
                        <button
                          className="v2-focusable rounded-lg border border-line bg-canvas px-3 py-2 text-xs font-medium text-ink-secondary disabled:opacity-50"
                          disabled={busy}
                          type="button"
                          onClick={() => void restoreArchived(detail)}
                        >
                          Restore
                        </button>
                      ) : null}
                    </div>

                    {detail.canPublish && !detail.archived && data ? (
                      <div className="mt-7 border-t border-line pt-5">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Add audience</h4>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {data.publishableWorkspaces
                            .filter((workspace) => !detail.audiences.some(
                              (audience) => audience.kind === "workspace" && audience.workspaceId === workspace.id
                            ))
                            .map((workspace) => (
                              <button
                                key={workspace.id}
                                className="v2-focusable rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-secondary disabled:opacity-50"
                                disabled={busy}
                                type="button"
                                onClick={() => void share(detail, {
                                  scope: "workspace",
                                  workspaceId: workspace.id
                                }, `Shared with ${workspace.name}.`)}
                              >
                                {workspace.name}
                              </button>
                            ))}
                          {data.viewer.canPublishInstallation &&
                          !detail.audiences.some((audience) => audience.kind === "everyone") ? (
                            <button
                              className="v2-focusable rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-secondary disabled:opacity-50"
                              disabled={busy}
                              type="button"
                              onClick={() => void share(detail, { scope: "installation" }, "Shared with everyone.")}
                            >
                              Everyone
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {detail.canDelete ? (
                      <div className="mt-8 border-t border-line pt-5">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-critical">Delete Skill</h4>
                        {!confirmDelete ? (
                          <button
                            className="v2-focusable mt-3 rounded-lg border border-critical/40 px-3 py-2 text-xs font-medium text-critical"
                            type="button"
                            onClick={() => setConfirmDelete(true)}
                          >
                            Delete…
                          </button>
                        ) : (
                          <div className="mt-3">
                            <p className="text-sm font-medium text-ink">Delete “{detail.name}”?</p>
                            <p className="mt-2 text-xs leading-5 text-ink-muted">
                              It is used by {detail.assistantUsageCount} {detail.assistantUsageCount === 1 ? "Assistant" : "Assistants"}
                              {detail.workspaceUsageCount > 0
                                ? ` and shared with ${detail.workspaceUsageCount} ${detail.workspaceUsageCount === 1 ? "Workspace" : "Workspaces"}`
                                : ""}. Deleting removes those links and audiences. Existing conversations stay recoverable.
                            </p>
                            <div className="mt-3 flex gap-2">
                              <button
                                className="v2-focusable rounded-lg bg-critical px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                                disabled={busy}
                                type="button"
                                onClick={() => void removePermanently(detail)}
                              >
                                {busy ? "Deleting…" : "Delete Skill"}
                              </button>
                              <button
                                className="v2-focusable rounded-lg px-3 py-2 text-xs text-ink-secondary"
                                disabled={busy}
                                type="button"
                                onClick={() => setConfirmDelete(false)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : (
              <div className="flex min-h-60 flex-col items-center justify-center text-center">
                <span className="mb-3 text-ink-muted"><UiV2Icon name="book" /></span>
                <p className="text-sm font-semibold text-ink">Choose a Skill to inspect</p>
                <p className="mt-1 max-w-xs text-xs leading-5 text-ink-muted">
                  Skills are text-only. They do not install tools, run code, or start MCP servers.
                </p>
                {error ? <p className="mt-4 text-xs text-critical">{actionErrorMessage(new Error(error))}</p> : null}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
