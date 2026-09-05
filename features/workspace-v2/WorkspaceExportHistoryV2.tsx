"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspaceExports } from "@/components/app-shell/useWorkspaceExports";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { GeneratedFilesV2 } from "@/features/answer-outputs-v2/AnswerOutputsV2";

export function WorkspaceExportHistoryV2({ branchKey, canSave, chatId, onClose, onMessage, onUse }: Readonly<{
  branchKey: string | null;
  canSave: boolean;
  chatId: string;
  onClose(): void;
  onMessage(messageId: string): void;
  onUse?(attachmentId: string, fileName: string): Promise<boolean>;
}>) {
  const history = useWorkspaceExports(chatId, branchKey);
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ onClose });
  const [using, setUsing] = useState(false);
  const [useError, setUseError] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  if (!portalReady) return null;
  return createPortal(
    <div className="v2-export-history-layer">
      <button className="v2-export-history-scrim" aria-label="Dismiss export history" tabIndex={-1} onClick={onClose} />
      <section className="v2-export-history" aria-label="Export history" aria-modal="true" role="dialog" ref={dialogRef} onKeyDown={onDialogKeyDown}>
        <header>
          <h2>Export history</h2>
          <UiV2IconButton icon="close" label="Close export history" ref={initialFocusRef} onClick={onClose} />
        </header>
        <p>Completed file sets from this branch. Earlier downloads stay unchanged.</p>
        {history.error ? <p role="alert">Export history could not be loaded. <UiV2Button onClick={history.refresh}>Retry</UiV2Button></p> : null}
        {useError ? <p role="alert">This file could not be attached. Try again from the chat.</p> : null}
        {history.busy && history.exports.length === 0 ? <p role="status">Loading exports…</p> : null}
        {!history.busy && !history.error && history.exports.length === 0 ? <p>No completed exports yet.</p> : null}
        <ol className="v2-export-history-entries" aria-label="Exports">
          {history.exports.map((entry) => (
            <li key={entry.messageId}>
              <div className="v2-export-history-entry-heading">
                <time dateTime={entry.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt))}</time>
                <UiV2Button onClick={() => onMessage(entry.messageId)}>Go to answer</UiV2Button>
              </div>
              <GeneratedFilesV2
                canSave={canSave}
                files={entry.files}
                useDisabled={using}
                onUseFile={onUse ? (id, fileName) => {
                  setUsing(true);
                  setUseError(false);
                  void onUse(id, fileName).then((used) => {
                    if (!active.current) return;
                    if (used) onClose();
                    else setUseError(true);
                  }, () => { if (active.current) setUseError(true); })
                    .finally(() => { if (active.current) setUsing(false); });
                } : undefined}
              />
            </li>
          ))}
        </ol>
        {history.nextCursor ? <UiV2Button disabled={history.busy} onClick={history.loadMore}>Load earlier exports</UiV2Button> : null}
      </section>
    </div>, document.body
  );
}
