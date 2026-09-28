"use client";

import {
  assistantEditorErrorsEmpty,
  type AssistantEditorView,
  type LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { editorCharacterCount } from "@/components/ui-v2/MarkdownEditorV2";
import { assistantUnavailabilityCopy } from "@/features/library-v2/assistantAvailabilityCopy";
import { InstructionAnswerRules } from "@/features/settings-v2/InstructionAnswerRules";
import { InstructionTemplateEditor } from "@/features/settings-v2/InstructionTemplateEditor";
import {
  ASSISTANT_MAX_STARTER_PROMPTS,
  ASSISTANT_STARTER_PROMPT_MAX_LENGTH,
  ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH
} from "@/lib/contracts/assistants";
import { ANSWER_RULES_MAX_LENGTH, RESPONSE_REMINDER_MAX_LENGTH } from "@/lib/contracts/instructionPresets";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AssistantIdentityV2 } from "./AssistantIdentityV2";
import { AssistantSetupColumnV2 } from "./AssistantSetupColumnV2";
import { AssistantVersionConflictV2 } from "./AssistantVersionConflictV2";
import "./assistant-editor.css";

function StartersV2({ editor, locked }: Readonly<{ editor: AssistantEditorView; locked: boolean }>) {
  const starters = editor.draft.starterPrompts;
  const error = editor.errors?.fields.starterPrompts;
  const list = useRef<HTMLUListElement>(null);
  // "Add starter" moves focus to the new field once it renders.
  const focusAdded = useRef(false);
  useEffect(() => {
    if (!focusAdded.current) return;
    focusAdded.current = false;
    list.current?.querySelector<HTMLInputElement>("li:last-child input")?.focus();
  }, [starters.length]);
  const update = (index: number, value: string) =>
    editor.onChange({ starterPrompts: starters.map((starter, position) => position === index ? value : starter) });
  return (
    <section className="v2-assistant-editor-section" data-invalid={Boolean(error) || undefined}>
      <div className="v2-assistant-section-head">
        <h3 id="assistant-starters-heading">Conversation starters</h3>
        <UiV2Button
          disabled={locked || starters.length >= ASSISTANT_MAX_STARTER_PROMPTS}
          icon="plus"
          onClick={() => {
            focusAdded.current = true;
            editor.onChange({ starterPrompts: [...starters, ""] });
          }}
        >
          Add starter
        </UiV2Button>
      </div>
      <p id="assistant-starters-help">
        Shown on an empty chat. One click sends the starter. {starters.length} of {ASSISTANT_MAX_STARTER_PROMPTS}.
      </p>
      {starters.length > 0 ? (
        <ul className="v2-assistant-starters" ref={list}>
          {starters.map((starter, index) => (
            <li key={index}>
              <input
                aria-describedby={`assistant-editor-starter-${index}-count${error ? " assistant-editor-starters-error" : ""}`}
                aria-invalid={Boolean(error) || undefined}
                aria-label={`Conversation starter ${index + 1}`}
                disabled={locked}
                id={`assistant-editor-starter-${index}`}
                maxLength={ASSISTANT_STARTER_PROMPT_MAX_LENGTH}
                value={starter}
                onChange={(event) => update(index, event.currentTarget.value)}
              />
              <small id={`assistant-editor-starter-${index}-count`}>
                {editorCharacterCount(starter, ASSISTANT_STARTER_PROMPT_MAX_LENGTH)}
              </small>
              <UiV2IconButton
                disabled={locked}
                icon="close"
                label={`Remove conversation starter ${index + 1}`}
                onClick={() => editor.onChange({ starterPrompts: starters.filter((_, position) => position !== index) })}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="v2-assistant-field-error" id="assistant-editor-starters-error">{error}</p> : null}
    </section>
  );
}

function InstructionsV2({ editor, locked }: Readonly<{ editor: AssistantEditorView; locked: boolean }>) {
  const { draft } = editor;
  const [reminderOpen] = useState(() => draft.responseReminder.length > 0);
  return (
    <section className="v2-assistant-editor-section">
      <h3 id="assistant-instructions-heading">Instructions</h3>
      <p>What this Assistant should always do. The same editor and variables as your Instructions presets.</p>
      <div className="v2-assistant-instructions">
        <InstructionTemplateEditor
          disabled={locked}
          label="Instructions"
          maxLength={ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH}
          previewLabel="Instructions preview"
          splitWhenWide
          value={draft.systemPrompt}
          onChange={(systemPrompt) => editor.onChange({ systemPrompt })}
        />
      </div>
      <InstructionAnswerRules
        copy={{
          description: "Custom rules replace the built-in answer rules for this Assistant, from its next reply.",
          summary: (
            <>
              <UiV2Icon name="chevron-right" />
              <span className="v2-assistant-disclosure-summary">
                Answer rules (optional)
                <small>
                  Replaces the built-in answer rules
                  {draft.answerRules !== null ? ` · ${editorCharacterCount(draft.answerRules, ANSWER_RULES_MAX_LENGTH)}` : ""}
                </small>
              </span>
            </>
          )
        }}
        defaultOpen={draft.answerRules !== null}
        disabled={locked}
        value={draft.answerRules}
        onChange={(answerRules) => editor.onChange({ answerRules })}
      />
      <details className="v2-instructions-reminder" open={reminderOpen || undefined}>
        <summary className="v2-focusable cursor-pointer text-sm font-medium text-ink">
          <UiV2Icon name="chevron-right" />
          <span className="v2-assistant-disclosure-summary">
            Response reminder (optional)
            <small>Appended after the latest message, before the model responds</small>
          </span>
        </summary>
        <p className="my-2 text-xs leading-5 text-ink-muted" id="assistant-editor-reminder-help">
          For short rules the model must not forget in long chats. You can use {"{local_date}"} and {"{local_time}"} here too.
        </p>
        <div className="v2-assistant-field">
          <textarea
            aria-describedby="assistant-editor-reminder-help assistant-editor-reminder-count"
            aria-label="Response reminder"
            disabled={locked}
            id="assistant-editor-reminder"
            maxLength={RESPONSE_REMINDER_MAX_LENGTH}
            rows={3}
            value={draft.responseReminder}
            onChange={(event) => editor.onChange({ responseReminder: event.currentTarget.value })}
          />
          <small className="v2-assistant-count" id="assistant-editor-reminder-count">
            {editorCharacterCount(draft.responseReminder, RESPONSE_REMINDER_MAX_LENGTH)}
          </small>
        </div>
      </details>
    </section>
  );
}

/**
 * The heading and Studio crumb: the draft's name, else the last saved name
 * while its field is cleared. "New assistant" is for create mode only.
 */
export function assistantEditorTitle(editor: Pick<AssistantEditorView, "draft" | "savedName">): string {
  return editor.draft.name.trim() || editor.savedName || "New assistant";
}

/**
 * The full-page Assistant editor: identity, instructions and starters on the
 * left, the Setup column on the right (below the starters on narrow pages),
 * and a sticky bar with the save actions. The draft and every save belong to
 * the library view; this page only presents them.
 */
export function AssistantEditorPageV2({ busy, editor, notice, onDismissNotice, onOpenSharing, onRequestClose }: Readonly<{
  busy: boolean;
  editor: AssistantEditorView;
  notice: LibraryNotice | null;
  onDismissNotice(): void;
  onOpenSharing(): void;
  onRequestClose(): void;
}>) {
  const page = useRef<HTMLElement>(null);
  const locked = busy || editor.saving;
  const creating = editor.mode === "create";
  const unavailable = editor.availability && !editor.availability.ok
    ? assistantUnavailabilityCopy({ availability: editor.availability, owned: true })
    : null;
  const invalid = !assistantEditorErrorsEmpty(editor.errors);
  const errors = editor.errors;

  // A failed save moves focus to the first field or row it names.
  useEffect(() => {
    if (!errors || assistantEditorErrorsEmpty(errors)) return;
    const target = page.current?.querySelector<HTMLElement>(
      "[aria-invalid='true'], [data-invalid] .v2-assistant-row-toggle"
    );
    target?.focus({ preventScroll: false });
  }, [errors]);

  // Nothing to save on a clean saved Assistant, as the disabled Save shows.
  const canSave = !locked && (creating || editor.dirty);
  const save = () => {
    if (canSave) void editor.onSave();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || event.nativeEvent.isComposing) return;
    // Portaled dialogs (the Skills library) bubble through React; they keep their own keys.
    if (!(event.target instanceof Node) || !page.current?.contains(event.target)) return;
    event.preventDefault();
    save();
  };
  const status = creating ? "Not saved yet" : editor.dirty ? "Unsaved changes" : "Saved";

  return (
    <section
      aria-labelledby="assistant-editor-title"
      className="v2-assistant-editor-page"
      data-testid="assistant-editor"
      ref={page}
      onKeyDown={onKeyDown}
    >
      <header className="v2-assistant-editor-title">
        <h2 id="assistant-editor-title">{assistantEditorTitle(editor)}</h2>
      </header>

      {notice ? (
        <div
          className="v2-assistant-editor-notice v2-assistant-editor-library-notice"
          data-testid="assistant-library-notice"
          data-tone={notice.kind}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          <span>{notice.text}</span>
          <UiV2IconButton icon="close" label="Dismiss" onClick={onDismissNotice} />
        </div>
      ) : null}
      {unavailable ? (
        <div className="v2-assistant-editor-notice" data-tone="warn" role="status">
          <UiV2Icon name="alert" />
          <span><strong>{unavailable.headline}</strong> {unavailable.explanation}</span>
          {unavailable.action?.kind === "mcp-settings" ? (
            <UiV2Button onClick={editor.onOpenMcpSettings}>{unavailable.action.label}</UiV2Button>
          ) : null}
        </div>
      ) : null}
      <AssistantVersionConflictV2 editor={editor} />

      <div className="v2-assistant-editor-grid">
        <div className="v2-assistant-editor-main">
          <section className="v2-assistant-editor-section">
            <h3 id="assistant-identity-heading">Identity</h3>
            <AssistantIdentityV2 editor={editor} locked={locked} />
          </section>
          <InstructionsV2 editor={editor} locked={locked} />
          <StartersV2 editor={editor} locked={locked} />
        </div>
        <AssistantSetupColumnV2 editor={editor} locked={locked} onOpenSharing={onOpenSharing} />
      </div>

      <footer className="v2-assistant-editor-bar">
        <div className="v2-assistant-editor-bar-status">
          <span>Ctrl / ⌘ S to save</span>
          <span data-tone={editor.dirty ? "warn" : "ok"} role="status">{status}</span>
          {editor.error && !editor.conflict ? (
            <span data-error-code={editor.error.code} data-tone="error" id="assistant-editor-error" role="alert">
              {invalid ? "Review the highlighted fields." : editor.error.text}
            </span>
          ) : null}
        </div>
        <div className="v2-assistant-editor-bar-actions">
          <UiV2Button disabled={locked} onClick={onRequestClose}>Cancel</UiV2Button>
          <UiV2Button
            disabled={locked || editor.archived}
            icon="chat"
            onClick={() => { if (!locked) void editor.onSaveAndTry(); }}
          >
            Save &amp; try
          </UiV2Button>
          <UiV2Button
            aria-describedby={editor.error && !editor.conflict ? "assistant-editor-error" : undefined}
            busy={editor.saving}
            data-testid="assistant-editor-save"
            disabled={!canSave}
            tone="primary"
            onClick={save}
          >
            {creating ? "Create" : "Save"}
          </UiV2Button>
        </div>
      </footer>
    </section>
  );
}
