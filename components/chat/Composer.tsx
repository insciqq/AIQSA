"use client";

import { formatTokenCount } from "@/components/app-shell/shellFormatting";
import { isImeCompositionEvent } from "@/components/keyboard";
import {
  BarChart3,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Send,
  Square,
  X
} from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";

export type ComposerAttachment = {
  byteSize?: number;
  extractedText?: string | null;
  fileName: string;
  id: string;
  kind: "document" | "image" | "pdf";
  metadata?: unknown;
  mimeType?: string;
  status?: string;
};

const documentAttachmentAccept =
  ".txt,.md,.markdown,.csv,.json,.html,.htm,text/plain,text/markdown,text/csv,application/json,text/html";
const imageAttachmentAccept = "image/png,image/jpeg,image/webp,image/gif";

export type ComposerAttachmentPolicy = {
  documents: boolean;
  images: boolean;
  pdfs: boolean;
};

const defaultAttachmentPolicy: ComposerAttachmentPolicy = {
  documents: true,
  images: true,
  pdfs: true
};

export type ComposerUsageStats = {
  activeBranchMessageCount: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
};

export type ComposerProps = {
  attachmentPolicy?: ComposerAttachmentPolicy;
  attachments: ComposerAttachment[];
  controls?: ReactNode;
  contextLine?: string | null;
  disabled?: boolean;
  disabledHint?: string | null;
  disabledHintLive?: boolean;
  editing?: boolean;
  editPending?: boolean;
  onChange(value: string): void;
  onCancelEdit?(): void;
  onRemoveAttachment(id: string): void;
  onRejectedFiles?(files: readonly File[]): void;
  onSend(): void;
  onStop?(): void;
  onUploadFiles?(files: FileList | readonly File[]): void;
  operationError?: string | null;
  sendDisabled?: boolean;
  stopDisabled?: boolean;
  streaming?: boolean;
  uploading?: boolean;
  usageStats?: ComposerUsageStats | null;
  value: string;
};

function hasFileTransfer(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes("Files");
}

function StopAction({ onStop, stopDisabled }: { onStop(): void; stopDisabled: boolean }) {
  return (
    <button
      className="inline-flex h-touch min-w-[72px] items-center justify-center gap-2 rounded-control bg-critical px-3 text-sm font-semibold text-proof-contrast outline-none hover:bg-critical/85 focus-visible:ring-2 focus-visible:ring-critical/55 disabled:cursor-not-allowed disabled:opacity-50 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
      type="button"
      aria-label="Stop response"
      aria-describedby={stopDisabled ? "composer-stop-disabled-hint" : undefined}
      title="Stop response"
      disabled={stopDisabled}
      onClick={onStop}
    >
      <Square className="size-4 fill-current" aria-hidden="true" />
      Stop
    </button>
  );
}

