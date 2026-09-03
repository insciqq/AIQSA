"use client";

import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import type {
  AssistantEditorView,
  AssistantHistoryView,
  AssistantLibraryView,
  LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton
} from "@/components/ui-v2";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import {
  ASSISTANT_DESCRIPTION_MAX_LENGTH,
  ASSISTANT_DEVELOPER_PROMPT_MAX_LENGTH,
  ASSISTANT_MAX_STARTER_PROMPTS,
  ASSISTANT_NAME_MAX_LENGTH,
  ASSISTANT_STARTER_PROMPT_MAX_LENGTH,
  ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH
} from "@/lib/contracts/assistants";
import { isMcpReadinessStartable } from "@/lib/contracts/mcp";
import { useState } from "react";
import { assistantUnavailabilityCopy } from "./assistantAvailabilityCopy";
import { AssistantAdvancedControlsV2 } from "./assistantAdvancedControls";
import { AssistantSetupPanelV2 } from "./AssistantSetupPanelV2";

const HISTORY_SECTION_LABELS: Readonly<Record<string, string>> = {
  identity: "Basics",
  instructions: "Instructions",
  knowledge: "Knowledge",
  model: "Model",
  "run-setup": "Model settings",
  search: "Web search",
  skills: "Skills",
  starters: "Starter prompts",
  tools: "Tools"
};

function historySectionLabel(sectionId: string): string {
  return HISTORY_SECTION_LABELS[sectionId] ?? sectionId;
}

function AssistantNoticeV2({ notice, onDismiss }: Readonly<{
  notice: LibraryNotice;
  onDismiss(): void;
}>) {
  return (
    <div
      className="v2-assistant-notice"
      data-tone={notice.kind}
      data-testid="assistant-library-notice"
      role={notice.kind === "error" ? "alert" : "status"}
    >
      <span>{notice.text}</span>
      <UiV2IconButton icon="close" label="Dismiss" onClick={onDismiss} />
    </div>
  );
}

