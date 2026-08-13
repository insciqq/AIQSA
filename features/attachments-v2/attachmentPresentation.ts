import {
  attachmentRetryAvailable,
  clientAttachmentFailureMessage
} from "@/components/app-shell/attachmentLifecycle";
import type { AttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import type {
  ComposerAttachment,
  ComposerAttachmentWarning
} from "@/components/app-shell/attachmentContracts";

export type ComposerAttachmentItemV2 = Readonly<{
  byteSize?: number;
  detail?: string | null;
  fileName: string;
  id: string;
  kind?: ComposerAttachment["kind"];
  progress?: number | null;
  rejection?: "too_large" | "unsupported_format" | "upload_failed";
  retryable?: boolean;
  status: "failed" | "processing" | "ready" | "rejected" | "uploading";
  warning?: Readonly<{
    blocking: boolean;
    label: string;
    message: string;
  }> | null;
}>;

const processingFailureMessages: Readonly<Record<string, string>> = {
  animated_gif_not_supported: "Анимированные GIF не поддерживаются.",
  attachment_checksum_mismatch: "Файл не прошёл проверку целостности.",
  attachment_object_read_failed: "Не удалось прочитать сохранённый файл.",
  attachment_object_size_mismatch: "Размер сохранённого файла не совпал.",
  attachment_processing_failed: "Не удалось обработать файл.",
  parser_invalid_output: "Парсер вернул некорректный результат.",
  parser_output_too_large: "Результат обработки слишком велик.",
  parser_rejected: "Парсер отклонил файл.",
  parser_timeout: "Обработка документа заняла слишком много времени.",
  parser_unavailable: "Сервис обработки документов недоступен.",
  pdf_extraction_failed: "Не удалось извлечь текст из PDF.",
  pdf_extraction_timeout: "Извлечение текста из PDF заняло слишком много времени.",
  pdf_invalid: "PDF повреждён или имеет неверный формат.",
  pdf_page_limit_exceeded: "PDF превышает лимит страниц.",
  pdf_password_required: "PDF с паролем не поддерживаются."
};

function failureDetail(attachment: ComposerAttachment): string {
  const clientMessage = clientAttachmentFailureMessage(attachment.processingErrorCode);
  if (clientMessage) return clientMessage;
  return processingFailureMessages[attachment.processingErrorCode ?? ""] ??
    "Не удалось обработать файл.";
}

export function attachmentItemsForV2(
  attachments: readonly ComposerAttachment[],
  warnings: readonly ComposerAttachmentWarning[] = []
): ComposerAttachmentItemV2[] {
  const warningById = new Map(warnings.map((warning) => [warning.attachmentId, warning]));
  return attachments.map((attachment) => {
    const status = attachment.status ?? "ready";
    const warning = warningById.get(attachment.id);
    return {
      ...(attachment.byteSize === undefined ? {} : { byteSize: attachment.byteSize }),
      ...(status === "failed" ? { detail: failureDetail(attachment) } : {}),
      fileName: attachment.fileName,
      id: attachment.id,
      kind: attachment.kind,
      retryable: status === "failed" && attachmentRetryAvailable(attachment),
      status,
      ...(warning ? {
        warning: {
          blocking: warning.blocking,
          label: warning.label === "No text" ? "Нет текста" : "Текст ограничен",
          message: warning.message
        }
      } : {})
    };
  });
}

export function attachmentItemBlocksSend(item: ComposerAttachmentItemV2): boolean {
  return item.status !== "ready" || Boolean(item.warning?.blocking);
}

function firstBlockingItemReason(items: readonly ComposerAttachmentItemV2[]): string | null {
  const item = items.find(attachmentItemBlocksSend);
  if (!item) return null;
  if (item.status === "uploading") {
    return `Дождитесь завершения загрузки файла «${item.fileName}».`;
  }
  if (item.status === "processing") {
    return `Дождитесь обработки файла «${item.fileName}».`;
  }
  if (item.status === "rejected") {
    return `Удалите отклонённый файл «${item.fileName}».`;
  }
  if (item.status === "failed") {
    return `Повторите обработку или удалите файл «${item.fileName}».`;
  }
  return item.warning?.message ?? `Проверьте файл «${item.fileName}».`;
}

export function attachmentSendBlockReasonV2(
  items: readonly ComposerAttachmentItemV2[],
  usage: AttachmentLimitUsage | null | undefined,
  uploading: boolean
): string | null {
  const itemReason = firstBlockingItemReason(items);
  if (itemReason) return itemReason;
  if (uploading) return "Дождитесь завершения загрузки файлов.";
  if (usage?.blocking) {
    return "Превышен лимит вложений. Удалите часть файлов или выберите совместимую модель.";
  }
  return null;
}

export function attachmentCapacityCopyV2(usage: AttachmentLimitUsage): {
  detail: string | null;
  summary: string;
} {
  const fileWord = usage.count % 10 === 1 && usage.count % 100 !== 11
    ? "файл"
    : usage.count % 10 >= 2 && usage.count % 10 <= 4 &&
        (usage.count % 100 < 12 || usage.count % 100 > 14)
      ? "файла"
      : "файлов";
  const sourceSize = usage.totalSourceBytes >= 1024 * 1024
    ? `${Number((usage.totalSourceBytes / (1024 * 1024)).toFixed(1))} MB`
    : usage.totalSourceBytes >= 1024
      ? `${Number((usage.totalSourceBytes / 1024).toFixed(1))} KB`
      : `${usage.totalSourceBytes} байт`;
  const detail = usage.blocking
    ? "Лимит превышен — удалите часть файлов перед отправкой."
    : usage.tone === "caution"
      ? "Использовано не менее 80% одного из лимитов вложений."
      : null;
  return {
    detail,
    summary: `${usage.count} ${fileWord} · ${sourceSize}`
  };
}
