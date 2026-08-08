import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import type { FolderSummary } from "@/components/app-shell/types";
import { KNOWLEDGE_PLAN_MAX_BASES, type KnowledgeBaseSummary } from "@/lib/contracts/knowledge";
import { X } from "lucide-react";
import { useState } from "react";
import { useDialogFocus } from "./useDialogFocus";

export function ProjectSettingsDialog({
  folder,
  knowledgeBaseIds = [],
  knowledgeBases = [],
  knowledgeDataError = null,
  knowledgeDataState = "ready",
  memoryDraft,
  onCancel,
  onKnowledgeBaseIdsChange = () => {},
  onMemoryDraftChange,
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
  memoryDraft: string;
  onCancel(): void;
  onKnowledgeBaseIdsChange?(value: string[]): void;
  onMemoryDraftChange(value: string): void;
  onRetryKnowledge?(): void;
  onSave(): void;
  restoreFocus?(): HTMLElement | null;
  saving: boolean;
}) {
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const requestCancel = () => {
    if (saving) {
      return;
    }
    if (
      memoryDraft !== folder.projectMemory ||
      JSON.stringify(knowledgeBaseIds) !== JSON.stringify(folder.defaultKnowledgePlan?.baseIds ?? [])
    ) {
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
      className="fixed inset-0 z-40 flex items-end justify-center bg-scrim/60 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[max(.75rem,env(safe-area-inset-top))] sm:items-center sm:pb-[max(.75rem,env(safe-area-inset-bottom))] sm:pl-[max(.75rem,env(safe-area-inset-left))] sm:pr-[max(.75rem,env(safe-area-inset-right))]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          requestCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="pop-enter flex max-h-[calc(100dvh-max(.75rem,env(safe-area-inset-top)))] w-full max-w-lg flex-col overflow-hidden rounded-t-panel border border-b-0 border-trace-subtle bg-overlay-surface text-ink shadow-overlay sm:max-h-[calc(100dvh-1.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:rounded-panel sm:border [@media(max-height:32rem)]:max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]"
        role="dialog"
        aria-modal="true"
        aria-hidden={discardConfirmationOpen || undefined}
        aria-label={`Project Settings ${folder.name}`}
        aria-busy={saving || undefined}
        inert={discardConfirmationOpen || undefined}
      >
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-trace-subtle px-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">Project settings</h2>
            <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{folder.name}</p>
          </div>
          <button
            className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
            type="button"
            aria-label="Close project settings"
            disabled={saving}
            onClick={requestCancel}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
          <label className="mb-1 block text-xs font-medium text-ink-secondary" htmlFor="project-instructions">
            Project instructions
          </label>
          <textarea
            className="h-48 min-h-32 w-full resize-y rounded-control border border-control-boundary bg-answer-paper p-3 text-sm leading-6 text-ink outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled"
            id="project-instructions"
            aria-label="Project instructions"
            aria-describedby="project-instructions-help"
            disabled={saving}
            value={memoryDraft}
            onChange={(event) => onMemoryDraftChange(event.target.value)}
          />
          <p className="mt-2 text-xs leading-5 text-ink-muted" id="project-instructions-help">
            Sent to the model as context for future messages in every chat in this project. Existing messages and
            replies are unchanged.
          </p>
          <fieldset className="mt-6 border-t border-trace-subtle pt-5">
            <legend className="text-xs font-semibold text-ink">Default Knowledge plan</legend>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              Used for future runs in this project unless a chat or explicit next-run plan overrides it. Choose up to three bases.
            </p>
            <div className="mt-3 space-y-2">
              {knowledgeBaseIds
                .filter((baseId) => !knowledgeBases.some((base) => base.id === baseId))
                .map((baseId) => {
                  const order = knowledgeBaseIds.indexOf(baseId) + 1;
                  return (
                    <label className="flex min-h-touch items-center gap-2 rounded-control bg-control-selected px-3 text-xs text-caution" key={baseId}>
                      <input
                        checked
                        className="size-4 shrink-0 accent-proof"
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
                  <label className={`flex min-h-touch items-center gap-2 rounded-control px-3 text-xs ${checked ? "bg-control-selected" : "bg-control-surface"}`} key={base.id}>
                    <input
                      checked={checked}
                      className="size-4 shrink-0 accent-proof"
                      disabled={saving || (!checked && (unavailable || knowledgeBaseIds.length >= KNOWLEDGE_PLAN_MAX_BASES))}
                      type="checkbox"
                      onChange={(event) => onKnowledgeBaseIdsChange(
                        event.currentTarget.checked
                          ? [...knowledgeBaseIds, base.id]
                          : knowledgeBaseIds.filter((id) => id !== base.id)
                      )}
                    />
                    <span className={`min-w-0 break-words [overflow-wrap:anywhere] ${unavailable ? "text-caution" : "text-ink-secondary"}`}>
                      {base.name}{unavailable ? checked ? " · unavailable, retained" : " · unavailable" : ""}
                      {checked ? ` · order ${knowledgeBaseIds.indexOf(base.id) + 1}` : ""}
                    </span>
                  </label>
                );
              })}
              {knowledgeDataState === "loading" && knowledgeBases.length === 0 ? (
                <p className="text-xs text-ink-muted" role="status">Loading Knowledge bases…</p>
              ) : null}
              {knowledgeDataState === "error" ? (
                <div className="rounded-control border border-critical/30 bg-critical/10 p-3 text-xs text-critical" role="alert">
                  <p>{knowledgeDataError ?? "Knowledge bases could not be loaded."}</p>
                  <button
                    className="mt-2 h-touch rounded-control bg-control-surface px-3 font-semibold text-ink outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                    type="button"
                    disabled={saving}
                    onClick={onRetryKnowledge}
                  >
                    Retry Knowledge
                  </button>
                </div>
              ) : null}
              {knowledgeDataState === "ready" && knowledgeBases.length === 0 && knowledgeBaseIds.length === 0 ? (
                <p className="text-xs text-ink-muted">No Knowledge bases are available. The project default is Off.</p>
              ) : null}
            </div>
          </fieldset>
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-trace-subtle px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:pb-3">
          <button
            className="h-touch rounded-control bg-control-surface px-3 text-sm font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            disabled={saving}
            onClick={requestCancel}
          >
            Cancel
          </button>
          <button
            className="h-touch rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast outline-none hover:bg-proof-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface disabled:opacity-50 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            disabled={saving}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
      {discardConfirmationOpen ? (
        <DiscardChangesConfirmationDialog
          label="project settings"
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
