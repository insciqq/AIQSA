"use client";

import { formatTokenCount } from "@/components/app-shell/shellFormatting";
import { isImeCompositionEvent } from "@/components/keyboard";
import { BarChart3, FileText, GitBranch, Image as ImageIcon, Loader2, Paperclip, Send, Square, X } from "lucide-react";
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
const imageAttachmentAccept =
  "image/png,image/jpeg,image/webp,image/gif";

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
  compactProfileControls?: ReactNode;
  controls?: ReactNode;
  contextLine?: string | null;
  disabled?: boolean;
  disabledHint?: string | null;
  disabledHintLive?: boolean;
  editing?: boolean;
  editPending?: boolean;
  onChange(value: string): void;
  onCancelEdit?(): void;
  onRequestExpanded?(): void;
  onRemoveAttachment(id: string): void;
  onRejectedFiles?(files: readonly File[]): void;
  onSend(): void;
  onStop?(): void;
  onUploadFiles?(files: FileList | readonly File[]): void;
  operationError?: string | null;
  readingCollapsed?: boolean;
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

function StopAction({
  inlineReadingMode = false,
  onStop,
  stopDisabled
}: {
  inlineReadingMode?: boolean;
  onStop(): void;
  stopDisabled: boolean;
}) {
  return (
    <button
      className={
        inlineReadingMode
          ? "inline-flex h-touch min-w-[72px] shrink-0 items-center justify-center gap-2 rounded-control bg-accent-rose px-2 text-sm font-semibold text-surface-canvas hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-rose/65 disabled:cursor-not-allowed disabled:opacity-50"
          : "inline-flex h-touch min-w-[72px] items-center justify-center gap-2 rounded-control bg-accent-rose px-2 text-sm font-semibold text-surface-canvas hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-rose/65 disabled:cursor-not-allowed disabled:opacity-50 sm:h-control sm:min-w-[92px] sm:px-3 [@media(max-height:32rem)]:!h-touch [@media(max-height:32rem)]:!min-w-[72px] [@media(max-height:32rem)]:!px-2 [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
      }
      type="button"
      aria-label="Stop response"
      aria-describedby={stopDisabled ? "composer-stop-disabled-hint" : undefined}
      data-testid={inlineReadingMode ? "composer-reading-stop" : undefined}
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
  compactProfileControls,
  controls,
  contextLine = null,
  disabled = false,
  disabledHint = null,
  disabledHintLive = true,
  editing = false,
  editPending = false,
  onChange,
  onCancelEdit,
  onRequestExpanded,
  onRemoveAttachment,
  onRejectedFiles,
  onSend,
  onStop,
  onUploadFiles,
  operationError = null,
  readingCollapsed = false,
  sendDisabled = false,
  stopDisabled = false,
  streaming = false,
  uploading = false,
  usageStats = null,
  value
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pointerMessageActivationRef = useRef(false);
  const usagePopoverRef = useRef<HTMLDivElement>(null);
  const usageTriggerRef = useRef<HTMLButtonElement>(null);
  const dragDepthRef = useRef(0);
  const [usageOpen, setUsageOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const attachmentAccept = [
    attachmentPolicy.documents ? documentAttachmentAccept : null,
    attachmentPolicy.pdfs ? "application/pdf" : null,
    attachmentPolicy.images ? imageAttachmentAccept : null
  ].filter(Boolean).join(",");
  const modelAcceptsAttachments = Boolean(attachmentAccept);
  const hasSendableContent = value.trim().length > 0 || (!editing && attachments.length > 0);
  const canSend =
    hasSendableContent &&
    !disabled &&
    !sendDisabled &&
    !streaming &&
    !uploading &&
    !editPending;
  const canUploadDroppedFiles = Boolean(onUploadFiles) && modelAcceptsAttachments && !disabled && !streaming && !uploading;
  const attachmentDisabled = !onUploadFiles || !modelAcceptsAttachments || disabled || streaming || uploading;
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
  const compactContextLine = contextLine?.replace(/^(?:Approx\. input|Current context length):\s*/u, "") ?? null;
  const hasCompactProfileControls = Boolean(compactProfileControls);

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

    // Start the upload generation before recording rejections from this same
    // selection, so its reset clears only feedback from an older selection.
    if (supported.length > 0) {
      onUploadFiles?.(supported);
    }
    if (rejected.length > 0) {
      onRejectedFiles?.(rejected);
    }
  }

  return (
    <form
      className="shrink-0 bg-surface-thread pb-[max(.5rem,env(safe-area-inset-bottom))] pl-[max(.5rem,env(safe-area-inset-left))] pr-[max(.5rem,env(safe-area-inset-right))] pt-2 sm:pb-[max(.75rem,env(safe-area-inset-bottom))] sm:pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!pb-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!pt-1"
      data-reading-collapsed={readingCollapsed ? "true" : undefined}
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
            "relative rounded-composer border bg-surface-raised",
            dragActive
              ? "border-accent-cyan/50 ring-2 ring-accent-cyan/20"
              : "border-separator-subtle"
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
                "pointer-events-none absolute inset-1 z-40 grid place-items-center rounded-panel border bg-surface-overlay/95 text-sm font-semibold",
                canUploadDroppedFiles
                  ? "border-accent-cyan/45 text-accent-cyan"
                  : "border-accent-amber/45 text-accent-amber"
              ].join(" ")}
              role="status"
            >
              {canUploadDroppedFiles ? "Drop files to attach" : "Attachments unavailable right now"}
            </div>
          ) : null}

          {editing ? (
            <div
              className="flex items-center justify-between gap-3 rounded-t-composer border-b border-accent-cyan/20 bg-accent-cyan/[0.06] px-3 py-2 text-xs text-accent-cyan [@media(max-height:32rem)]:!py-0"
              data-testid="edit-branch-strip"
            >
              <span
                className="inline-flex min-w-0 items-center gap-2"
                id={editPending ? "composer-edit-pending-status" : undefined}
                role={editPending ? "status" : undefined}
              >
                <GitBranch className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {editPending
                    ? "Saving edited branch…"
                    : "Editing a message — Send creates a new branch"}
                </span>
              </span>
              <button
                className="h-touch shrink-0 rounded-control px-2 text-xs font-medium hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
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
              className="border-b border-accent-amber/20 bg-accent-amber/[0.07] px-3 py-2 text-xs text-accent-amber"
              data-testid="composer-disabled-hint"
              id="composer-disabled-hint"
              role={disabledHintLive ? "status" : undefined}
            >
              {disabledHint}
            </div>
          ) : null}

          {operationError ? (
            <div
              className="border-b border-accent-rose/20 bg-accent-rose/[0.07] px-3 py-2 text-xs text-accent-rose"
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
              className="flex max-h-28 flex-wrap gap-2 overflow-y-auto border-b border-separator-subtle px-3 py-2 [@media(max-height:32rem)]:!max-h-none [@media(max-height:32rem)]:!flex-nowrap [@media(max-height:32rem)]:!overflow-x-auto [@media(max-height:32rem)]:!overflow-y-hidden [@media(max-height:32rem)]:!py-1"
              data-testid="attachment-chip-list"
              aria-label="Attachments"
            >
              {attachments.map((attachment) => (
                <li
                  className="flex min-h-control-sm max-w-[min(15rem,100%)] items-center gap-1.5 rounded-control bg-surface-selected pl-2 text-xs text-content-secondary [@media(max-height:32rem)]:shrink-0"
                  data-testid="attachment-chip"
                  key={attachment.id}
                  title={attachment.fileName}
                >
                  {attachment.kind === "image" ? (
                    <ImageIcon className="size-3.5 text-content-muted" aria-hidden="true" />
                  ) : (
                    <FileText className="size-3.5 text-content-muted" aria-hidden="true" />
                  )}
                  <span className="truncate">{attachment.fileName}</span>
                  <button
                    className="grid size-11 shrink-0 place-items-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
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

          <div
            className={[
              "mx-2 mt-2 rounded-control border border-separator-subtle bg-surface-thread px-3 py-1.5 focus-within:border-accent-cyan/60 focus-within:ring-2 focus-within:ring-accent-cyan/20 sm:pb-2 sm:pt-2 [@media(max-height:32rem)]:!mt-1 [@media(max-height:32rem)]:!py-0.5",
              readingCollapsed
                ? "mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
                : ""
            ].join(" ")}
            data-testid="composer-message-field"
          >
            <label
              className="block text-xs font-medium text-content-secondary max-sm:sr-only [@media(max-height:32rem)]:sr-only"
              htmlFor="composer"
            >
              Message
            </label>
            <textarea
              className="mt-0 block max-h-[200px] min-h-11 w-full min-w-0 resize-none bg-transparent text-[15px] leading-7 text-content-primary outline-none placeholder:text-content-muted disabled:cursor-not-allowed disabled:text-content-disabled sm:mt-1 sm:min-h-[72px] [@media(max-height:32rem)]:!mt-0 [@media(max-height:32rem)]:!max-h-16 [@media(max-height:32rem)]:!min-h-11 [@media(max-height:32rem)]:overflow-y-auto"
              aria-describedby={disabledHint ? "composer-disabled-hint" : undefined}
              disabled={disabled}
              id="composer"
              placeholder="Ask AIQSA…"
              ref={textareaRef}
              rows={1}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onBlur={() => {
                pointerMessageActivationRef.current = false;
              }}
              onClick={() => {
                pointerMessageActivationRef.current = false;
                onRequestExpanded?.();
              }}
              onFocus={() => {
                if (!pointerMessageActivationRef.current) {
                  onRequestExpanded?.();
                }
              }}
              onPointerCancel={() => {
                pointerMessageActivationRef.current = false;
              }}
              onPointerDown={() => {
                pointerMessageActivationRef.current = true;
              }}
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
            {readingCollapsed && streaming && onStop ? (
              <StopAction
                inlineReadingMode
                stopDisabled={stopDisabled}
                onStop={onStop}
              />
            ) : null}
          </div>

          {controls ? (
            <div
              className={[
                "grid transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none",
                readingCollapsed
                  ? "grid-rows-[0fr] opacity-0"
                  : "grid-rows-[1fr] opacity-100"
              ].join(" ")}
              aria-hidden={readingCollapsed || undefined}
              data-testid="composer-controls-disclosure"
              inert={readingCollapsed || undefined}
            >
              <div className={readingCollapsed ? "min-h-0 overflow-hidden" : "min-h-0 overflow-visible"}>
                <div className="border-t border-separator-subtle p-1.5 sm:p-3 [@media(max-height:32rem)]:!p-1.5" data-testid="composer-controls-slot">
                  {controls}
                </div>
              </div>
            </div>
          ) : null}

          <div
            className={[
              "grid transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none",
              readingCollapsed
                ? "grid-rows-[0fr] opacity-0"
                : "grid-rows-[1fr] opacity-100"
            ].join(" ")}
            aria-hidden={readingCollapsed || undefined}
            data-testid="composer-actions-disclosure"
            inert={readingCollapsed || undefined}
          >
            <div className={readingCollapsed ? "min-h-0 overflow-hidden" : "min-h-0 overflow-visible"}>
              <div
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 border-t border-separator-subtle px-2 py-1.5 sm:gap-2 sm:px-3 sm:py-2.5 [@media(max-height:32rem)]:!gap-1 [@media(max-height:32rem)]:!py-1"
                data-testid="composer-action-footer"
              >
            {contextLine ? (
              <div
                className="fade-in-soft relative flex min-w-0 flex-1 items-center gap-1 text-[11px] text-content-muted sm:gap-2 [@media(max-height:32rem)]:!gap-1"
                data-testid="composer-usage-line"
                ref={usagePopoverRef}
              >
                {hasCompactProfileControls ? (
                  <div className="min-w-0 overflow-x-auto sm:hidden [@media(max-height:32rem)]:!block">
                    {compactProfileControls}
                  </div>
                ) : null}
                <span
                  className={[
                    "min-w-0 truncate font-mono",
                    hasCompactProfileControls
                      ? "max-sm:hidden [@media(max-height:32rem)]:!hidden"
                      : ""
                  ].join(" ")}
                  data-testid="current-context-length"
                  aria-label={contextLine}
                  title={contextLine}
                >
                  {compactContextLine}
                </span>
                <button
                  ref={usageTriggerRef}
                  className="inline-flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-control text-xs text-content-muted hover:bg-surface-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:h-control-sm sm:w-auto sm:px-2 max-lg:h-touch [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
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
                    className="pop-enter absolute bottom-10 left-0 z-30 mb-2 max-h-[min(20rem,calc(100dvh-4rem))] w-[min(320px,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-panel border border-separator-subtle bg-surface-overlay p-3 shadow-overlay [@media(max-height:32rem)]:fixed [@media(max-height:32rem)]:!bottom-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!left-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!right-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!mb-0 [@media(max-height:32rem)]:!max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!w-auto"
                    data-testid="token-stats-popover"
                    role="dialog"
                    aria-label="Context and usage statistics"
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-content-primary">Context and usage</p>
                      <button
                        className="grid size-11 shrink-0 place-items-center rounded-control text-content-muted outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 lg:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
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
                        <dt className="text-content-secondary">Current context</dt>
                        <dd className="mt-1 break-words font-mono leading-5 text-content-primary [overflow-wrap:anywhere]">
                          {contextLine}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-content-secondary">Total messages</dt>
                        <dd className="font-mono text-content-primary">{stats.activeBranchMessageCount}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-content-secondary">Provider-reported tokens</dt>
                        <dd className="font-mono text-content-primary">{formatTokenCount(stats.totalTokens)}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-content-secondary">Total tokens cached</dt>
                        <dd className="font-mono text-content-primary">{formatTokenCount(stats.cachedInputTokens)}</dd>
                      </div>
                    </dl>
                  </div>
                ) : null}
              </div>
            ) : (
              <span aria-hidden="true" />
            )}
            <div className="flex shrink-0 items-center justify-end gap-1 sm:gap-2 [@media(max-height:32rem)]:!gap-1">
              {uploading ? (
                <span className="text-xs text-content-muted" id="composer-upload-status" role="status">
                  Uploading…
                </span>
              ) : null}
              {attachmentDescriptionId === "composer-attachment-disabled-hint" ? (
                <span className="sr-only" id="composer-attachment-disabled-hint">
                  {attachmentDisabledReason}
                </span>
              ) : null}
              {streaming && stopDisabled ? (
                <span className="text-xs text-content-muted" role="status">
                  Starting run…
                </span>
              ) : null}
              <label
                className={[
                  "grid size-11 place-items-center rounded-control text-content-secondary focus-within:ring-2 focus-within:ring-accent-cyan/55 sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11",
                  uploading
                    ? "cursor-wait bg-surface-active text-content-primary"
                    : attachmentDisabled
                      ? "cursor-not-allowed text-content-disabled opacity-60"
                      : "cursor-pointer hover:bg-surface-hover"
                ].join(" ")}
                aria-disabled={attachmentDisabled || undefined}
                data-disabled={attachmentDisabled || undefined}
                title={attachmentDisabledReason ?? "Attach file"}
              >
                <span className="sr-only">Attach file</span>
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Paperclip className="size-4" aria-hidden="true" />
                )}
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
                    "inline-flex h-touch min-w-[72px] items-center justify-center gap-2 rounded-control px-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:h-control sm:min-w-[92px] sm:px-3 [@media(max-height:32rem)]:!h-touch [@media(max-height:32rem)]:!min-w-[72px] [@media(max-height:32rem)]:!px-2 [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
                    canSend
                      ? "bg-accent-cyan text-surface-canvas hover:brightness-110"
                      : "bg-surface-active text-content-disabled"
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
        </div>
      </div>
    </form>
  );
}
