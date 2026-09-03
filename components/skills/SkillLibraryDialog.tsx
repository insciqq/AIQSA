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
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
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

type SkillLibraryContentProps = Readonly<{
  mode: "picker" | "section";
  onSelectionChange(skillIds: readonly string[]): void;
  selectedIds: readonly string[];
}>;

const emptyDraft: SkillDraft = { description: "", instructions: "", name: "" };

function scopeLabel(skill: SkillSummary): string {
  if (skill.owned) return "Yours";
  if (skill.scope.kind === "workspace") {
    return skill.scope.workspaceNames.join(", ") || "Shared Workspace";
  }
  return "Shared with everyone";
}

function updatedLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
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

function SkillLibraryContent({ mode, onSelectionChange, selectedIds }: SkillLibraryContentProps) {
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

  useEffect(() => {
    void refreshSkillLibrary(true, "").catch(() => undefined);
  }, []);

  useEffect(() => () => {
    detailRequest.current += 1;
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
  const detailOpen = detailLoading || Boolean(detail) || Boolean(editor);

  function closeDetail(): void {
    detailRequest.current += 1;
    setDetailLoading(false);
    setDetail(null);
    setEditor(null);
    setConfirmDelete(false);
    setActionError(null);
  }

  function startNew(): void {
    detailRequest.current += 1;
    setActionError(null);
    setNotice(null);
    setConfirmDelete(false);
    setDetailLoading(false);
    setDetail(null);
    setEditor(editorFor(null));
  }

  function toggle(skill: SkillSummary | SkillDetail): void {
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
    setDetail(null);
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

  async function saveEditor(): Promise<void> {
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
    <div
      className="v2-skill-library"
      data-detail-open={detailOpen || undefined}
      data-mode={mode}
      data-testid={`skill-library-${mode}`}
    >
      <header className="v2-skill-heading">
        <div className="v2-skill-heading-copy">
          <h2>Skills</h2>
          <p>Reusable text instructions you can add to a conversation in a deliberate order.</p>
        </div>
        <div className="v2-skill-heading-actions">
          <label className="v2-resource-search v2-skill-search">
            <UiV2Icon name="search" />
            <input
              aria-label="Search Skills"
              placeholder="Search Skills…"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <UiV2Button disabled={busy} icon="plus" tone="primary" onClick={startNew}>
            New Skill
          </UiV2Button>
        </div>
        <p className="v2-skill-selection-summary">
          {selectedIds.length} selected · up to {SKILL_MAX_SELECTED}. Selection order is preserved.
        </p>
      </header>

      {actionError ? <p className="v2-skill-feedback" data-tone="danger" role="alert">{actionError}</p> : null}
      {notice ? <p className="v2-skill-feedback" data-tone="ok" role="status">{notice}</p> : null}

      <div className="v2-skill-layout">
        <section className="v2-skill-list-pane" aria-label="Skill library">
          {loadState === "loading" && !data ? (
            <p className="v2-skill-state" role="status">Loading Skills…</p>
          ) : loadState === "error" && !data ? (
            <div className="v2-skill-state" role="alert">
              <p>Skills could not be loaded.</p>
              <UiV2Button onClick={() => void refreshSkillLibrary(true, query).catch(() => undefined)}>
                Try again
              </UiV2Button>
            </div>
          ) : skills.length === 0 ? (
            <div className="v2-skill-state">
              <strong>{query ? "No matching Skills" : "No Skills yet"}</strong>
              <p>Create a focused workflow with plain-text instructions.</p>
            </div>
          ) : (
            <>
              {loadState === "loading" ? (
                <p className="v2-skill-searching" role="status">Searching…</p>
              ) : null}
              <ul className="v2-skill-list" aria-label="Available Skills">
                {skills.map((skill) => {
                  const selected = selectedSet.has(skill.id);
                  const selectedOrder = selectedIds.indexOf(skill.id) + 1;
                  const atLimit = !selected && selectedIds.length >= SKILL_MAX_SELECTED;
                  const active = detail?.id === skill.id || editor?.source?.id === skill.id;
                  return (
                    <li className="v2-skill-row" data-active={active || undefined} key={skill.id}>
                      <span className="v2-skill-row-icon" aria-hidden="true"><UiV2Icon name="wand" /></span>
                      <button
                        aria-label={`Open ${skill.name}`}
                        className="v2-skill-row-open v2-focusable"
                        type="button"
                        onClick={() => void openDetail(skill)}
                      >
                        <span className="v2-skill-row-title">
                          <strong>{skill.name}</strong>
                          {skill.archived ? <small>Archived</small> : null}
                        </span>
                        <span className="v2-skill-row-description">{skill.description || "No description"}</span>
                        <small className="v2-skill-row-meta">
                          {scopeLabel(skill)} · By {skill.ownerDisplayName} · Updated {updatedLabel(skill.updatedAt)}
                          {selected ? ` · Selected ${selectedOrder}` : ""}
                        </small>
                      </button>
                      <UiV2Button
                        aria-label={`${selected ? "Remove" : "Use"} ${skill.name}`}
                        aria-pressed={selected}
                        className="v2-skill-select"
                        disabled={skill.archived || atLimit || busy}
                        onClick={() => toggle(skill)}
                      >
                        {selected ? "Remove" : "Use"}
                      </UiV2Button>
                    </li>
                  );
                })}
              </ul>
              {data?.nextCursor ? (
                <div className="v2-skill-load-more">
                  <UiV2Button busy={loadingMore} onClick={() => void loadMoreSkillLibrary().catch(() => undefined)}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </UiV2Button>
                  {moreError ? <p>More Skills could not be loaded.</p> : null}
                </div>
              ) : null}
            </>
          )}
        </section>

        <section className="v2-skill-detail-pane" aria-label="Skill detail">
          {detailOpen ? (
            <UiV2Button className="v2-skill-detail-back" icon="arrow-left" onClick={closeDetail}>
              Back to Skills
            </UiV2Button>
          ) : null}
          {detailLoading ? (
            <p className="v2-skill-state" role="status">Loading Skill…</p>
          ) : editor ? (
            <div className="v2-skill-detail">
              <div className="v2-skill-detail-heading">
                <div>
                  <h3>{editor.source ? "Edit Skill" : "New Skill"}</h3>
                  <p>Changes apply to future uses; existing conversations stay unchanged.</p>
                </div>
                <UiV2Button onClick={() => setEditor(null)}>Cancel</UiV2Button>
              </div>
              <label className="v2-skill-field">
                <span>Name</span>
                <input
                  autoFocus
                  className="v2-focusable"
                  maxLength={SKILL_NAME_MAX_LENGTH}
                  value={editor.draft.name}
                  onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, name: event.target.value } })}
                />
              </label>
              <label className="v2-skill-field">
                <span>Description</span>
                <textarea
                  className="v2-focusable"
                  maxLength={SKILL_DESCRIPTION_MAX_LENGTH}
                  rows={3}
                  value={editor.draft.description}
                  onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, description: event.target.value } })}
                />
              </label>
              <label className="v2-skill-field">
                <span>Instructions</span>
                <textarea
                  className="v2-focusable"
                  data-instructions="true"
                  maxLength={SKILL_INSTRUCTIONS_MAX_LENGTH}
                  placeholder="Describe the workflow, decision points, and expected result."
                  rows={12}
                  value={editor.draft.instructions}
                  onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, instructions: event.target.value } })}
                />
              </label>
              <div className="v2-skill-actions">
                <UiV2Button busy={busy} tone="primary" onClick={() => void saveEditor()}>
                  {busy ? "Saving…" : editor.source ? "Save changes" : "Create Skill"}
                </UiV2Button>
                {editor.source ? (
                  <UiV2Button disabled={busy} onClick={() => void toggleArchived()}>
                    {editor.source.archived ? "Restore" : "Archive"}
                  </UiV2Button>
                ) : null}
              </div>
            </div>
          ) : detail ? (
            <div className="v2-skill-detail">
              <div className="v2-skill-detail-heading">
                <div>
                  <p className="v2-skill-eyebrow">{scopeLabel(detail)}</p>
                  <h3>{detail.name}</h3>
                  <p>By {detail.owner.displayName}</p>
                </div>
                <UiV2Button
                  disabled={detail.archived || (!selectedSet.has(detail.id) && selectedIds.length >= SKILL_MAX_SELECTED)}
                  tone="primary"
                  onClick={() => toggle(detail)}
                >
                  {selectedSet.has(detail.id) ? "Remove" : "Use"}
                </UiV2Button>
              </div>
              {detail.description ? <p className="v2-skill-description">{detail.description}</p> : null}
              <div className="v2-skill-detail-section">
                <h4>Instructions</h4>
                <pre>{detail.instructions}</pre>
              </div>

              <div className="v2-skill-detail-section">
                <h4>Current audiences</h4>
                {detail.audiences.length === 0 ? (
                  <p>{detail.owned ? "Only you can use this Skill." : "Available through its owner."}</p>
                ) : (
                  <ul className="v2-skill-audiences">
                    {detail.audiences.map((audience) => (
                      <li key={audience.id}>
                        <span>
                          {audience.name}
                          {audience.kind === "project" ? <small>Project details remain private</small> : null}
                        </span>
                        {detail.owned && detail.canUnshare ? (
                          <UiV2Button disabled={busy} tone="destructive" onClick={() => void unshare(detail, audience.id)}>
                            Unshare
                          </UiV2Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {detail.owned ? (
                <>
                  <div className="v2-skill-actions v2-skill-detail-section">
                    {detail.canEdit ? <UiV2Button onClick={() => setEditor(editorFor(detail))}>Edit</UiV2Button> : null}
                    {detail.archived ? (
                      <UiV2Button disabled={busy} onClick={() => void restoreArchived(detail)}>Restore</UiV2Button>
                    ) : null}
                  </div>

                  {detail.canPublish && !detail.archived && data ? (
                    <div className="v2-skill-detail-section">
                      <h4>Add audience</h4>
                      <div className="v2-skill-actions">
                        {data.publishableWorkspaces
                          .filter((workspace) => !detail.audiences.some(
                            (audience) => audience.kind === "workspace" && audience.workspaceId === workspace.id
                          ))
                          .map((workspace) => (
                            <UiV2Button
                              disabled={busy}
                              key={workspace.id}
                              onClick={() => void share(detail, {
                                scope: "workspace",
                                workspaceId: workspace.id
                              }, `Shared with ${workspace.name}.`)}
                            >
                              {workspace.name}
                            </UiV2Button>
                          ))}
                        {data.viewer.canPublishInstallation &&
                        !detail.audiences.some((audience) => audience.kind === "everyone") ? (
                          <UiV2Button
                            disabled={busy}
                            onClick={() => void share(detail, { scope: "installation" }, "Shared with everyone.")}
                          >
                            Everyone
                          </UiV2Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {detail.canDelete ? (
                    <div className="v2-skill-danger v2-skill-detail-section">
                      <h4>Delete Skill</h4>
                      {!confirmDelete ? (
                        <UiV2Button tone="destructive" onClick={() => setConfirmDelete(true)}>Delete…</UiV2Button>
                      ) : (
                        <div className="v2-skill-delete-confirmation">
                          <strong>Delete “{detail.name}”?</strong>
                          <p>
                            It is used by {detail.assistantUsageCount} {detail.assistantUsageCount === 1 ? "Assistant" : "Assistants"}
                            {detail.workspaceUsageCount > 0
                              ? ` and shared with ${detail.workspaceUsageCount} ${detail.workspaceUsageCount === 1 ? "Workspace" : "Workspaces"}`
                              : ""}. Deleting removes those links and audiences. Existing conversations stay recoverable.
                          </p>
                          <div className="v2-skill-actions">
                            <UiV2Button busy={busy} tone="destructive" onClick={() => void removePermanently(detail)}>
                              {busy ? "Deleting…" : "Delete Skill"}
                            </UiV2Button>
                            <UiV2Button disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</UiV2Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : (
            <div className="v2-skill-state v2-skill-detail-empty">
              <UiV2Icon name="wand" />
              <strong>Choose a Skill to inspect</strong>
              <p>Skills are text-only. They do not install tools, run code, or start MCP servers.</p>
              {error ? <p data-tone="danger">{actionErrorMessage(new Error(error))}</p> : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function SkillLibrarySection({
  onSelectionChange,
  selectedIds
}: Omit<SkillLibraryContentProps, "mode">) {
  return (
    <SkillLibraryContent
      mode="section"
      onSelectionChange={onSelectionChange}
      selectedIds={selectedIds}
    />
  );
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
  const dialogRef = useDialogFocus<HTMLDivElement>({ active: true, onClose });

  return (
    <div
      className="v2-skill-dialog-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} aria-label="Skills" aria-modal="true" className="v2-skill-dialog" role="dialog">
        <header className="v2-skill-dialog-header">
          <div>
            <strong>Choose Skills</strong>
            <span>Manual Skills stay separate from Assistant-included Skills.</span>
          </div>
          <UiV2IconButton icon="close" label="Close Skills" onClick={onClose} />
        </header>
        <SkillLibraryContent
          mode="picker"
          onSelectionChange={onSelectionChange}
          selectedIds={selectedIds}
        />
      </div>
    </div>
  );
}
