"use client";

import { useRef, type ChangeEvent } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { SettingsRowV2 } from "@/features/settings-v2/SettingsV2";
import {
  cancelChatImport,
  chatImportRunning,
  dismissChatImport,
  startChatImport,
  useChatImportState
} from "./chatImportClient";
import type { ChatImportState } from "./chatImportRunner";
import { chatsCount, failuresCount, messagesCount, skippedSummary } from "./importReport";
import "./chat-import.css";

/** `.tar.gz` is matched through `.gz`: multi-dot extensions are unreliable in `accept`. */
const ACCEPTED_FILES = ".json,.zip,.gz,.tgz,application/json,application/zip,application/gzip,application/x-gzip";
const FAILED_SHOWN = 100;

function progressText(state: ChatImportState): string {
  if (state.phase === "stopping") return "Stopping after the chats being saved now…";
  const total = Math.max(state.total, state.processed);
  if (total === 0) return "Reading the export…";
  return `Importing chats: ${state.processed} of ${total}`;
}

function heading(state: ChatImportState): string {
  return state.phase === "cancelled"
    ? "Import cancelled"
    : state.phase === "failed" || state.phase === "account_changed" ? "Import stopped" : "Import finished";
}

function ChatImportProgressV2({ state }: Readonly<{ state: ChatImportState }>) {
  const total = Math.max(state.total, state.processed);
  return (
    <section aria-label="Chat import" className="v2-chat-import" data-testid="chat-import-progress">
      <p aria-live="polite" role="status">{progressText(state)}</p>
      {total > 0 ? (
        <div
          aria-label="Chats processed"
          aria-valuemax={total}
          aria-valuemin={0}
          aria-valuenow={state.processed}
          className="v2-chat-import-bar"
          role="progressbar"
        >
          <span style={{ width: `${(100 * state.processed) / total}%` }} />
        </div>
      ) : null}
    </section>
  );
}

function ChatImportReportV2({ onDismiss, state }: Readonly<{
  onDismiss(): void;
  state: ChatImportState;
}>) {
  if (state.phase === "account_changed") {
    // The import's details belonged to the account that is gone: only the reason remains.
    return (
      <section aria-label="Import report" className="v2-chat-import" data-testid="chat-import-report">
        <h3>{heading(state)}</h3>
        <p role="alert">{state.error}</p>
        <div className="v2-chat-import-actions">
          <UiV2Button onClick={onDismiss}>Done</UiV2Button>
        </div>
      </section>
    );
  }
  const skipped = skippedSummary(state.skipped);
  const shown = state.failed.slice(0, FAILED_SHOWN);
  const fileFailures = state.failed.filter((failure) => failure.file).length;
  return (
    <section aria-label="Import report" className="v2-chat-import" data-testid="chat-import-report">
      <h3>{heading(state)}</h3>
      <ul aria-live="polite" className="v2-chat-import-summary">
        <li>
          {state.importedChats > 0
            ? `Imported ${chatsCount(state.importedChats)} (${messagesCount(state.importedMessages)}). They keep their original dates in the chat list.`
            : "No new chats were imported."}
        </li>
        {state.alreadyImported > 0 ? <li>{`${chatsCount(state.alreadyImported)} already imported.`}</li> : null}
        {skipped ? <li>{`Not imported, marked in the messages: ${skipped}.`}</li> : null}
        {state.phase === "cancelled" ? <li>Chats imported before you cancelled stay.</li> : null}
        {state.error ? <li role="alert">{state.error}</li> : null}
      </ul>
      {state.failed.length > 0 ? (
        <>
          <p>{`Couldn't import ${failuresCount(state.failed.length - fileFailures, fileFailures)}:`}</p>
          <ul className="v2-chat-import-failed" data-testid="chat-import-failed">
            {shown.map((failure, index) => (
              <li key={`${index}-${failure.title}`}>
                <strong>{failure.title}</strong>
                {` — ${failure.reason}`}
              </li>
            ))}
            {state.failed.length > shown.length ? <li>{`…and ${state.failed.length - shown.length} more.`}</li> : null}
          </ul>
        </>
      ) : null}
      <div className="v2-chat-import-actions">
        <UiV2Button onClick={onDismiss}>Done</UiV2Button>
      </div>
    </section>
  );
}

/**
 * Settings → Data: import AIQSA exports. The browser reads the picked files
 * in a worker and sends only normalized chats; progress counts settled chats
 * and the report names every chat that was not imported, with its reason.
 */
export function ChatImportRowV2({ accountId, onImported }: Readonly<{
  /** The signed-in account: the import is started for it and stops if it changes. */
  accountId: string;
  onImported?(): void;
}>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const state = useChatImportState(accountId);
  const running = chatImportRunning(state);
  const pick = () => inputRef.current?.click();
  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    // Picking the same file again must fire `change` again.
    event.currentTarget.value = "";
    if (files.length) startChatImport(files, { accountId, ...(onImported ? { onImported } : {}) });
  };
  return (
    <>
      <SettingsRowV2
        description="Add chats from an AIQSA export: a chat's .json file or the bulk .tar.gz archive. They keep their titles, dates and branches and never use Memory."
        testId="settings-import-chats"
        title="Import chats"
      >
        <input
          ref={inputRef}
          accept={ACCEPTED_FILES}
          aria-label="Export files to import"
          data-testid="settings-import-input"
          hidden
          multiple
          tabIndex={-1}
          type="file"
          onChange={onFiles}
        />
        {running ? (
          <UiV2Button busy={state?.phase === "stopping"} onClick={cancelChatImport}>Cancel</UiV2Button>
        ) : (
          <UiV2Button icon="file" onClick={pick}>Import…</UiV2Button>
        )}
      </SettingsRowV2>
      {state && running ? <ChatImportProgressV2 state={state} /> : null}
      {state && !running ? <ChatImportReportV2 state={state} onDismiss={dismissChatImport} /> : null}
    </>
  );
}
