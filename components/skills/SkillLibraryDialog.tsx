"use client";

import {
  createSkill,
  exportSkills,
  importSkills,
  loadSkillFile,
  deleteSkill,
  loadMoreSkillLibrary,
  loadSkillDetail,
  publishSkill,
  requestSkillApproval,
  refreshSkillLibrary,
  reviseSkill,
  setSkillArchived,
  setSkillEnabled,
  enableAllSkills,
  SkillRequestError,
  skillValidationMessage,
  unshareSkill,
  withdrawSkillApproval,
  useSkillLibraryStore
} from "@/components/app-shell/skillLibraryStore";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_INSTRUCTIONS_MAX_BYTES,
  SKILL_MAX_PINNED,
  resolveEffectiveSkillIds,
  SKILL_NAME_MAX_LENGTH,
  type SkillDraft,
  type SkillDetail,
  type SkillSummary,
  type SkillImportResponse,
  decodeSkillDraft
} from "@/lib/contracts/skills";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { SkillSelectionSummary, type SelectedSkillName } from "./SkillSelectionSummary";
import { skillShareStateLabels, skillSharingErrorMessage } from "./skillSharingPresentation";

type EditorState = {
  draft: SkillDraft;
  source: SkillDetail | null;
};

type SkillLibraryContentProps = Readonly<{
  mode: "picker" | "section";
  modelContextWindow?: number;
  skillsMode?: "auto" | "off";
  availableCount?: number;
  assistantSelection?: boolean;
  selectionLimit?: number;
  includedSkills?: readonly SelectedSkillName[];
  selectedSkills?: readonly SelectedSkillName[];
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
  if (["skill_share_request_not_available", "skill_share_request_conflict", "skill_version_conflict", "skill_archived"].includes(code)) {
    return skillSharingErrorMessage(failure);
  }
  if (failure instanceof SkillRequestError) return skillValidationMessage(failure.issue);
  return code.replaceAll("_", " ");
}

