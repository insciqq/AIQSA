"use client";

import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { ACCOUNT_EXPORT_ALL_CHATS_HREF } from "@/components/app-shell/accountApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import type { DeleteAllPersonalChatsResponse } from "@/lib/contracts/account";
import { useState } from "react";
import { SettingsGroupLabelV2, SettingsRowV2 } from "./SettingsV2";

type DeleteAllState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "confirm" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "done"; result: DeleteAllPersonalChatsResponse }>
  | Readonly<{ kind: "error"; text: string }>;

export function deleteAllSummary(result: DeleteAllPersonalChatsResponse): string {
  const parts: string[] = [];
  if (result.permanentDeletionAvailable) {
    parts.push(`${result.scheduled} chat${result.scheduled === 1 ? "" : "s"} archived and scheduled for permanent deletion`);
  } else {
    parts.push(`${result.archived} chat${result.archived === 1 ? "" : "s"} archived; permanent deletion is not available on this installation`);
  }
  if (result.skipped > 0) {
    parts.push(`${result.skipped} skipped (active run or temporary chat)`);
  }
  return `${parts.join(" · ")}.`;
}

/**
 * Data tab rows that need the server (PRD §4.9): Export all chats and the
 * Danger zone. The destructive action runs only after a confirmation that
 * names its consequence.
 */
export function DataSettingsRowsV2({
  onDeleteAll,
  onDeleted
}: Readonly<{
  onDeleteAll(): Promise<DeleteAllPersonalChatsResponse>;
  onDeleted?(result: DeleteAllPersonalChatsResponse): void;
}>) {
  const [state, setState] = useState<DeleteAllState>({ kind: "idle" });

  const confirmDelete = () => {
    setState({ kind: "busy" });
    void onDeleteAll().then(
      (result) => {
        setState({ kind: "done", result });
        onDeleted?.(result);
      },
      (error) => setState({ kind: "error", text: errorMessage(error) })
    );
  };

  return (
    <>
      <SettingsRowV2
        description="Download every personal chat as Markdown and JSON in one archive. Per-chat export stays in the chat menu."
        testId="settings-export-all"
        title="Export all chats"
      >
        <a
          className="v2-button v2-focusable"
          data-tone="ghost"
          download
          href={ACCOUNT_EXPORT_ALL_CHATS_HREF}
        >
          <UiV2Icon name="share" />
          <span>Export…</span>
        </a>
      </SettingsRowV2>
      <SettingsGroupLabelV2 tone="danger">Danger zone</SettingsGroupLabelV2>
      <SettingsRowV2
        description={state.kind === "done"
          ? deleteAllSummary(state.result)
          : "Moves every personal chat to the archive and schedules permanent deletion. Project chats are not affected."}
        testId="settings-delete-all"
        title="Delete all personal chats"
        tone="danger"
      >
        <UiV2Button
          busy={state.kind === "busy"}
          tone="destructive"
          onClick={() => setState({ kind: "confirm" })}
        >
          Delete…
        </UiV2Button>
        {state.kind === "error" ? (
          <span className="v2-live-menu-error" role="alert">{state.text}</span>
        ) : null}
      </SettingsRowV2>
      {state.kind === "confirm" ? (
        <section
          aria-label="Delete all personal chats"
          aria-modal="true"
          className="v2-settings-confirm"
          role="alertdialog"
        >
          <h2>Delete all personal chats?</h2>
          <p>
            Every personal chat moves to the archive and is scheduled for permanent deletion,
            including its messages and attachments. Chats inside Projects stay untouched.
            This cannot be undone once the deletion runs.
          </p>
          <div>
            <UiV2Button autoFocus onClick={() => setState({ kind: "idle" })}>Keep my chats</UiV2Button>
            <UiV2Button tone="destructive" onClick={confirmDelete}>Delete all personal chats</UiV2Button>
          </div>
        </section>
      ) : null}
    </>
  );
}
