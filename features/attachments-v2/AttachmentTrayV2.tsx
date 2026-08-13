"use client";

import type { AttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import { UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import {
  attachmentCapacityCopyV2,
  type ComposerAttachmentItemV2
} from "./attachmentPresentation";

function itemStatus(item: ComposerAttachmentItemV2): string {
  if (item.status === "uploading") {
    const progress = typeof item.progress === "number" && Number.isFinite(item.progress)
      ? Math.max(0, Math.min(100, Math.round(item.progress)))
      : null;
    return progress === null ? "Загрузка…" : `Загрузка… ${progress}%`;
  }
  if (item.status === "processing") return "Обработка…";
  if (item.status === "ready") return item.warning?.label ?? "Готов";
  if (item.status === "failed") return "Ошибка обработки";
  if (item.rejection === "unsupported_format") return "Формат не поддерживается";
  if (item.rejection === "too_large") return item.detail || "Файл слишком большой";
  return item.detail || "Файл не загружен";
}

export function AttachmentTrayV2({
  items,
  onRemove,
  onRetry,
  usage
}: Readonly<{
  items: readonly ComposerAttachmentItemV2[];
  onRemove?(id: string): void;
  onRetry?(id: string): void;
  usage?: AttachmentLimitUsage | null;
}>) {
  if (items.length === 0) return null;
  const capacity = usage ? attachmentCapacityCopyV2(usage) : null;

  return (
    <section className="v2-attachment-tray" aria-label="Вложения">
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
      <ul className="v2-attachment-list">
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
                  Повторить
                </button>
              ) : null}
              {onRemove ? (
                <UiV2IconButton
                  icon="close"
                  label={`Удалить ${item.fileName}`}
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
        aria-label="Файлы приватны и доступны только вам."
        className="v2-attachment-privacy"
        role="note"
        title="Файлы приватны и доступны только вам."
      >
        <UiV2Icon name="lock" />
      </p>
    </section>
  );
}