export function Composer({
  attachmentPolicy = defaultAttachmentPolicy,
  attachments,
  controls,
  contextLine = null,
  disabled = false,
  disabledHint = null,
  disabledHintLive = true,
  editing = false,
  editPending = false,
  onChange,
  onCancelEdit,
  onRemoveAttachment,
  onRejectedFiles,
  onSend,
  onStop,
  onUploadFiles,
  operationError = null,
  sendDisabled = false,
  stopDisabled = false,
  streaming = false,
  uploading = false,
  usageStats = null,
  value
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const usagePopoverRef = useRef<HTMLDivElement>(null);
  const usageTriggerRef = useRef<HTMLButtonElement>(null);
  const dragDepthRef = useRef(0);
  const [usageOpen, setUsageOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const attachmentAccept = [
    attachmentPolicy.documents ? documentAttachmentAccept : null,
    attachmentPolicy.pdfs ? "application/pdf" : null,
    attachmentPolicy.images ? imageAttachmentAccept : null
  ]
    .filter(Boolean)
    .join(",");
  const modelAcceptsAttachments = Boolean(attachmentAccept);
  const hasSendableContent = value.trim().length > 0 || (!editing && attachments.length > 0);
  const canSend =
    hasSendableContent &&
    !disabled &&
    !sendDisabled &&
    !streaming &&
    !uploading &&
    !editPending;
  const canUploadDroppedFiles =
    Boolean(onUploadFiles) && modelAcceptsAttachments && !disabled && !streaming && !uploading;
  const attachmentDisabled =
    !onUploadFiles || !modelAcceptsAttachments || disabled || streaming || uploading;
  const attachmentDisabledReason = !attachmentDisabled
    ? null
    : disabledHint
      ? disabledHint
      : uploading
        ? "Uploading files…"
        : streaming
          ? "Attachments are unavailable while a response is streaming."
          : !modelAcceptsAttachments
            ? "The selected model does not support file attachments."
            : !onUploadFiles
              ? "File attachments are unavailable."
              : "Attachments are unavailable.";
  const attachmentDescriptionId = attachmentDisabled
    ? disabledHint
      ? "composer-disabled-hint"
      : uploading
        ? "composer-upload-status"
        : "composer-attachment-disabled-hint"
    : undefined;
  const sendDescriptionId = disabledHint
    ? "composer-disabled-hint"
    : editPending
      ? "composer-edit-pending-status"
      : uploading
        ? "composer-upload-status"
        : undefined;
  const stats = usageStats ?? {
    activeBranchMessageCount: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0
  };
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (!usageOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (usagePopoverRef.current && !usagePopoverRef.current.contains(event.target as Node)) {
        setUsageOpen(false);
        restoreUsageTriggerIfFocusLost();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setUsageOpen(false);
        restoreUsageTriggerIfFocusLost(true);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [usageOpen]);

  function restoreUsageTriggerIfFocusLost(force = false) {
    window.setTimeout(() => {
      const activeElement = document.activeElement;
      const focusWasLost =
        !(activeElement instanceof HTMLElement) ||
        activeElement === document.body ||
        !activeElement.isConnected;

      if (force || focusWasLost) {
        usageTriggerRef.current?.focus({ preventScroll: true });
      }
    }, 0);
  }

  function clearDragState() {
    dragDepthRef.current = 0;
    setDragActive(false);
  }

  function updateDropEffect(event: DragEvent<HTMLDivElement>) {
    event.dataTransfer.dropEffect = canUploadDroppedFiles ? "copy" : "none";
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    updateDropEffect(event);
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    updateDropEffect(event);
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer.files;
    clearDragState();

    if (files.length === 0 || !canUploadDroppedFiles) {
      return;
    }

    submitFiles(files);
  }

  function submitFiles(files: FileList | readonly File[]) {
    const supported: File[] = [];
    const rejected: File[] = [];

    for (const file of Array.from(files)) {
      const name = file.name.toLowerCase();
      const isImage =
        ["image/gif", "image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        /\.(?:gif|jpe?g|png|webp)$/.test(name);
      const isPdf = file.type === "application/pdf" || name.endsWith(".pdf");
      const isDocument =
        ["application/json", "text/csv", "text/html", "text/markdown", "text/plain"].includes(file.type) ||
        /\.(?:csv|html?|json|md|markdown|txt)$/.test(name);
      const accepted = isImage
        ? attachmentPolicy.images
        : isPdf
          ? attachmentPolicy.pdfs
          : isDocument && attachmentPolicy.documents;

      (accepted ? supported : rejected).push(file);
    }

    if (supported.length > 0) {
      onUploadFiles?.(supported);
    }
    if (rejected.length > 0) {
      onRejectedFiles?.(rejected);
    }
  }

  return (
    <form
      className="shrink-0 bg-research-canvas pb-[max(.5rem,env(safe-area-inset-bottom))] pl-[max(.5rem,env(safe-area-inset-left))] pr-[max(.5rem,env(safe-area-inset-right))] pt-2 sm:pb-[max(.75rem,env(safe-area-inset-bottom))] sm:pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!pb-[max(.25rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!pt-1"
      data-testid="composer-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) {
          onSend();
        }
      }}
    >
      <div className="mx-auto w-full max-w-reading">
        <div
          className={[
            "relative overflow-visible rounded-composer border bg-composer-surface shadow-float",
            dragActive ? "border-proof/60 ring-2 ring-proof/20" : "border-trace-strong/70"
          ].join(" ")}
          data-drop-active={dragActive ? "true" : undefined}
          data-testid="composer-drop-zone"
          aria-busy={uploading || editPending || undefined}
          onDragEnd={clearDragState}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {dragActive ? (
            <div
              className={[
                "pointer-events-none absolute inset-1 z-40 grid place-items-center rounded-panel border bg-overlay-surface/95 text-sm font-semibold",
                canUploadDroppedFiles
                  ? "border-proof/45 text-proof"
                  : "border-caution/45 text-caution"
              ].join(" ")}
              role="status"
            >
              {canUploadDroppedFiles ? "Drop files to attach" : "Attachments unavailable right now"}
            </div>
          ) : null}

          {editing ? (
            <div
              className="flex items-center justify-between gap-3 rounded-t-composer border-b border-proof/20 bg-proof/[0.06] px-3 py-2 text-xs text-proof"
              data-testid="edit-branch-strip"
            >
              <span
                className="inline-flex min-w-0 items-center gap-2"
                id={editPending ? "composer-edit-pending-status" : undefined}
                role={editPending ? "status" : undefined}
              >
                <GitBranch className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {editPending ? "Saving edited branch…" : "Editing a message — Send creates a new branch"}
                </span>
              </span>
              <button
                className="h-touch shrink-0 rounded-control px-2 text-xs font-medium hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                type="button"
                aria-describedby={editPending ? "composer-edit-pending-status" : undefined}
                disabled={editPending}
                title={editPending ? "Wait for the edited branch to finish saving" : "Cancel edit"}
                onClick={onCancelEdit}
              >
                Cancel edit
              </button>
            </div>
          ) : null}

          {disabledHint ? (
            <div
              className="border-b border-caution/20 bg-caution/[0.07] px-3 py-2 text-xs text-caution"
              data-testid="composer-disabled-hint"
              id="composer-disabled-hint"
              role={disabledHintLive ? "status" : undefined}
            >
              {disabledHint}
            </div>
          ) : null}

          {operationError ? (
            <div
              className="border-b border-critical/20 bg-critical/[0.07] px-3 py-2 text-xs text-critical"
              data-testid="composer-operation-error"
              role="alert"
            >
              {operationError}
            </div>
          ) : null}

          {streaming && stopDisabled ? (
            <span className="sr-only" id="composer-stop-disabled-hint">
              Starting run…
            </span>
          ) : null}

          {attachments.length > 0 ? (
            <ul
              className="flex max-h-28 flex-wrap gap-2 overflow-y-auto border-b border-trace-subtle px-3 py-2 [@media(max-height:32rem)]:!max-h-12 [@media(max-height:32rem)]:!flex-nowrap [@media(max-height:32rem)]:!py-1"
              data-testid="attachment-chip-list"
              aria-label="Attachments"
            >
              {attachments.map((attachment) => (
                <li
                  className="flex min-h-control-sm max-w-[min(15rem,100%)] items-center gap-1.5 rounded-control bg-control-selected pl-2 text-xs text-ink-secondary [@media(max-height:32rem)]:!min-h-8"
                  data-testid="attachment-chip"
                  key={attachment.id}
                  title={attachment.fileName}
                >
                  {attachment.kind === "image" ? (
                    <ImageIcon className="size-3.5 text-ink-muted" aria-hidden="true" />
                  ) : (
                    <FileText className="size-3.5 text-ink-muted" aria-hidden="true" />
                  )}
                  <span className="truncate">{attachment.fileName}</span>
                  <button
                    className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proof/55 sm:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
                    type="button"
                    aria-label={`Remove ${attachment.fileName}`}
                    title={`Remove ${attachment.fileName}`}
                    onClick={() => onRemoveAttachment(attachment.id)}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="px-4 pb-2 pt-3 [@media(max-height:32rem)]:!px-3 [@media(max-height:32rem)]:!pb-1 [@media(max-height:32rem)]:!pt-1" data-testid="composer-message-field">
            <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted" htmlFor="composer">
              Message
            </label>
            <textarea
              className="mt-1 block max-h-[200px] min-h-14 w-full min-w-0 resize-none bg-transparent text-[15px] leading-7 text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed disabled:text-ink-disabled sm:min-h-[72px] [@media(max-height:32rem)]:!max-h-20 [@media(max-height:32rem)]:!min-h-10 [@media(max-height:32rem)]:!leading-6 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch"
              aria-describedby={disabledHint ? "composer-disabled-hint" : undefined}
              disabled={disabled}
              id="composer"
              placeholder="Ask AIQSA…"
              ref={textareaRef}
              rows={1}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (isImeCompositionEvent(event)) {
                  return;
                }

                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (canSend) {
                    onSend();
                  }
                }
              }}
            />
          </div>

          <div
            className="flex min-w-0 flex-wrap items-center gap-2 border-t border-trace-subtle px-2 py-2 sm:px-3 [@media(max-height:32rem)]:!py-1"
            data-testid="composer-action-footer"
          >
            {controls ? (
              <div
                className="flex min-w-[min(100%,19rem)] flex-[1_1_22rem] items-center gap-1"
                data-testid="composer-controls-slot"
              >
                {controls}
              </div>
            ) : null}

            <div
              className="flex min-w-0 flex-[1_1_auto] items-center justify-end gap-1.5"
              data-testid="composer-primary-actions"
            >
              {contextLine ? (
                <div
                  className="relative flex min-w-0 items-center gap-1 text-[11px] text-ink-muted"
                  data-testid="composer-usage-line"
                  ref={usagePopoverRef}
                >
                  <button
                    ref={usageTriggerRef}
                    className="inline-flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-control text-xs text-ink-muted hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proof/55 sm:h-control-sm sm:w-auto sm:px-2 [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                    type="button"
                    aria-expanded={usageOpen}
                    aria-haspopup="dialog"
                    aria-label="Open context and usage statistics"
                    data-testid="token-stats-button"
                    onClick={() => setUsageOpen((open) => !open)}
                  >
                    <BarChart3 className="size-3.5" aria-hidden="true" />
                    <span className="hidden sm:inline">Usage</span>
                  </button>
                  {usageOpen ? (
                    <div
                      className="pop-enter absolute bottom-10 right-0 z-30 mb-2 max-h-[min(20rem,calc(100dvh-4rem))] w-[min(320px,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-panel border border-trace-subtle bg-overlay-surface p-3 shadow-overlay"
                      data-testid="token-stats-popover"
                      role="dialog"
                      aria-label="Context and usage statistics"
                    >
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-ink">Context and usage</p>
                        <button
                          className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 lg:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
                          type="button"
                          aria-label="Close context and usage statistics"
                          onClick={() => {
                            setUsageOpen(false);
                            restoreUsageTriggerIfFocusLost(true);
                          }}
                        >
                          <X className="size-4" aria-hidden="true" />
                        </button>
                      </div>
                      <dl className="space-y-2 text-xs">
                        <div>
                          <dt className="text-ink-secondary">Current context</dt>
                          <dd className="mt-1 break-words font-mono leading-5 text-ink [overflow-wrap:anywhere]">
                            {contextLine}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-ink-secondary">Total messages</dt>
                          <dd className="font-mono text-ink">{stats.activeBranchMessageCount}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-ink-secondary">Provider-reported tokens</dt>
                          <dd className="font-mono text-ink">{formatTokenCount(stats.totalTokens)}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-ink-secondary">Total tokens cached</dt>
                          <dd className="font-mono text-ink">{formatTokenCount(stats.cachedInputTokens)}</dd>
                        </div>
                      </dl>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {uploading ? (
                <span className="text-xs text-ink-muted" id="composer-upload-status" role="status">
                  Uploading…
                </span>
              ) : null}
              {attachmentDescriptionId === "composer-attachment-disabled-hint" ? (
                <span className="sr-only" id="composer-attachment-disabled-hint">
                  {attachmentDisabledReason}
                </span>
              ) : null}
              {streaming && stopDisabled ? (
                <span className="text-xs text-ink-muted" role="status">
                  Starting run…
                </span>
              ) : null}
              <label
                className={[
                  "inline-flex h-touch shrink-0 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-ink-secondary focus-within:ring-2 focus-within:ring-proof/55 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
                  uploading
                    ? "cursor-wait bg-control-pressed text-ink"
                    : attachmentDisabled
                      ? "cursor-not-allowed text-ink-disabled opacity-60"
                      : "cursor-pointer hover:bg-control-hover"
                ].join(" ")}
                aria-disabled={attachmentDisabled || undefined}
                data-disabled={attachmentDisabled || undefined}
                title={attachmentDisabledReason ?? "Attach file"}
              >
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Paperclip className="size-4" aria-hidden="true" />
                )}
                <span>{uploading ? "Uploading" : "Attach"}</span>
                <input
                  className="sr-only"
                  type="file"
                  accept={attachmentAccept}
                  aria-label="Attach file"
                  aria-describedby={attachmentDescriptionId}
                  disabled={attachmentDisabled}
                  multiple
                  onChange={(event) => {
                    if (event.target.files && event.target.files.length > 0) {
                      submitFiles(event.target.files);
                    }
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              {streaming && onStop ? (
                <StopAction stopDisabled={stopDisabled} onStop={onStop} />
              ) : (
                <button
                  className={[
                    "inline-flex h-touch min-w-[72px] items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-proof/55 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
                    canSend
                      ? "bg-proof text-proof-contrast hover:bg-proof-hover"
                      : "bg-control-pressed text-ink-disabled"
                  ].join(" ")}
                  type="submit"
                  aria-label="Send message"
                  aria-describedby={sendDescriptionId}
                  title={editPending ? "Saving edited branch…" : "Send message"}
                  disabled={!canSend}
                >
                  <Send className="size-4" aria-hidden="true" />
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