function SkillLibraryContent({ mode, onSelectionChange, selectedIds, includedSkills = [], selectedSkills = [], modelContextWindow, skillsMode = "auto", availableCount, assistantSelection = false, selectionLimit = SKILL_MAX_PINNED }: SkillLibraryContentProps) {
  const data = useSkillLibraryStore((state) => state.data);
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
  const [importResult, setImportResult] = useState<SkillImportResponse | null>(null);
  const [filePreview, setFilePreview] = useState<{ path: string; text: string } | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const fieldId = useId();
  const importInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const detailRequest = useRef(0);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const selectionRef = useRef({ selectedIds, onSelectionChange });
  useLayoutEffect(() => { selectionRef.current = { selectedIds, onSelectionChange }; }, [selectedIds, onSelectionChange]);

  useEffect(() => {
    void refreshSkillLibrary(true, "").catch(() => undefined);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; detailRequest.current += 1; };
  }, []);

  useEffect(() => {
    if (query.trim() === useSkillLibraryStore.getState().query) return;
    const timeout = window.setTimeout(() => {
      void refreshSkillLibrary(true, query).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const skills = data?.skills ?? [];
  const selectedSet = new Set(selectedIds);
  const includedSet = new Set(includedSkills.filter(skill => skill.mode !== "available").map(({ id }) => id));
  const effectiveIds = resolveEffectiveSkillIds([...includedSet], selectedIds);
  const manualSkills = selectedIds.map((id) => selectedSkills.find((skill) => skill.id === id) ?? skills.find((skill) => skill.id === id) ?? { id, name: "Selected Skill" });
  const addActionText = assistantSelection ? "Select" : "Always use";
  const addActionAria = addActionText;
  const removeActionText = assistantSelection ? "Deselect" : "Unpin";
  const removeActionAria = assistantSelection ? "Deselect" : "Stop always using";
  const detailOpen = detailLoading || Boolean(detail) || Boolean(editor);

  function closeDetail(): void {
    detailRequest.current += 1;
    setDetailLoading(false);
    setDetail(null);
    setEditor(null);
    setConfirmDelete(false);
    setActionError(null);
    setFilePreview(null);
    setFieldError(null);
  }

  function startNew(): void {
    detailRequest.current += 1;
    setActionError(null);
    setNotice(null);
    setConfirmDelete(false);
    setDetailLoading(false);
    setDetail(null);
    setEditor(editorFor(null));
    setFieldError(null);
    setFilePreview(null);
  }

  function toggle(skill: SkillSummary | SkillDetail): void {
    if (skill.archived || includedSet.has(skill.id)) return;
    const nextIds = selectedSet.has(skill.id)
      ? selectedIds.filter((id) => id !== skill.id)
      : effectiveIds.includes(skill.id) || effectiveIds.length < selectionLimit
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
    setFilePreview(null);
    setFieldError(null);
    try {
      const loaded = await loadSkillDetail(skill.id);
      if (requestId === detailRequest.current) setDetail(loaded);
    } catch (failure) {
      if (requestId !== detailRequest.current) return;
      setDetail(null);
      setActionError(actionErrorMessage(failure));
      if (failure instanceof Error && failure.message === "skill_not_available") {
        const current = selectionRef.current;
        current.onSelectionChange(current.selectedIds.filter((id) => id !== skill.id));
      }
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }

  async function reloadDetail(skillId: string): Promise<void> {
    const requestId = detailRequest.current;
    const loaded = await loadSkillDetail(skillId);
    if (mounted.current && requestId === detailRequest.current) setDetail(loaded);
  }

  function changeEnabled(skill: SkillSummary, enabled: boolean): void {
    void runAction(async () => {
      const saved = await setSkillEnabled(skill.id, enabled);
      if (mounted.current) setDetail(current => current?.id === skill.id ? { ...current, enabled: saved } : current);
    });
  }

  async function enableAllForAuto(): Promise<void> {
    await runAction(async () => {
      const count = await enableAllSkills();
      if (mounted.current) {
        setDetail(current => current && !current.archived ? { ...current, enabled: true } : current);
        setNotice(`${count} ${count === 1 ? "Skill is" : "Skills are"} enabled for Auto.`);
      }
    });
  }

  async function runAction(action: () => Promise<void>, success?: string): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      if (mounted.current && success) setNotice(success);
      return mounted.current;
    } catch (failure) {
      if (mounted.current) {
        if (editor && failure instanceof SkillRequestError && failure.issue.field && ["name", "description", "instructions"].includes(failure.issue.field)) {
          setFieldError({ field: failure.issue.field, message: actionErrorMessage(failure) });
        } else setActionError(actionErrorMessage(failure));
      }
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function saveEditor(): Promise<void> {
    if (!editor) return;
    setFieldError(null);
    const draft = {
      description: editor.draft.description.trim(),
      instructions: editor.draft.instructions.trim(),
      name: editor.draft.name.trim()
    };
    const validated = decodeSkillDraft(draft);
    if (!validated.ok) {
      const message = validated.code === "skill_field_required" ? `${validated.field} is required.`
        : validated.actual !== undefined && validated.limit !== undefined
          ? `${validated.field}: ${validated.actual.toLocaleString()} exceeds the limit of ${validated.limit.toLocaleString()}.`
          : "Check the Skill fields and try again.";
      setActionError(null);
      setFieldError({ field: validated.field ?? "", message });
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

  async function importFiles(files: FileList | null): Promise<void> {
    if (!files?.length || busy) return;
    const selection = [...files];
    if (importInput.current) importInput.current.value = "";
    if (folderInput.current) folderInput.current.value = "";
    const requestId = detailRequest.current;
    const selectedDetail = detail?.id;
    setImportResult(null);
    await runAction(async () => {
      const result = await importSkills(selection);
      if (!mounted.current) return;
      setImportResult(result);
      if (selectedDetail && requestId === detailRequest.current) await reloadDetail(selectedDetail);
    });
  }

  async function previewFile(path: string): Promise<void> {
    if (!detail) return;
    const requestId = detailRequest.current;
    setFilePreview(null);
    await runAction(async () => {
      const text = await loadSkillFile(detail.id, path);
      if (requestId === detailRequest.current) setFilePreview({ path, text });
    });
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

  async function changeApproval(skill: SkillDetail, requestId?: string): Promise<void> {
    const generation = detailRequest.current;
    await runAction(async () => {
      const updated = requestId ? await withdrawSkillApproval(skill.id, requestId) : await requestSkillApproval(skill);
      if (mounted.current && generation === detailRequest.current) setDetail(updated);
    }, requestId ? "Approval request withdrawn." : "Approval request submitted.");
  }

  async function removePermanently(skill: SkillDetail): Promise<void> {
    const removed = await runAction(() => deleteSkill(skill.id), "Skill deleted.");
    if (!removed) return;
    const current = selectionRef.current;
    current.onSelectionChange(current.selectedIds.filter((id) => id !== skill.id));
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
          <p>Reusable instructions with bundled references and scripts.</p>
        </div>
        <div className="v2-skill-heading-actions">
          <input ref={importInput} hidden type="file" accept=".zip,.md" aria-label="Import Skill file"
            onChange={(event) => void importFiles(event.target.files)} />
          <input ref={folderInput} hidden type="file" multiple aria-label="Import Skill folder"
            {...{ webkitdirectory: "" }} onChange={(event) => void importFiles(event.target.files)} />
          <UiV2Button disabled={busy || Boolean(editor)} icon="file" onClick={() => importInput.current?.click()}>Import file</UiV2Button>
          <UiV2Button disabled={busy || Boolean(editor)} icon="folder" onClick={() => folderInput.current?.click()}>Import folder</UiV2Button>
          <UiV2Button disabled={busy} icon="download" onClick={() => void runAction(() => exportSkills())}>Export all</UiV2Button>
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
        {!assistantSelection ? <div className="v2-skill-discovery-controls">
          <p>Auto loads matching Skills when needed. Always use includes instructions in every message until removed.</p>
          <UiV2Button
            disabled={busy || Boolean(editor) || !data || (!data.nextCursor && !query.trim() && !skills.some(skill => !skill.archived && !(skill.enabled ?? skill.owned)))}
            icon="check" title="Enable Auto for every active Skill in your library, including those outside the current search."
            onClick={() => void enableAllForAuto()}>Enable all for Auto</UiV2Button>
        </div> : null}
      </header>

      {actionError ? <p className="v2-skill-feedback" data-tone="danger" role="alert">{actionError}</p> : null}
      {notice ? <p className="v2-skill-feedback" data-tone="ok" role="status">{notice}</p> : null}
      {importResult ? <div className="v2-skill-import-result" role="status" aria-label="Import results">
        <UiV2IconButton className="v2-skill-import-dismiss" icon="close" label="Dismiss import results" onClick={() => setImportResult(null)} />
        <p>{["created", "updated", "unchanged", "failed"].map((outcome) =>
          `${importResult.results.filter((entry) => entry.outcome === outcome).length} ${outcome === "created" ? "imported" : outcome}`).join(" · ")}</p>
        {importResult.results.some(entry => entry.outcome === "created") ? <p>New Skills are enabled for Auto.</p> : null}
        {importResult.ignoredFiles > 0 ? <p>{importResult.ignoredFiles} files outside Skill folders skipped.</p> : null}
        <ul>{importResult.results.map((entry, index) => <li key={`${index}:${entry.name}`}>
          <strong>{entry.name}</strong>: {entry.outcome === "failed" ? skillValidationMessage(entry.error) : entry.outcome}
        </li>)}</ul>
      </div> : null}

      <div className="v2-skill-layout">
        <section className="v2-skill-list-pane" aria-label="Skill library">
          {assistantSelection ? <section aria-label="Selected Skills" className="v2-skill-selection">
            <p>{selectedIds.length} Skills selected. Choose Always or On demand in the Assistant.</p>
            <ol>{manualSkills.map((skill, index) => <li key={skill.id}><span>{index + 1}. {skill.name}</span>
              <UiV2Button aria-label={`Remove manual ${skill.name}`} onClick={() => onSelectionChange(selectedIds.filter(id => id !== skill.id))}>Remove</UiV2Button>
            </li>)}</ol>
          </section> :
            <SkillSelectionSummary includedSkills={includedSkills} manualSkills={manualSkills} modelContextWindow={modelContextWindow} estimates={skills}
              availableCount={skillsMode === "auto" && (availableCount !== undefined || data) ? availableCount ?? skills.filter(skill => !skill.archived && (skill.enabled ?? skill.owned) && !effectiveIds.includes(skill.id)).length : undefined}
              availableCountPartial={availableCount === undefined && Boolean(data?.nextCursor || query.trim())}
              onRemove={(id) => onSelectionChange(selectedIds.filter((value) => value !== id))} />}
          {loadState === "error" && data ? (
            <div className="v2-skill-state" role="alert">
              <p>Skills could not be loaded. Earlier results are shown.</p>
              <UiV2Button onClick={() => void refreshSkillLibrary(true, query).catch(() => undefined)}>
                Try again
              </UiV2Button>
            </div>
          ) : null}
          {loadState === "loading" && data ? (
            <p className="v2-skill-searching" role="status">Searching…</p>
          ) : null}
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
            loadState === "ready" ? <div className="v2-skill-state">
              <strong>{query ? "No matching Skills" : "No Skills yet"}</strong>
              <p>Import a ZIP, SKILL.md, or folder, or create your own instructions.</p>
            </div> : null
          ) : (
            <>
              <ul className="v2-skill-list" aria-label="Available Skills">
                {skills.map((skill) => {
                  const included = includedSet.has(skill.id);
                  const selected = selectedSet.has(skill.id);
                  const selectedOrder = selectedIds.indexOf(skill.id) + 1;
                  const atLimit = !effectiveIds.includes(skill.id) && effectiveIds.length >= selectionLimit;
                  const active = detail?.id === skill.id || editor?.source?.id === skill.id;
                  return (
                    <li className="v2-skill-row" data-active={active || undefined} key={skill.id}>
                      <span className="v2-skill-row-icon" aria-hidden="true"><UiV2Icon name="wand" /></span>
                      <button
                        aria-label={`Open ${skill.name}`}
                        className="v2-skill-row-open v2-focusable"
                        type="button"
                        disabled={busy}
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
                      <div className="v2-skill-row-actions">
                        {!assistantSelection ? <button className="v2-skill-enabled v2-focusable" type="button" role="switch" aria-label={`Auto load: ${skill.name}`}
                          aria-checked={skill.enabled ?? skill.owned} disabled={busy || skill.archived}
                          title="Let Skills: Auto load this Skill when it matches your request."
                          onClick={() => changeEnabled(skill, !(skill.enabled ?? skill.owned))}>Auto: {(skill.enabled ?? skill.owned) ? "On" : "Off"}</button> : null}
                        <UiV2Button
                          aria-label={`${included ? "Always included" : selected ? removeActionAria : addActionAria} ${skill.name}`}
                          aria-pressed={included || selected}
                          className="v2-skill-select"
                          disabled={included || skill.archived || atLimit || busy}
                          onClick={() => toggle(skill)}
                        >
                          {included ? "From Assistant" : selected ? removeActionText : addActionText}
                        </UiV2Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {data?.nextCursor ? (
                <div className="v2-skill-load-more">
                  <UiV2Button busy={loadingMore} onClick={() => void loadMoreSkillLibrary().catch(() => undefined)}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </UiV2Button>
                  {moreError ? <p role="alert">More Skills could not be loaded.</p> : null}
                </div>
              ) : null}
            </>
          )}
        </section>

        <section className="v2-skill-detail-pane" aria-label="Skill detail">
          {detailOpen ? (
            <UiV2Button className="v2-skill-detail-back" disabled={busy} icon="arrow-left" onClick={closeDetail}>
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
                <UiV2Button disabled={busy} onClick={() => { setEditor(null); setFieldError(null); }}>Cancel</UiV2Button>
              </div>
              <label className="v2-skill-field">
                <span>Name</span>
                <input
                  autoFocus
                  className="v2-focusable"
                  aria-label="Name"
                  aria-describedby={`${fieldId}-name-count${fieldError?.field === "name" ? ` ${fieldId}-error` : ""}`}
                  aria-invalid={fieldError?.field === "name" || undefined}
                  disabled={busy}
                  value={editor.draft.name}
                  onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, name: event.target.value } })}
                />
                <small id={`${fieldId}-name-count`}>{[...editor.draft.name].length} / {SKILL_NAME_MAX_LENGTH} characters</small>
              </label>
              <label className="v2-skill-field">
                <span>Description</span>
                <textarea
                  className="v2-focusable"
                  aria-label="Description"
                  aria-describedby={`${fieldId}-description-count${fieldError?.field === "description" ? ` ${fieldId}-error` : ""}`}
                  aria-invalid={fieldError?.field === "description" || undefined}
                  disabled={busy}
                  rows={3}
                  value={editor.draft.description}
                  onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, description: event.target.value } })}
                />
                <small id={`${fieldId}-description-count`}>{[...editor.draft.description].length} / {SKILL_DESCRIPTION_MAX_LENGTH} characters</small>
              </label>
              <label className="v2-skill-field">
                <span>Instructions</span>
                <textarea
                  className="v2-focusable"
                  data-instructions="true"
                  aria-label="Instructions"
                  aria-describedby={`${fieldId}-instructions-count${fieldError?.field === "instructions" ? ` ${fieldId}-error` : ""}`}
                  aria-invalid={fieldError?.field === "instructions" || undefined}
                  disabled={busy}
                  placeholder="Describe the workflow, decision points, and expected result."
                  rows={12}
                  value={editor.draft.instructions}
                  onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, instructions: event.target.value } })}
                />
                <small id={`${fieldId}-instructions-count`}>{new TextEncoder().encode(editor.draft.instructions).length.toLocaleString()} / {SKILL_INSTRUCTIONS_MAX_BYTES.toLocaleString()} bytes</small>
              </label>
              {fieldError ? <p className="v2-skill-field-error" id={`${fieldId}-error`} role="alert">{fieldError.message}</p> : null}
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
                  disabled={busy || includedSet.has(detail.id) || detail.archived || (!effectiveIds.includes(detail.id) && effectiveIds.length >= selectionLimit)}
                  tone="primary"
                  onClick={() => toggle(detail)}
                >
                  {includedSet.has(detail.id) ? "From Assistant" : selectedSet.has(detail.id) ? removeActionText : addActionText}
                </UiV2Button>
              </div>
              {detail.description ? <p className="v2-skill-description">{detail.description}</p> : null}
              {!assistantSelection ? <div className="v2-skill-detail-section"><h4>Auto load</h4>
                <button className="v2-skill-enabled v2-focusable" type="button" role="switch" aria-label={`Auto load: ${detail.name}`}
                  aria-checked={detail.enabled ?? detail.owned} disabled={busy || detail.archived}
                  onClick={() => changeEnabled(detail, !(detail.enabled ?? detail.owned))}>Auto: {(detail.enabled ?? detail.owned) ? "On" : "Off"}</button>
                <p>Auto loads this Skill only when needed. Always use includes its instructions in every message until you unpin it, even with Auto off.</p>
              </div> : null}
              <div className="v2-skill-detail-section">
                <h4>Instructions</h4>
                <pre>{detail.instructions}</pre>
              </div>

              {detail.files?.length ? <div className="v2-skill-detail-section">
                <h4>Bundled files</h4>
                <ul className="v2-skill-files">{detail.files.map((file) => <li key={file.path}>
                  <span>{file.path}<small>{file.byteSize.toLocaleString()} bytes{file.executable ? " · Executable" : ""}</small></span>
                  {file.kind === "text" ? <UiV2Button aria-label={`View ${file.path}`} disabled={busy} onClick={() => void previewFile(file.path)}>View</UiV2Button> : <small>Binary file</small>}
                </li>)}</ul>
                {filePreview ? <div className="v2-skill-file-preview"><div><h4>{filePreview.path}</h4>
                  <UiV2IconButton icon="close" label="Close file preview" onClick={() => setFilePreview(null)} /></div>
                  <pre aria-label={filePreview.path} tabIndex={0}>{filePreview.text}</pre></div> : null}
              </div> : null}

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

              {detail.owned && detail.sharing ? <div className="v2-skill-detail-section">
                <h4>Sharing approval</h4>
                <p>Your version: v{detail.sharing.currentRevision.revisionNumber}. {detail.sharing.sharedRevision
                  ? `Approved for sharing: v${detail.sharing.sharedRevision.revisionNumber}.`
                  : "No version approved for sharing yet."}</p>
                {detail.sharing.sharedRevision && detail.sharing.sharedRevision.id !== detail.sharing.currentRevision.id
                  ? <p>You use your latest version. Other people and Projects continue using the approved version.</p> : null}
                {detail.sharing.request ? <div role="status">
                  <p>{skillShareStateLabels[detail.sharing.request.state]} · v{detail.sharing.request.revisionNumber}</p>
                  {detail.sharing.request.reviewNote ? <p className="v2-skill-review-note">{detail.sharing.request.reviewNote}</p> : null}
                </div> : null}
                <div className="v2-skill-actions">
                  {detail.sharing.canRequest ? <UiV2Button disabled={busy} onClick={() => void changeApproval(detail)}>Request approval for v{detail.sharing.currentRevision.revisionNumber}</UiV2Button> : null}
                  {detail.sharing.canWithdraw && detail.sharing.request ? <UiV2Button disabled={busy}
                    onClick={() => void changeApproval(detail, detail.sharing!.request!.id)}>Withdraw request</UiV2Button> : null}
                </div>
              </div> : null}

              {detail.owned ? (
                <>
                  <div className="v2-skill-actions v2-skill-detail-section">
                    <UiV2Button disabled={busy} icon="download" onClick={() => void runAction(() => exportSkills(detail.id))}>Export</UiV2Button>
                    <UiV2Button disabled={busy} onClick={() => importInput.current?.click()}>Import updated bundle…</UiV2Button>
                    {detail.canEdit ? <UiV2Button disabled={busy} onClick={() => setEditor(editorFor(detail))}>Edit</UiV2Button> : null}
                    {detail.archived ? (
                      <UiV2Button disabled={busy} onClick={() => void restoreArchived(detail)}>Restore</UiV2Button>
                    ) : null}
                  </div>
                  <p className="v2-skill-import-hint">Import matches your Skills by name. A different name creates a new Skill.</p>

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
                              }, `Audience added: ${workspace.name}.`)}
                            >
                              {workspace.name}
                            </UiV2Button>
                          ))}
                        {data.viewer.canPublishInstallation &&
                        !detail.audiences.some((audience) => audience.kind === "everyone") ? (
                          <UiV2Button
                            disabled={busy}
                            onClick={() => void share(detail, { scope: "installation" }, "Audience added: Everyone.")}
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
              <p>Open a Skill to read its instructions and bundled files. Use Auto for matching requests, or Always use to include it in every message.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function SkillLibrarySection({
  onSelectionChange,
  selectedIds,
  includedSkills,
  selectedSkills,
  modelContextWindow, skillsMode, availableCount, assistantSelection, selectionLimit
}: Omit<SkillLibraryContentProps, "mode">) {
  return (
    <SkillLibraryContent
      mode="section"
      modelContextWindow={modelContextWindow}
      skillsMode={skillsMode} availableCount={availableCount} assistantSelection={assistantSelection} selectionLimit={selectionLimit}
      includedSkills={includedSkills}
      selectedSkills={selectedSkills}
      onSelectionChange={onSelectionChange}
      selectedIds={selectedIds}
    />
  );
}

export function SkillLibraryDialog({
  onClose,
  onSelectionChange,
  selectedIds,
  selectedSkills,
  includedSkills,
  restoreFocus,
  modelContextWindow, skillsMode, availableCount, assistantSelection, selectionLimit
}: Readonly<{
  modelContextWindow?: number;
  skillsMode?: "auto" | "off";
  availableCount?: number;
  assistantSelection?: boolean;
  selectionLimit?: number;
  includedSkills?: readonly SelectedSkillName[];
  selectedSkills?: readonly SelectedSkillName[];
  restoreFocus?(): HTMLElement | null;
  onClose(): void;
  onSelectionChange(skillIds: readonly string[]): void;
  selectedIds: readonly string[];
}>) {
  const dialogRef = useDialogFocus<HTMLDivElement>({ active: true, onClose, restoreFocus });

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
            <strong>{assistantSelection ? "Choose Assistant Skills" : "Skills"}</strong>
            <span>{assistantSelection ? "Set delivery for each Skill in the Assistant." : "Choose automatic loading or instructions to always include."}</span>
          </div>
          <UiV2IconButton icon="close" label="Close Skills" onClick={onClose} />
        </header>
        <SkillLibraryContent
          mode="picker"
          modelContextWindow={modelContextWindow}
          skillsMode={skillsMode} availableCount={availableCount} assistantSelection={assistantSelection} selectionLimit={selectionLimit}
          includedSkills={includedSkills}
          selectedSkills={selectedSkills}
          onSelectionChange={onSelectionChange}
          selectedIds={selectedIds}
        />
      </div>
    </div>
  );
}
