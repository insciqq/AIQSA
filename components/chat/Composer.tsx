"use client";

import { formatTokenCount } from "@/components/app-shell/shellFormatting";
import {
  composerContextGauge,
  type ComposerContextStats
} from "@/components/app-shell/composerContextStats";
import {
  calculateAttachmentLimitUsage,
  type AttachmentLimitUsage
} from "@/components/app-shell/attachmentLimitUsage";
import { isImeCompositionEvent } from "@/components/keyboard";
import type { PdfProcessingWire, UploadedAttachmentWire } from "@/lib/contracts/uploads";
import {
  FileText,
  GitBranch,
  Image as ImageIcon,
  Info,
  Loader2,
  Paperclip,
  RotateCcw,
  Send,
  Square,
  TriangleAlert,
  X
} from "lucide-react";
import {
  type DragEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

export type ComposerPdfProcessing = PdfProcessingWire;
export type ComposerAttachment = UploadedAttachmentWire;

export type ComposerAttachmentWarning = {
  attachmentId: string;
  blocking: boolean;
  label: "No text" | "Text limited";
  message: string;
};

const documentAttachmentAccept =
  ".txt,.md,.markdown,.csv,.json,.html,.htm,.doc,.docx,.xlsx,.pptx,.rtf,.odt,text/plain,text/markdown,text/csv,application/json,text/html,application/msword,application/rtf,text/rtf,application/vnd.oasis.opendocument.text,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation";
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
const defaultAttachmentWarnings: readonly ComposerAttachmentWarning[] = [];

export type ComposerUsageStats = {
  activeBranchMessageCount: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
};

export type ComposerHintTone = "busy" | "caution";

export type ComposerProps = {
  attachmentLimitUsage?: AttachmentLimitUsage | null;
  attachmentPolicy?: ComposerAttachmentPolicy;
  attachmentWarnings?: readonly ComposerAttachmentWarning[];
  attachments: ComposerAttachment[];
  controls?: ReactNode;
  contextStats?: ComposerContextStats | null;
  disabled?: boolean;
  disabledHint?: string | null;
  disabledHintLive?: boolean;
  disabledHintTone?: ComposerHintTone;
  editing?: boolean;
  editPending?: boolean;
  onChange(value: string): void;
  onAttachmentCountLimitExceeded?(input: {
    attemptedCount: number;
    currentCount: number;
    maxCount: number;
  }): void;
  onCancelEdit?(): void;
  onRequestExpanded?(): void;
  onRemoveAttachment(id: string): void;
  onRetryAttachment?(id: string): void;
  onRejectedFiles?(files: readonly File[]): void;
  onSend(): void;
  onStop?(): void;
  onUploadFiles?(files: FileList | readonly File[]): void;
  operationError?: string | null;
  operationErrorLive?: boolean;
  promptFirst?: boolean;
  readingCollapsed?: boolean;
  sendDisabled?: boolean;
  stopDisabled?: boolean;
  streaming?: boolean;
  tools?: ReactNode;
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
      className={[
        "inline-flex h-touch min-w-[72px] items-center justify-center gap-2 rounded-control bg-critical text-sm font-semibold text-proof-contrast outline-none hover:bg-critical/85 focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50 [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
        inlineReadingMode ? "shrink-0 px-2" : "px-3 sm:h-control"
      ].join(" ")}
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
  attachmentLimitUsage = null,
  attachmentPolicy = defaultAttachmentPolicy,
  attachmentWarnings = defaultAttachmentWarnings,
  attachments,
  controls,
  contextStats = null,
  disabled = false,
  disabledHint = null,
  disabledHintLive = true,
  disabledHintTone = "caution",
  editing = false,
  editPending = false,
  onChange,
  onAttachmentCountLimitExceeded,
  onCancelEdit,
  onRequestExpanded,
  onRemoveAttachment,
  onRetryAttachment,
  onRejectedFiles,
  onSend,
  onStop,
  onUploadFiles,
  operationError = null,
  operationErrorLive = true,
  promptFirst = false,
  readingCollapsed = false,
  sendDisabled = false,
  stopDisabled = false,
  streaming = false,
  tools,
  uploading = false,
  usageStats = null,
  value
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pointerMessageActivationRef = useRef(false);
  const usagePopoverRef = useRef<HTMLDivElement>(null);
  const usageTriggerRef = useRef<HTMLButtonElement>(null);
  const dragDepthRef = useRef(0);
  const previousAttachmentWarningsRef = useRef(new Map<string, string>());
  const previousAttachmentLimitFeedbackRef = useRef<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [attachmentWarningAnnouncement, setAttachmentWarningAnnouncement] = useState("");
  const resolvedAttachmentWarnings = useMemo(() => {
    const warningsById = new Map(
      attachmentWarnings.map((warning) => [warning.attachmentId, warning])
    );

    return attachments.flatMap((attachment, index) => {
      const warning = warningsById.get(attachment.id);
      return warning
        ? [{
            attachment,
            detailId: `composer-attachment-warning-${index}`,
            warning
          }]
        : [];
    });
  }, [attachmentWarnings, attachments]);
  const attachmentWarningsById = new Map(
    resolvedAttachmentWarnings.map((entry) => [entry.attachment.id, entry])
  );
  const resolvedAttachmentLimitUsage = attachmentLimitUsage ??
    calculateAttachmentLimitUsage(attachments, undefined, undefined);
  const attachmentLimitBlocksSend =
    !editing && resolvedAttachmentLimitUsage.blocking;
  const attachmentLifecycleBlocksSend = !editing && attachments.some(
    (attachment) => attachment.status !== undefined && attachment.status !== "ready"
  );
  const blockingAttachmentWarningIds = editing
    ? []
    : resolvedAttachmentWarnings
        .filter((entry) => entry.warning.blocking)
        .map((entry) => entry.detailId);
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
    !editPending &&
    !attachmentLimitBlocksSend &&
    !attachmentLifecycleBlocksSend;
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
  const sendDescriptionId = [
    disabledHint
      ? "composer-disabled-hint"
      : editPending
        ? "composer-edit-pending-status"
        : uploading
          ? "composer-upload-status"
          : null,
    attachmentLimitBlocksSend ? "composer-attachment-limit-feedback" : null,
    ...blockingAttachmentWarningIds
  ]
    .filter(Boolean)
    .join(" ") || undefined;
  const stats = usageStats ?? {
    activeBranchMessageCount: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0
  };
  const gauge = contextStats ? composerContextGauge(contextStats) : null;
  const gaugeCircumference = 2 * Math.PI * 9;
  const gaugeProgress = gauge?.fraction === null || gauge?.fraction === undefined
    ? 0
    : Math.min(1, gauge.fraction);
  const gaugeToneClass = gauge?.tone === "critical"
    ? "text-critical"
    : gauge?.tone === "warning"
      ? "text-caution"
      : gauge?.tone === "neutral"
        ? "text-ink-disabled"
        : "text-proof";
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    const nextWarnings = new Map(
      resolvedAttachmentWarnings.map(({ attachment, warning }) => [
        attachment.id,
        `${attachment.fileName}: ${warning.message}`
      ])
    );
    const changedWarnings = [...nextWarnings].flatMap(([attachmentId, message]) =>
      previousAttachmentWarningsRef.current.get(attachmentId) === message
        ? []
        : [message]
    );
    const warningsChanged =
      nextWarnings.size !== previousAttachmentWarningsRef.current.size ||
      [...nextWarnings].some(
        ([attachmentId, message]) =>
          previousAttachmentWarningsRef.current.get(attachmentId) !== message
      );
    const nextLimitFeedback = resolvedAttachmentLimitUsage.feedback;
    const limitChanged =
      nextLimitFeedback !== previousAttachmentLimitFeedbackRef.current;
    const announcement = [
      ...changedWarnings,
      ...(limitChanged && nextLimitFeedback ? [nextLimitFeedback] : [])
    ].join(" ");

    if (announcement) {
      setAttachmentWarningAnnouncement(announcement);
    } else if (warningsChanged || limitChanged) {
      setAttachmentWarningAnnouncement("");
    }
    previousAttachmentWarningsRef.current = nextWarnings;
    previousAttachmentLimitFeedbackRef.current = nextLimitFeedback;
  }, [resolvedAttachmentWarnings, resolvedAttachmentLimitUsage.feedback]);

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
        [
          "application/json",
          "application/msword",
          "application/rtf",
          "application/vnd.oasis.opendocument.text",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "text/csv",
          "text/html",
          "text/markdown",
          "text/plain",
          "text/rtf"
        ].includes(file.type) ||
        /\.(?:csv|docx?|html?|json|md|markdown|odt|pptx|rtf|txt|xlsx)$/.test(name);
      const accepted = isImage
        ? attachmentPolicy.images
        : isPdf
          ? attachmentPolicy.pdfs
          : isDocument && attachmentPolicy.documents;

      (accepted ? supported : rejected).push(file);
    }

    const maxCount = resolvedAttachmentLimitUsage.limits?.maxCount;
    const attemptedCount = resolvedAttachmentLimitUsage.count + supported.length;
    const countLimitExceeded =
      supported.length > 0 &&
      typeof maxCount === "number" &&
      attemptedCount > maxCount;

    if (countLimitExceeded && maxCount !== undefined) {
      if (rejected.length > 0) {
        onRejectedFiles?.(rejected);
      }
      onAttachmentCountLimitExceeded?.({
        attemptedCount,
        currentCount: resolvedAttachmentLimitUsage.count,
        maxCount
      });
      return;
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
      className="w-full min-w-0 shrink-0 bg-answer-paper pb-[max(.5rem,env(safe-area-inset-bottom))] pl-[max(.5rem,env(safe-area-inset-left))] pr-[max(.5rem,env(safe-area-inset-right))] pt-2 sm:pb-[max(.75rem,env(safe-area-inset-bottom))] sm:pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))] [@media(max-height:42rem)]:!pb-[max(.25rem,env(safe-area-inset-bottom))] [@media(max-height:42rem)]:!pt-1"
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
                className="h-touch shrink-0 rounded-control px-2 text-xs font-medium hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-ink-disabled sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
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
              className={[
                "flex items-center gap-2 border-b px-3 py-2 text-xs",
                disabledHintTone === "busy"
                  ? "border-trace-subtle bg-control-surface/60 text-ink-secondary"
                  : "border-caution/20 bg-caution/[0.07] text-caution"
              ].join(" ")}
              data-tone={disabledHintTone}
              data-testid="composer-disabled-hint"
              id="composer-disabled-hint"
              role={disabledHintLive ? "status" : undefined}
            >
              {disabledHintTone === "busy" ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-proof" aria-hidden="true" />
              ) : null}
              {disabledHint}
            </div>
          ) : null}

          {operationError ? (
            <div
              className="border-b border-critical/20 bg-critical/[0.07] px-3 py-2 text-xs text-critical"
              data-testid="composer-operation-error"
              role={operationErrorLive ? "alert" : undefined}
            >
              {operationError}
            </div>
          ) : null}

          {streaming && stopDisabled ? (
            <span className="sr-only" id="composer-stop-disabled-hint">
              Starting run…
            </span>
          ) : null}

          {attachments.length > 0 || resolvedAttachmentWarnings.length > 0 || attachmentWarningAnnouncement ? (
            <p
              className="sr-only"
              data-testid="attachment-warning-announcement"
              role="status"
              aria-atomic="true"
              aria-live="polite"
            >
              {attachmentWarningAnnouncement}
            </p>
          ) : null}

          {attachments.length > 0 ? (
            <div className="border-b border-trace-subtle">
              <div
                className={[
                  "flex min-w-0 items-start gap-2 px-3 py-1.5 text-xs",
                  resolvedAttachmentLimitUsage.tone === "critical"
                    ? "bg-critical/[0.07] text-critical"
                    : resolvedAttachmentLimitUsage.tone === "caution"
                      ? "bg-caution/[0.07] text-caution"
                      : "text-ink-muted"
                ].join(" ")}
                data-testid="attachment-usage-summary"
                data-tone={resolvedAttachmentLimitUsage.tone}
              >
                {resolvedAttachmentLimitUsage.tone !== "neutral" ? (
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                ) : null}
                <div className="min-w-0 leading-5">
                  <span className="font-medium">{resolvedAttachmentLimitUsage.summary}</span>
                  {resolvedAttachmentLimitUsage.feedback ? (
                    <span
                      className="ml-2"
                      data-blocking={resolvedAttachmentLimitUsage.blocking ? "true" : undefined}
                      id="composer-attachment-limit-feedback"
                    >
                      {resolvedAttachmentLimitUsage.feedback}
                    </span>
                  ) : null}
                </div>
              </div>
              <ul
                className="flex max-h-28 flex-wrap gap-2 overflow-y-auto px-3 py-2 [@media(max-height:42rem)]:!max-h-12 [@media(max-height:42rem)]:!flex-nowrap [@media(max-height:42rem)]:!py-1"
                data-testid="attachment-chip-list"
                aria-label="Attachments"
              >
              {attachments.map((attachment) => {
                const warningEntry = attachmentWarningsById.get(attachment.id);
                const lifecycleStatus = attachment.status ?? "ready";
                const lifecycleMessage = lifecycleStatus === "processing"
                  ? "Processing…"
                  : lifecycleStatus === "failed"
                    ? ({
                        animated_gif_not_supported: "Animated GIFs are not supported.",
                        attachment_checksum_mismatch: "The stored file failed its integrity check.",
                        attachment_object_read_failed: "The stored file could not be read.",
                        attachment_object_size_mismatch: "The stored file failed its size check.",
                        attachment_processing_failed: "File processing failed.",
                        parser_invalid_output: "The document parser returned invalid output.",
                        parser_output_too_large: "The parsed document is too large.",
                        parser_rejected: "The document parser rejected this file.",
                        parser_timeout: "Document processing timed out.",
                        parser_unavailable: "The required document parser is unavailable.",
                        pdf_extraction_failed: "PDF text extraction failed.",
                        pdf_extraction_timeout: "PDF text extraction timed out.",
                        pdf_invalid: "This PDF is damaged or invalid.",
                        pdf_page_limit_exceeded: "This PDF exceeds the page limit.",
                        pdf_password_required: "Password-protected PDFs are not supported."
                      } as Record<string, string>)[attachment.processingErrorCode ?? ""] ??
                      "This file could not be processed."
                    : "Ready";
                const attachmentSummary = (
                  <>
                    {lifecycleStatus === "processing" ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-proof" aria-hidden="true" />
                    ) : attachment.kind === "image" ? (
                      <ImageIcon className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                    ) : (
                      <FileText className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{attachment.fileName}</span>
                      <span
                        className={[
                          "block truncate text-xs leading-4",
                          lifecycleStatus === "failed"
                            ? "text-critical"
                            : lifecycleStatus === "processing"
                              ? "text-proof"
                              : "text-ink-muted"
                        ].join(" ")}
                        role={lifecycleStatus === "processing" ? "status" : undefined}
                      >
                        {lifecycleMessage}
                      </span>
                    </span>
                    {warningEntry ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-caution">
                        <TriangleAlert className="size-3.5" aria-hidden="true" />
                        <span>{warningEntry.warning.label}</span>
                      </span>
                    ) : null}
                  </>
                );

                return (
                  <li
                    className={[
                      "grid min-h-control-sm max-w-[min(20rem,100%)] grid-cols-[minmax(0,1fr)_auto] items-start rounded-control text-xs text-ink-secondary [@media(max-height:42rem)]:!min-h-8",
                      warningEntry
                        ? "bg-caution/[0.07] ring-1 ring-inset ring-caution/20"
                        : lifecycleStatus === "failed"
                          ? "bg-critical/[0.07] ring-1 ring-inset ring-critical/20"
                          : lifecycleStatus === "processing"
                            ? "bg-proof/[0.06] ring-1 ring-inset ring-proof/20"
                            : "bg-control-selected"
                    ].join(" ")}
                    data-attachment-status={lifecycleStatus === "ready"
                      ? warningEntry?.warning.label === "No text"
                        ? "no_text"
                        : warningEntry
                          ? "partial"
                          : "ready"
                      : lifecycleStatus}
                    data-testid="attachment-chip"
                    key={attachment.id}
                    title={attachment.fileName}
                  >
                    {warningEntry ? (
                      <details className="group min-w-0">
                        <summary
                          className="flex min-h-control-sm cursor-pointer list-none items-center gap-1.5 rounded-l-control py-1 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [@media(max-height:42rem)]:!min-h-8 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch [&::-webkit-details-marker]:hidden"
                          aria-label={`Review PDF warning for ${attachment.fileName}: ${warningEntry.warning.label}`}
                        >
                          {attachmentSummary}
                        </summary>
                        <p
                          className="border-t border-caution/20 px-2 py-1.5 leading-5 text-caution"
                          data-blocking={warningEntry.warning.blocking ? "true" : undefined}
                          id={warningEntry.detailId}
                        >
                          {warningEntry.warning.message}
                        </p>
                      </details>
                    ) : (
                      <div className="flex min-h-control-sm min-w-0 items-center gap-1.5 py-1 pl-2 [@media(max-height:42rem)]:!min-h-8">
                        {attachmentSummary}
                      </div>
                    )}
                    <div className="flex shrink-0 items-center">
                      {lifecycleStatus === "failed" && onRetryAttachment ? (
                        <button
                          className="inline-flex h-11 items-center gap-1 rounded-control px-2 text-xs font-medium text-critical hover:bg-critical/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:h-8 [@media(hover:none)]:!h-11 [@media(pointer:coarse)]:!h-11"
                          type="button"
                          aria-label={`Retry ${attachment.fileName}`}
                          onClick={() => onRetryAttachment(attachment.id)}
                        >
                          <RotateCcw className="size-3" aria-hidden="true" />
                          Retry
                        </button>
                      ) : null}
                      <button
                        className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
                        type="button"
                        aria-label={`Remove ${attachment.fileName}`}
                        title={`Remove ${attachment.fileName}`}
                        onClick={() => onRemoveAttachment(attachment.id)}
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
              </ul>
            </div>
          ) : null}

          <div
            className={[
              "px-4 pb-2 pt-3 [@media(max-height:42rem)]:!px-3 [@media(max-height:42rem)]:!pb-1 [@media(max-height:42rem)]:!pt-1",
              readingCollapsed
                ? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 !px-3 !py-0.5"
                : ""
            ].join(" ")}
            data-testid="composer-message-field"
          >
            <label className="sr-only" htmlFor="composer">
              Message
            </label>
            <textarea
              className={[
                "block max-h-[200px] min-h-14 w-full min-w-0 resize-none bg-transparent text-[15px] leading-7 text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed disabled:text-ink-disabled sm:min-h-[72px] [@media(max-height:42rem)]:!max-h-24 [@media(max-height:42rem)]:!min-h-11 [@media(max-height:42rem)]:!leading-6 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch",
                readingCollapsed ? "!max-h-11 !min-h-11 !leading-6 sm:!min-h-11" : ""
              ].join(" ")}
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

          <div
            className={[
              "grid transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none",
              readingCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
            ].join(" ")}
            aria-hidden={readingCollapsed || undefined}
            data-testid="composer-actions-disclosure"
            inert={readingCollapsed || undefined}
          >
            <div className={readingCollapsed ? "min-h-0 overflow-hidden" : "min-h-0 overflow-visible"}>
              <div
                className="flex min-w-0 flex-wrap items-center gap-2 border-t border-trace-subtle px-2 py-2 sm:px-3 [@media(max-height:42rem)]:!gap-1 [@media(max-height:42rem)]:!py-1"
                data-testid="composer-action-footer"
              >
            {controls ? (
              <div
                className="flex w-full min-w-0 items-center"
                data-composer-controls-container="true"
                data-testid="composer-controls-slot"
              >
                {controls}
              </div>
            ) : null}

            <div
              className="flex min-w-0 flex-1 basis-full items-center gap-1"
              data-testid="composer-primary-actions"
            >
              {tools}
              <span className="min-w-0 flex-1" aria-hidden="true" />
              {contextStats && gauge && !promptFirst ? (
                <div
                  className="relative flex min-w-0 items-center text-xs text-ink-muted"
                  data-testid="composer-usage-line"
                  ref={usagePopoverRef}
                >
                  <button
                    ref={usageTriggerRef}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
                    type="button"
                    aria-expanded={usageOpen}
                    aria-haspopup="dialog"
                    aria-label={`${gauge.accessibleLabel}. Open context details`}
                    data-context-tone={gauge.tone}
                    data-testid="token-stats-button"
                    title={gauge.accessibleLabel}
                    onClick={() => setUsageOpen((open) => !open)}
                  >
                    <span className="relative grid size-6 place-items-center" aria-hidden="true">
                      <svg className="absolute inset-0 size-6 -rotate-90" viewBox="0 0 24 24">
                        <circle
                          className="text-trace-strong/75"
                          cx="12"
                          cy="12"
                          fill="none"
                          r="9"
                          stroke="currentColor"
                          strokeWidth="3"
                        />
                        {gauge.fraction !== null ? (
                          <circle
                            className={gaugeToneClass}
                            cx="12"
                            cy="12"
                            fill="none"
                            r="9"
                            stroke="currentColor"
                            strokeDasharray={gaugeCircumference}
                            strokeDashoffset={gaugeCircumference * (1 - gaugeProgress)}
                            strokeLinecap="round"
                            strokeWidth="3"
                            data-testid="context-gauge-progress"
                          />
                        ) : null}
                      </svg>
                      <Info className="size-3" strokeWidth={2.5} />
                    </span>
                  </button>
                  {usageOpen ? (
                    <div
                      className="pop-enter absolute bottom-10 right-0 z-30 mb-2 max-h-[min(24rem,calc(100dvh-4rem))] w-[min(320px,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-panel border border-trace-subtle bg-overlay-surface p-3 shadow-overlay max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[max(.5rem,env(safe-area-inset-bottom))] max-sm:mb-0 max-sm:max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-sm:w-auto [@media(max-height:32rem)]:!fixed [@media(max-height:32rem)]:!bottom-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!left-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!right-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!mb-0 [@media(max-height:32rem)]:!max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!w-auto"
                      data-testid="token-stats-popover"
                      role="dialog"
                      aria-label="Context and usage statistics"
                    >
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-ink">Context and usage</p>
                        <button
                          className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus lg:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
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
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-ink-secondary">Approximate input</dt>
                          <dd className="font-mono text-ink">~{formatTokenCount(contextStats.approximateInputTokens)}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-ink-secondary">Safe input budget</dt>
                          <dd className="font-mono text-ink">
                            {contextStats.safeInputBudgetTokens === null
                              ? "Unavailable"
                              : formatTokenCount(contextStats.safeInputBudgetTokens)}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-ink-secondary">Total context</dt>
                          <dd className="font-mono text-ink">
                            {contextStats.totalContextTokens === null
                              ? "Unavailable"
                              : formatTokenCount(contextStats.totalContextTokens)}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-ink-secondary">Safe budget used</dt>
                          <dd className={`font-mono ${gaugeToneClass}`}>
                            {gauge.percent === null ? "Unavailable" : `${gauge.percent}%`}
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
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-ink-secondary">Cache-write tokens</dt>
                          <dd className="font-mono text-ink">{formatTokenCount(stats.cacheWriteInputTokens)}</dd>
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
                  "inline-flex h-touch shrink-0 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-ink-secondary focus-within:ring-2 focus-within:ring-focus sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
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
                <span className={promptFirst ? "hidden sm:inline" : undefined}>{uploading ? "Uploading" : "Attach"}</span>
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
                    "inline-flex h-touch min-w-[72px] items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-focus sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
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
      </div>
      </div>
    </form>
  );
}
