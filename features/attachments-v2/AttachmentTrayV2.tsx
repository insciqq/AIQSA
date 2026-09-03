"use client";

import type { AttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import { UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import {
  attachmentCapacityCopyV2,
  type ComposerAttachmentItemV2
} from "./attachmentPresentation";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";

type AttachmentListLayoutV2 = Readonly<{
  maxHeightPx: number | null;
  overflowBelow: boolean;
  scrollable: boolean;
}>;

const initialAttachmentListLayoutV2: AttachmentListLayoutV2 = {
  maxHeightPx: null,
  overflowBelow: false,
  scrollable: false
};

function measuredThreeRowHeight(list: HTMLUListElement): number | null {
  const listTop = list.getBoundingClientRect().top;
  const rows: Array<{ bottom: number; top: number }> = [];

  for (const child of Array.from(list.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const rect = child.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const top = rect.top - listTop + list.scrollTop;
    const bottom = rect.bottom - listTop + list.scrollTop;
    const row = rows.find((candidate) => Math.abs(candidate.top - top) <= 1);
    if (row) row.bottom = Math.max(row.bottom, bottom);
    else rows.push({ bottom, top });
  }

  rows.sort((left, right) => left.top - right.top);
  const lastVisibleRow = rows[Math.min(2, rows.length - 1)];
  return lastVisibleRow ? Math.max(1, Math.ceil(lastVisibleRow.bottom)) : null;
}

function itemStatus(item: ComposerAttachmentItemV2): string {
  if (item.status === "uploading") {
    const progress = typeof item.progress === "number" && Number.isFinite(item.progress)
      ? Math.max(0, Math.min(100, Math.round(item.progress)))
      : null;
    return progress === null ? "Uploading…" : `Uploading… ${progress}%`;
  }
  if (item.status === "processing") return "Processing…";
  if (item.status === "ready") return item.warning?.label ?? "Ready";
  if (item.status === "failed") return "Processing failed";
  if (item.rejection === "unsupported_format") return "Format not supported";
  if (item.rejection === "too_large") return item.detail || "File is too large";
  return item.detail || "File not uploaded";
}

export function AttachmentTrayV2({
  items,
  onRemove,
  onRetry,
  sharedProject = false,
  usage
}: Readonly<{
  items: readonly ComposerAttachmentItemV2[];
  onRemove?(id: string): void;
  onRetry?(id: string): void;
  sharedProject?: boolean;
  usage?: AttachmentLimitUsage | null;
}>) {
  const listRef = useRef<HTMLUListElement>(null);
  const [listLayout, setListLayout] = useState<AttachmentListLayoutV2>(
    initialAttachmentListLayoutV2
  );
  const reconcileListLayout = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const maxHeightPx = measuredThreeRowHeight(list);
    const visibleHeight = list.clientHeight;
    const scrollable = list.scrollHeight > visibleHeight + 1;
    const overflowBelow = scrollable &&
      list.scrollTop + visibleHeight < list.scrollHeight - 1;

    setListLayout((current) => {
      const next = { maxHeightPx, overflowBelow, scrollable };
      return current.maxHeightPx === next.maxHeightPx &&
        current.overflowBelow === next.overflowBelow &&
        current.scrollable === next.scrollable
        ? current
        : next;
    });
  }, []);

  useLayoutEffect(() => {
    reconcileListLayout();
    const list = listRef.current;
    if (!list) return;
    window.addEventListener("resize", reconcileListLayout);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(reconcileListLayout);
    observer?.observe(list);
    for (const child of Array.from(list.children)) observer?.observe(child);
    return () => {
      window.removeEventListener("resize", reconcileListLayout);
      observer?.disconnect();
    };
  }, [items, reconcileListLayout]);

  if (items.length === 0) return null;
  const capacity = usage ? attachmentCapacityCopyV2(usage) : null;
  const listStyle = listLayout.maxHeightPx === null
    ? undefined
    : {
        "--v2-attachment-list-max-height": `${listLayout.maxHeightPx}px`
      } as CSSProperties;

  return (
    <section className="v2-attachment-tray" aria-label="Attachments">
      {capacity ? (
        <div
          className="v2-attachment-capacity"
          data-tone={usage?.tone}
          role={usage?.blocking ? "alert" : usage?.tone === "caution" ? "status" : undefined}
        >
          <strong>{capacity.summary}</strong>
          {capacity.detail ? <span>{capacity.detail}</span> : null}
        </div>
      ) : null}
      <ul
        aria-label="Attached files"
        className="v2-attachment-list"
        data-overflow-below={listLayout.overflowBelow || undefined}
        data-scrollable={listLayout.scrollable || undefined}
        ref={listRef}
        style={listStyle}
        onScroll={reconcileListLayout}
      >
        {items.map((item) => (
          <li
            className="v2-attachment-chip"
            data-attachment-status={item.status}
            data-warning={item.warning ? "true" : undefined}
            key={item.id}
          >
            {item.status === "uploading" || item.status === "processing" ? (
              <span className="v2-attachment-spinner" aria-hidden="true" />
            ) : (
              <UiV2Icon name="attach" />
            )}
            <span className="v2-attachment-copy">
              <strong>{item.fileName}</strong>
              <span>{itemStatus(item)}</span>
              {item.detail && item.status !== "rejected" ? <small>{item.detail}</small> : null}
              {item.warning ? <small>{item.warning.message}</small> : null}
            </span>
            <span className="v2-attachment-actions">
              {item.status === "failed" && item.retryable && onRetry ? (
                <button
                  className="v2-attachment-retry v2-focusable"
                  type="button"
                  onClick={() => onRetry(item.id)}
                >
                  Retry
                </button>
              ) : null}
              {onRemove ? (
                <UiV2IconButton
                  icon="close"
                  label={`Remove ${item.fileName}`}
                  onClick={() => onRemove(item.id)}
                />
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {/* Privacy disclosure stays reachable as a quiet tooltip/AT note instead
          of a permanent line; the capability menu keeps the full sentence. */}
      <p
        aria-label={sharedProject ? "Files are visible to Project members." : "Files are private and visible only to you."}
        className="v2-attachment-privacy"
        role="note"
        title={sharedProject ? "Files are visible to Project members." : "Files are private and visible only to you."}
      >
        <UiV2Icon name="lock" />
      </p>
    </section>
  );
}
