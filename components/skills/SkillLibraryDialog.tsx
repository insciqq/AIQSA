"use client";

import {
  createSkill,
  publishSkill,
  refreshSkillLibrary,
  reviseSkill,
  setSkillArchived,
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
  type SkillSummary
} from "@/lib/contracts/skills";
import { useEffect, useMemo, useState } from "react";

type EditorState = {
  draft: SkillDraft;
  source: SkillSummary | null;
};

const emptyDraft: SkillDraft = { description: "", instructions: "", name: "" };

function scopeLabel(skill: SkillSummary): string {
  if (skill.owned) return "Yours";
  if (skill.scope.kind === "group") return skill.scope.groupNames.join(", ") || "Shared group";
  return "Shared with everyone";
}

function editorFor(skill: SkillSummary | null): EditorState {
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

export function SkillLibraryDialog({
  onClose,
  onSelectionChange,
  selectedIds
}: Readonly<{
  onClose(): void;
  onSelectionChange(skills: readonly SkillSummary[]): void;
  selectedIds: readonly string[];
}>) {
  const data = useSkillLibraryStore((state) => state.data);
  const error = useSkillLibraryStore((state) => state.error);
  const loadState = useSkillLibraryStore((state) => state.loadState);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({ active: true, onClose });

  useEffect(() => {
    void refreshSkillLibrary(true).catch(() => undefined);
  }, []);

  const skills = useMemo(() => data?.skills ?? [], [data?.skills]);
  const selectedSet = new Set(selectedIds);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return skills.filter((skill) => !needle ||
      [skill.name, skill.description, skill.ownerDisplayName]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle));
  }, [query, skills]);

  function toggle(skill: SkillSummary) {
    if (skill.archived) return;
    const nextIds = selectedSet.has(skill.id)
      ? selectedIds.filter((id) => id !== skill.id)
      : selectedIds.length < SKILL_MAX_SELECTED
        ? [...selectedIds, skill.id]
        : selectedIds;
    onSelectionChange(nextIds.flatMap((id) => {
      const selected = skills.find((candidate) => candidate.id === id);
      return selected && !selected.archived ? [selected] : [];
    }));
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
      setActionError(failure instanceof Error ? failure.message.replaceAll("_", " ") : "Skill update failed");
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
    const saved = await runAction(
      () => editor.source ? reviseSkill(editor.source, draft) : createSkill(draft),
      editor.source ? "Skill updated." : "Skill created."
    );
    if (saved) setEditor(null);
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
            <p className="mt-0.5 text-xs text-ink-muted">Reusable instructions you choose for this conversation.</p>
          </div>
          <button
            className="v2-focusable rounded-lg bg-proof px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy}
            type="button"
            onClick={() => setEditor(editorFor(null))}
          >
            New Skill
          </button>
          <UiV2IconButton icon="close" label="Close Skills" onClick={onClose} />
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_minmax(320px,0.78fr)] md:grid-rows-1">
          <section className="flex min-h-0 flex-col border-line md:border-r" aria-label="Skill library">
            <div className="border-b border-line p-4">
              <label className="relative block">
                <span className="sr-only">Search Skills</span>
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
                  <UiV2Icon name="search" />
                </span>
                <input
                  className="v2-focusable w-full rounded-xl border border-line bg-surface py-2.5 pl-9 pr-3 text-sm text-ink"
                  placeholder="Search Skills"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <p className="mt-2 text-xs text-ink-muted">
                {selectedIds.length} selected · up to {SKILL_MAX_SELECTED}. Instructions load before the first model step.
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
              {loadState === "loading" && !data ? (
                <p className="p-4 text-sm text-ink-muted">Loading Skills…</p>
              ) : loadState === "error" && !data ? (
                <div className="p-4 text-sm">
                  <p className="text-critical">Skills could not be loaded.</p>
                  <button className="v2-focusable mt-3 text-proof" type="button" onClick={() => void refreshSkillLibrary(true)}>Try again</button>
                </div>
              ) : visible.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-sm font-semibold text-ink">{query ? "No matching Skills" : "No Skills yet"}</p>
                  <p className="mt-1 text-xs text-ink-muted">Create a focused workflow with plain-text instructions.</p>
                </div>
              ) : (
                <ul className="space-y-1" aria-label="Available Skills">
                  {visible.map((skill) => {
                    const selected = selectedSet.has(skill.id);
                    const atLimit = !selected && selectedIds.length >= SKILL_MAX_SELECTED;
                    return (
                      <li key={skill.id} className="group flex items-start gap-3 rounded-xl px-3 py-3 hover:bg-surface">
                        <button
                          aria-label={`${selected ? "Remove" : "Use"} ${skill.name}`}
                          aria-pressed={selected}
                          className="v2-focusable flex size-9 shrink-0 items-center justify-center rounded-lg border border-line text-proof disabled:opacity-40"
                          disabled={skill.archived || atLimit || busy}
                          type="button"
                          onClick={() => toggle(skill)}
                        >
                          {selected ? <UiV2Icon name="check" /> : null}
                        </button>
                        <button
                          aria-label={skill.owned
                            ? `Edit ${skill.name}`
                            : `${selected ? "Deselect" : "Select"} ${skill.name}`}
                          className="v2-focusable min-w-0 flex-1 text-left"
                          type="button"
                          onClick={() => skill.owned ? setEditor(editorFor(skill)) : toggle(skill)}
                        >
                          <span className="flex items-center gap-2">
                            <strong className="truncate text-sm text-ink">{skill.name}</strong>
                            {skill.archived ? <span className="text-metadata text-ink-muted">Archived</span> : null}
                          </span>
                          <span className="mt-1 line-clamp-2 block text-xs leading-5 text-ink-secondary">
                            {skill.description || "No description"}
                          </span>
                          <span className="mt-1 block text-metadata text-ink-muted">
                            {scopeLabel(skill)}
                          </span>
                        </button>
                        {skill.owned ? (
                          <button
                            className="v2-focusable rounded-lg px-2 py-1 text-xs text-ink-secondary opacity-70 group-hover:opacity-100"
                            type="button"
                            onClick={() => setEditor(editorFor(skill))}
                          >
                            Edit
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          <section className="min-h-0 overflow-y-auto bg-surface/45 p-4 sm:p-6" aria-label="Skill editor">
            {editor ? (
              <div className="mx-auto max-w-lg">
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-ink">{editor.source ? "Edit Skill" : "New Skill"}</h3>
                    <p className="mt-1 text-xs text-ink-muted">
                      Updates apply to your future runs. Share again to update an existing audience; existing runs stay unchanged.
                    </p>
                  </div>
                  <button className="v2-focusable text-xs text-ink-muted" type="button" onClick={() => setEditor(null)}>Cancel</button>
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
                {actionError ? <p className="mt-3 text-xs text-critical" role="alert">{actionError}</p> : null}
                {notice ? <p className="mt-3 text-xs text-proof" role="status">{notice}</p> : null}
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
                      onClick={() => void runAction(
                        () => setSkillArchived(editor.source!, !editor.source!.archived),
                        editor.source!.archived ? "Skill restored." : "Skill archived."
                      ).then((changed) => {
                        if (changed) setEditor(null);
                      })}
                    >
                      {editor.source.archived ? "Restore" : "Archive"}
                    </button>
                  ) : null}
                </div>

                {editor.source && !editor.source.archived && data ? (
                  <div className="mt-8 border-t border-line pt-5">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Share this Skill</h4>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {data.publishableGroups.map((group) => (
                        <button
                          key={group.id}
                          className="v2-focusable rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-secondary"
                          disabled={busy}
                          type="button"
                          onClick={() => void runAction(
                            () => publishSkill(editor.source!.id, { groupId: group.id, scope: "group" }),
                            `Shared with ${group.name}.`
                          )}
                        >
                          {group.name}
                        </button>
                      ))}
                      {data.viewer.canPublishInstallation ? (
                        <button
                          className="v2-focusable rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-secondary"
                          disabled={busy}
                          type="button"
                          onClick={() => void runAction(
                            () => publishSkill(editor.source!.id, { scope: "installation" }),
                            "Shared with everyone."
                          )}
                        >
                          Everyone
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex min-h-60 flex-col items-center justify-center text-center">
                <span className="mb-3 text-ink-muted"><UiV2Icon name="book" /></span>
                <p className="text-sm font-semibold text-ink">Text-only by design</p>
                <p className="mt-1 max-w-xs text-xs leading-5 text-ink-muted">
                  Skills provide reusable instructions. They do not install tools, run code, or start MCP servers.
                </p>
                {notice ? <p className="mt-4 text-xs text-proof" role="status">{notice}</p> : null}
                {error ? <p className="mt-4 text-xs text-critical">{error.replaceAll("_", " ")}</p> : null}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