function AssistantSharingV2({ editor, locked }: Readonly<{
  editor: AssistantEditorView;
  locked: boolean;
}>) {
  const [groupId, setGroupId] = useState("");
  const publications = editor.publications ?? [];
  return (
    <details className="v2-assistant-disclosure">
      <summary className="v2-focusable">
        <UiV2Icon name="chevron-right" />
        <span>
          <strong>Sharing</strong>
          <small>{publications.length > 0 ? `${publications.length} active publication${publications.length === 1 ? "" : "s"}.` : "Private. Nothing is shared yet."}</small>
        </span>
      </summary>
      <div className="v2-assistant-disclosure-body v2-assistant-sharing">
        {publications.length > 0 ? (
          <ul aria-label="Publications">
            {publications.map((publication) => {
              const target = publication.scope === "installation"
                ? "Installation"
                : publication.scope === "project"
                  ? "Project publication"
                  : publication.groupName ?? "Group";
              return (
                <li key={publication.id}>
                  <span><strong>{target}</strong><small>Revision {publication.revisionNumber}</small></span>
                  <UiV2Button disabled={locked} onClick={() => editor.onRevokePublication(publication.id)}>Unshare</UiV2Button>
                </li>
              );
            })}
          </ul>
        ) : <p>It becomes usable by others only after you publish it.</p>}
        {editor.publishableGroups.length > 0 ? (
          <div className="v2-assistant-publish-row">
            <label htmlFor="assistant-editor-publish-group">Share with a group</label>
            <select
              disabled={locked}
              id="assistant-editor-publish-group"
              value={groupId}
              onChange={(event) => setGroupId(event.currentTarget.value)}
            >
              <option value="">Choose a group…</option>
              {editor.publishableGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
            <UiV2Button
              disabled={locked || !groupId}
              onClick={() => editor.onPublish({ groupId, scope: "group" })}
            >Share</UiV2Button>
          </div>
        ) : null}
        {editor.canPublishInstallation ? (
          <UiV2Button disabled={locked} onClick={() => editor.onPublish({ scope: "installation" })}>
            Publish to installation
          </UiV2Button>
        ) : null}
        <small>Saving a revision never changes what an existing publication shares.</small>
      </div>
    </details>
  );
}

export function AssistantEditorV2({
  busy,
  editor,
  notice,
  onDismissNotice,
  onRequestClose
}: Readonly<{
  busy: boolean;
  editor: AssistantEditorView;
  notice: LibraryNotice | null;
  onDismissNotice(): void;
  onRequestClose(): void;
}>) {
  const { draft } = editor;
  const locked = busy || editor.saving;
  const selectedModel = editor.options.models.find((model) => model.id === draft.providerModelId) ?? null;
  const toolsBlocked = Boolean(selectedModel && !selectedModel.supportsTools && draft.mcpServerIds.length > 0);
  const mcpUnavailable = draft.mcpServerIds.some((id) => {
    const option = editor.options.mcpServers.find((server) => server.id === id);
    return !option || !option.enabled || !isMcpReadinessStartable(option.readiness);
  });
  const hasFieldErrors = Boolean(editor.fieldErrors && Object.keys(editor.fieldErrors).length > 0);
  const saveDisabled = locked || !draft.name.trim() || !draft.providerModelId || toolsBlocked || mcpUnavailable || hasFieldErrors || (editor.mode === "edit" && !editor.dirty);
  const unavailable = editor.availability && !editor.availability.ok
    ? assistantUnavailabilityCopy({ availability: editor.availability, owned: true })
    : null;
  const updateStarter = (index: number, value: string) => {
    const starterPrompts = [...draft.starterPrompts];
    starterPrompts[index] = value;
    editor.onChange({ starterPrompts });
  };

  return (
    <section className="v2-assistant-editor" data-testid="assistant-editor">
      <header className="v2-assistant-editor-header">
        <div>
          <h2>{draft.name.trim() || "New assistant"}</h2>
          {editor.revisionNumber === null ? (
            <span className="v2-assistant-editor-revision">Draft</span>
          ) : (
            <button className="v2-assistant-editor-revision v2-focusable" type="button" onClick={editor.onOpenHistory}>
              Revision {editor.revisionNumber} <span aria-hidden="true">›</span>
            </button>
          )}
        </div>
        <div className="v2-assistant-editor-actions">
          {editor.onUseInChat ? (
            <UiV2Button icon="arrow-up" tone="primary" onClick={editor.onUseInChat}>Use in chat</UiV2Button>
          ) : null}
          <UiV2Button disabled={locked} onClick={onRequestClose}>
            {editor.mode === "edit" && !editor.dirty ? "Close" : "Cancel"}
          </UiV2Button>
          <UiV2Button
            aria-describedby={editor.error ? "assistant-editor-error" : undefined}
            busy={editor.saving}
            data-testid="assistant-editor-save"
            disabled={saveDisabled}
            tone="primary"
            onClick={editor.onSave}
          >
            {editor.mode === "create" ? "Create assistant" : "Save changes"}
          </UiV2Button>
        </div>
      </header>

      {editor.justCreated && notice?.kind === "success" ? (
        <div className="v2-assistant-created" role="status">
          <UiV2Icon name="check" />
          <span>Assistant created. It is private until you share it — </span>
          {editor.onUseInChat ? <button className="v2-focusable" type="button" onClick={editor.onUseInChat}>use it in a chat</button> : null}
          <UiV2IconButton icon="close" label="Dismiss" onClick={onDismissNotice} />
        </div>
      ) : notice ? <AssistantNoticeV2 notice={notice} onDismiss={onDismissNotice} /> : null}

      {unavailable ? (
        <div className="v2-assistant-availability" role="status">
          <UiV2Icon name="alert" />
          <span><strong>{unavailable.headline}</strong>{unavailable.explanation}</span>
          {unavailable.action?.kind === "mcp-settings" ? (
            <UiV2Button onClick={editor.onOpenMcpSettings}>{unavailable.action.label}</UiV2Button>
          ) : null}
        </div>
      ) : null}

      <div className="v2-assistant-editor-layout">
        <div className="v2-assistant-editor-main">
          <section className="v2-assistant-editor-section" aria-labelledby="assistant-basics-heading">
            <h3 id="assistant-basics-heading">Basics</h3>
            <div className="v2-assistant-basics">
              <div className="v2-assistant-avatar-editor">
                <AssistantAvatarV2 recipe={draft.avatar} size={56} />
                <button className="v2-focusable" disabled={locked} type="button" onClick={editor.onGenerateAvatar}>
                  <UiV2Icon name="wand" />Change
                </button>
              </div>
              <div className="v2-assistant-basics-fields">
                <label htmlFor="assistant-editor-name">
                  <span>Name <small>Required</small></span>
                  <input
                    aria-required="true"
                    autoComplete="off"
                    disabled={locked}
                    id="assistant-editor-name"
                    maxLength={ASSISTANT_NAME_MAX_LENGTH}
                    placeholder="For example, Release-note writer"
                    value={draft.name}
                    onChange={(event) => editor.onChange({ name: event.currentTarget.value })}
                  />
                </label>
                <label htmlFor="assistant-editor-description">
                  <span>Description</span>
                  <input
                    aria-describedby="assistant-editor-description-help"
                    disabled={locked}
                    id="assistant-editor-description"
                    maxLength={ASSISTANT_DESCRIPTION_MAX_LENGTH}
                    value={draft.description}
                    onChange={(event) => editor.onChange({ description: event.currentTarget.value })}
                  />
                </label>
                <small id="assistant-editor-description-help">Shown in the list and the picker. Never sent to the model.</small>
              </div>
            </div>
          </section>

          <section className="v2-assistant-editor-section" aria-labelledby="assistant-instructions-heading">
            <h3 id="assistant-instructions-heading">Instructions</h3>
            <p>What this assistant should always do. Written once, applied to every message it runs.</p>
            <label className="v2-sr-only" htmlFor="assistant-editor-system">Assistant instructions</label>
            <textarea
              disabled={locked}
              id="assistant-editor-system"
              maxLength={ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH}
              placeholder="Define the assistant’s role, priorities and response style."
              rows={7}
              value={draft.systemPrompt}
              onChange={(event) => editor.onChange({ systemPrompt: event.currentTarget.value })}
            />
          </section>

          <details className="v2-assistant-disclosure">
            <summary className="v2-focusable">
              <UiV2Icon name="chevron-right" />
              <span><strong>Starter prompts</strong><small>Up to four openers shown on a blank chat with this assistant.</small></span>
            </summary>
            <div className="v2-assistant-disclosure-body">
              {draft.starterPrompts.map((starter, index) => (
                <div className="v2-assistant-starter" key={index}>
                  <label className="v2-sr-only" htmlFor={`assistant-editor-starter-${index}`}>Starter prompt {index + 1}</label>
                  <input
                    disabled={locked}
                    id={`assistant-editor-starter-${index}`}
                    maxLength={ASSISTANT_STARTER_PROMPT_MAX_LENGTH}
                    value={starter}
                    onChange={(event) => updateStarter(index, event.currentTarget.value)}
                  />
                  <UiV2IconButton
                    disabled={locked}
                    icon="close"
                    label={`Remove starter prompt ${index + 1}`}
                    onClick={() => editor.onChange({ starterPrompts: draft.starterPrompts.filter((_, position) => position !== index) })}
                  />
                </div>
              ))}
              {draft.starterPrompts.length < ASSISTANT_MAX_STARTER_PROMPTS ? (
                <UiV2Button disabled={locked} icon="plus" onClick={() => editor.onChange({ starterPrompts: [...draft.starterPrompts, ""] })}>Add starter</UiV2Button>
              ) : null}
            </div>
          </details>

          <details className="v2-assistant-disclosure">
            <summary className="v2-focusable">
              <UiV2Icon name="chevron-right" />
              <span><strong>Advanced instructions</strong><small>A second, developer-level instruction block. Most assistants do not need one.</small></span>
            </summary>
            <div className="v2-assistant-disclosure-body">
              <label className="v2-sr-only" htmlFor="assistant-editor-developer">Advanced instructions</label>
              <textarea
                disabled={locked}
                id="assistant-editor-developer"
                maxLength={ASSISTANT_DEVELOPER_PROMPT_MAX_LENGTH}
                rows={5}
                value={draft.developerPrompt}
                onChange={(event) => editor.onChange({ developerPrompt: event.currentTarget.value })}
              />
            </div>
          </details>

          <AssistantAdvancedControlsV2 editor={editor} locked={locked} />
          {editor.mode === "edit" && editor.publications !== null ? <AssistantSharingV2 editor={editor} locked={locked} /> : null}
        </div>
        <AssistantSetupPanelV2 editor={editor} locked={locked} />
      </div>

      <footer className="v2-assistant-editor-footer">
        <span data-tone={editor.error ? "error" : editor.dirty ? "warn" : "ok"}>
          {editor.error ? (
            <span id="assistant-editor-error" data-error-code={editor.error.code} role="alert">{editor.error.text}</span>
          ) : editor.mode === "create" ? (
            <><UiV2Icon name="check" />{draft.name.trim() && draft.providerModelId ? "Ready to create" : "Finish the required fields"}</>
          ) : editor.dirty ? "Unsaved changes" : <><UiV2Icon name="check" />All changes saved</>}
        </span>
        <p>{editor.mode === "create"
          ? "Nothing is saved until you press Create assistant."
          : "Saving creates a new revision. Chats already running keep the one they started with."}</p>
      </footer>
    </section>
  );
}

export function AssistantHistoryV2({
  busy,
  history,
  notice,
  onDismissNotice
}: Readonly<{
  busy: boolean;
  history: AssistantHistoryView;
  notice: LibraryNotice | null;
  onDismissNotice(): void;
}>) {
  const newest = history.entries.reduce((current, entry) => Math.max(current, entry.revisionNumber), 0);
  const locked = busy || history.restoring;
  const viewed = history.viewedRevision;
  return (
    <section className="v2-assistant-history" data-testid="assistant-history">
      <header>
        <div><h2>Revision history</h2><p>{history.assistantName}</p></div>
        <UiV2Button disabled={locked} onClick={history.onBack}>Back to assistant</UiV2Button>
      </header>
      {notice ? <AssistantNoticeV2 notice={notice} onDismiss={onDismissNotice} /> : null}
      <div className="v2-assistant-history-layout" data-detail={Boolean(viewed) || undefined}>
        <div>
          {history.loading ? <p role="status"><span className="v2-spinner" aria-hidden="true" />Loading revision history…</p> : null}
          {!history.loading && history.entries.length === 0 ? <p>No revisions yet.</p> : null}
          <ul aria-label="Revisions">
            {history.entries.map((entry) => (
              <li key={entry.revisionNumber}>
                <span>
                  <strong>Revision {entry.revisionNumber}</strong>
                  <small>{entry.authorDisplayName ?? "Unknown author"} · {new Date(entry.createdAt).toLocaleString()}</small>
                  {entry.changedSections.length ? <small>Changed: {entry.changedSections.map(historySectionLabel).join(", ")}</small> : null}
                </span>
                <div>
                  <UiV2Button disabled={locked} onClick={() => history.onView(entry.revisionNumber)}>View</UiV2Button>
                  {entry.revisionNumber !== newest ? <UiV2Button disabled={locked} onClick={() => history.onRestore(entry.revisionNumber)}>Restore revision {entry.revisionNumber}</UiV2Button> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
        {viewed ? (
          <section className="v2-assistant-revision-detail" aria-label={`Revision ${viewed.revisionNumber} content`}>
            <h3>Revision {viewed.revisionNumber} · read-only</h3>
            <p>Restore creates a new revision from this content.</p>
            <dl>
              <div><dt>Name</dt><dd>{viewed.name}</dd></div>
              <div><dt>Description</dt><dd>{viewed.description || "No description."}</dd></div>
              <div><dt>Instructions</dt><dd><pre>{viewed.systemPrompt || "No instructions."}</pre></dd></div>
              <div><dt>Advanced instructions</dt><dd><pre>{viewed.developerPrompt || "None."}</pre></dd></div>
              <div><dt>Starter prompts</dt><dd>{viewed.starterPrompts.length ? viewed.starterPrompts.join(" · ") : "None."}</dd></div>
            </dl>
          </section>
        ) : null}
      </div>
    </section>
  );
}

export function AssistantLibraryV2({
  onRequestClose,
  view
}: Readonly<{
  onRequestClose?(): void;
  view: AssistantLibraryView;
}>) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dirty = view.task === "editor" && Boolean(view.editor?.dirty);
  useBeforeUnloadGuard(dirty);
  const requestClose = () => {
    if (onRequestClose) {
      onRequestClose();
      return;
    }
    if (dirty) setConfirmingDiscard(true);
    else view.editor?.onCancel();
  };
  return (
    <>
      {view.task === "editor" && view.editor ? (
        <AssistantEditorV2
          busy={view.busy}
          editor={view.editor}
          notice={view.notice}
          onDismissNotice={view.onDismissNotice}
          onRequestClose={requestClose}
        />
      ) : view.task === "history" && view.history ? (
        <AssistantHistoryV2
          busy={view.busy}
          history={view.history}
          notice={view.notice}
          onDismissNotice={view.onDismissNotice}
        />
      ) : null}
      {confirmingDiscard ? (
        <DiscardChangesConfirmationDialog
          label="assistant draft"
          onCancel={() => setConfirmingDiscard(false)}
          onConfirm={() => {
            setConfirmingDiscard(false);
            view.editor?.onCancel();
          }}
        />
      ) : null}
    </>
  );
}
