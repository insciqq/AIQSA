import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import type { FolderSummary } from "@/components/app-shell/types";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import type { KnowledgeBaseSummary } from "@/lib/contracts/knowledge";
import { useState } from "react";
import { useDialogFocus } from "./useDialogFocus";

export function ProjectSettingsDialog({
  folder,
  knowledgeBaseIds = [],
  knowledgeBases = [],
  knowledgeDataError = null,
  knowledgeDataState = "ready",
  onCancel,
  onKnowledgeBaseIdsChange = () => {},
  onRetryKnowledge = () => {},
  onSave,
  restoreFocus,
  saving
}: {
  folder: FolderSummary;
  knowledgeBaseIds?: string[];
  knowledgeBases?: KnowledgeBaseSummary[];
  knowledgeDataError?: string | null;
  knowledgeDataState?: "error" | "loading" | "ready";
  onCancel(): void;
  onKnowledgeBaseIdsChange?(value: string[]): void;
  onRetryKnowledge?(): void;
  onSave(): void;
  restoreFocus?(): HTMLElement | null;
  saving: boolean;
}) {
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const requestCancel = () => {
    if (saving) return;
    if (JSON.stringify(knowledgeBaseIds) !== JSON.stringify(folder.defaultKnowledgePlan?.baseIds ?? [])) {
      setDiscardConfirmationOpen(true);
      return;
    }
    onCancel();
  };
  const dialogRef = useDialogFocus<HTMLDivElement>({
    autoFocus: !discardConfirmationOpen,
    closeOnEscape: !discardConfirmationOpen && !saving,
    containFocus: !discardConfirmationOpen,
    onClose: requestCancel,
    restoreFocus
  });

  return (
    <div
      className="v2-folder-knowledge-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestCancel();
      }}
    >
      <div
        ref={dialogRef}
        aria-busy={saving || undefined}
        aria-hidden={discardConfirmationOpen || undefined}
        aria-label={`Default Knowledge for ${folder.name}`}
        aria-modal="true"
        className="v2-folder-knowledge-dialog"
        inert={discardConfirmationOpen || undefined}
        role="dialog"
      >
        <header className="v2-folder-knowledge-header">
          <div>
            <h2>Default Knowledge</h2>
            <p>{folder.name}</p>
          </div>
          <UiV2IconButton
            disabled={saving}
            icon="close"
            label="Close Default Knowledge"
            onClick={requestCancel}
          />
        </header>
        <div className="v2-folder-knowledge-body">
          <fieldset className="v2-folder-knowledge-fieldset">
            <legend>Default Knowledge plan</legend>
            <p>
              Used for future runs in this folder unless a chat or explicit next-run plan overrides it.
              Each selected base contributes its current ready documents.
            </p>
            <div className="v2-folder-knowledge-options">
              {knowledgeBaseIds
                .filter((baseId) => !knowledgeBases.some((base) => base.id === baseId))
                .map((baseId) => {
                  const order = knowledgeBaseIds.indexOf(baseId) + 1;
                  return (
                    <label
                      className="v2-folder-knowledge-option"
                      data-selected="true"
                      data-unavailable="true"
                      key={baseId}
                    >
                      <input
                        checked
                        disabled={saving}
                        type="checkbox"
                        onChange={() => onKnowledgeBaseIdsChange(knowledgeBaseIds.filter((id) => id !== baseId))}
                      />
                      <span>Unavailable base · selection retained · order {order}</span>
                    </label>
                  );
                })}
              {knowledgeBases.map((base) => {
                const checked = knowledgeBaseIds.includes(base.id);
                const unavailable = base.archived;
                return (
                  <label
                    className="v2-folder-knowledge-option"
                    data-selected={checked || undefined}
                    data-unavailable={unavailable || undefined}
                    key={base.id}
                  >
                    <input
                      checked={checked}
                      disabled={saving || (!checked && unavailable)}
                      type="checkbox"
                      onChange={(event) => onKnowledgeBaseIdsChange(
                        event.currentTarget.checked
                          ? [...knowledgeBaseIds, base.id]
                          : knowledgeBaseIds.filter((id) => id !== base.id)
                      )}
                    />
                    <span>
                      {base.name}{unavailable ? checked ? " · unavailable, retained" : " · unavailable" : ""}
                      {checked ? ` · order ${knowledgeBaseIds.indexOf(base.id) + 1}` : ""}
                    </span>
                  </label>
                );
              })}
              {knowledgeDataState === "loading" && knowledgeBases.length === 0 ? (
                <p className="v2-folder-knowledge-state" role="status">Loading Knowledge bases…</p>
              ) : null}
              {knowledgeDataState === "error" ? (
                <div className="v2-folder-knowledge-error" role="alert">
                  <p>{knowledgeDataError ?? "Knowledge bases could not be loaded."}</p>
                  <UiV2Button disabled={saving} onClick={onRetryKnowledge}>Retry Knowledge</UiV2Button>
                </div>
              ) : null}
              {knowledgeDataState === "ready" && knowledgeBases.length === 0 && knowledgeBaseIds.length === 0 ? (
                <p className="v2-folder-knowledge-state">No Knowledge bases are available. The folder default is Off.</p>
              ) : null}
            </div>
          </fieldset>
        </div>
        <footer className="v2-folder-knowledge-footer">
          <UiV2Button disabled={saving} onClick={requestCancel}>Cancel</UiV2Button>
          <UiV2Button busy={saving} tone="primary" onClick={onSave}>
            {saving ? "Saving…" : "Save"}
          </UiV2Button>
        </footer>
      </div>
      {discardConfirmationOpen ? (
        <DiscardChangesConfirmationDialog
          label="Default Knowledge"
          onCancel={() => setDiscardConfirmationOpen(false)}
          onConfirm={() => {
            setDiscardConfirmationOpen(false);
            onCancel();
          }}
        />
      ) : null}
    </div>
  );
}
