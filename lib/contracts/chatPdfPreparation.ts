import { PDF_PROCESSING_MAX_PAGES } from "./uploads";
import { CATALOG_ATTACHMENT_LIMIT_CEILINGS } from "./catalog";

/** An advisory, independent of parsing limits and route selection. */
export const CHAT_PDF_LONG_DOCUMENT_PAGE_THRESHOLD = 20;
export const CHAT_PDF_LONG_DOCUMENT_NOTICE = "This may take a while";
export const CHAT_PDF_LOCAL_TEXT_NOTICE =
  "This PDF will use basic text extraction, so reading quality may be limited.";
export const CHAT_PDF_LOCAL_TEXT_MULTIPLE_NOTICE =
  "Some PDFs will use basic text extraction, so reading quality may be limited.";

export type ChatPdfRoute = "direct_pdf" | "system_pdf" | "system_vision" | "selected_model_vision" | "local_text";

/** Admission refuses a chat PDF when the installation policy gives the answer model no reading route. */
export const CHAT_PDF_ROUTE_UNAVAILABLE_CODE = "pdf_processing_configuration_incomplete";
export const CHAT_PDF_ROUTE_UNAVAILABLE_LABEL = "Can't read PDF";
export const CHAT_PDF_ROUTE_UNAVAILABLE_MESSAGE = "No PDF-reading model is configured for this installation.";

/** The reader's definitive answer exhausted its output budget (typically on
 * reasoning); the same binding would fail again, so the run is not retried. */
export const CHAT_PDF_READER_OUTPUT_LIMIT = Object.freeze({
  code: "pdf_reader_output_limit",
  message: "The PDF reader ran out of output tokens on this document. An administrator can lower the PDF reader's reasoning in System roles, then send the message again."
} as const);

/** The live error event names the code; a reloaded answer keeps only its message. */
export function isChatPdfReaderOutputLimitFailure(code: string | null | undefined, message?: string | null): boolean {
  return code === CHAT_PDF_READER_OUTPUT_LIMIT.code || message === CHAT_PDF_READER_OUTPUT_LIMIT.message;
}

/** Server-owned route preview for the selected answer model; content-free. */
export type ChatPdfRouteAvailability =
  | Readonly<{ available: true; route: ChatPdfRoute }>
  | Readonly<{ available: false; reasonCode: typeof CHAT_PDF_ROUTE_UNAVAILABLE_CODE }>;

const chatPdfRoutes: readonly string[] = ["direct_pdf", "system_pdf", "system_vision", "selected_model_vision", "local_text"];

/** Decodes a `/api/uploads/pdf-route` response; anything else stays unknown (null). */
export function decodeChatPdfRouteAvailability(status: number, body: unknown): ChatPdfRouteAvailability | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const item = body as Record<string, unknown>;
  if (status === 200 && item.version === 1 && chatPdfRoutes.includes(String(item.route))) {
    return { available: true, route: item.route as ChatPdfRoute };
  }
  return status === 422 && item.error === CHAT_PDF_ROUTE_UNAVAILABLE_CODE
    ? { available: false, reasonCode: CHAT_PDF_ROUTE_UNAVAILABLE_CODE }
    : null;
}

export type ChatPdfPreparationPhase = "checking" | "preparing" | "assembling" | "ready" | "original_only" | "failed" | "cancelled";

export type ChatPdfPreparationWire = Readonly<{
  readerModelName?: string;
  answerModelName?: string;
  completedPages: number;
  limitedReadingQuality: boolean;
  longDocument: boolean;
  pageCount: number | null;
  phase: ChatPdfPreparationPhase;
  retryable: boolean;
  route: ChatPdfRoute;
}>;

export function isLongChatPdf(pageCount: number | null | undefined): boolean {
  return Number.isSafeInteger(pageCount) && Number(pageCount) > CHAT_PDF_LONG_DOCUMENT_PAGE_THRESHOLD;
}

export function decodeChatPdfPreparation(value: unknown): ChatPdfPreparationWire | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const modelName = (entry: unknown) => entry === undefined || typeof entry === "string" &&
    entry.trim().length > 0 && entry.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(entry);
  if (!modelName(item.readerModelName) || !modelName(item.answerModelName)) return null;
  if (!chatPdfRoutes.includes(String(item.route)) ||
    !["checking", "preparing", "assembling", "ready", "original_only", "failed", "cancelled"].includes(String(item.phase)) ||
    !(item.pageCount === null || Number.isSafeInteger(item.pageCount) &&
      Number(item.pageCount) >= 1 && Number(item.pageCount) <= PDF_PROCESSING_MAX_PAGES) ||
    !Number.isSafeInteger(item.completedPages) || Number(item.completedPages) < 0 ||
    Number(item.completedPages) > Number(item.pageCount ?? 0) ||
    item.limitedReadingQuality !== (item.route === "local_text") ||
    item.longDocument !== isLongChatPdf(item.pageCount as number | null) ||
    typeof item.retryable !== "boolean" ||
    item.phase === "original_only" && item.route === "direct_pdf" ||
    item.retryable && item.phase !== "failed") return null;
  return {
    ...(item.readerModelName ? { readerModelName: item.readerModelName as string } : {}),
    ...(item.answerModelName ? { answerModelName: item.answerModelName as string } : {}),
    completedPages: Number(item.completedPages),
    limitedReadingQuality: item.limitedReadingQuality,
    longDocument: item.longDocument,
    pageCount: item.pageCount as number | null,
    phase: item.phase as ChatPdfPreparationPhase,
    retryable: item.retryable,
    route: item.route as ChatPdfRoute
  };
}

export function decodeChatPdfPreparations(value: unknown): readonly ChatPdfPreparationWire[] | null {
  if (!Array.isArray(value) || !value.length || value.length > CATALOG_ATTACHMENT_LIMIT_CEILINGS.maxCount) return null;
  const result = value.map(decodeChatPdfPreparation);
  return result.every((item): item is ChatPdfPreparationWire => item !== null) ? result : null;
}

/** Describes the admitted route; page counts alone do not prove model dispatch. */
export function chatPdfRouteDescription(item: ChatPdfPreparationWire): string {
  const answer = item.answerModelName ?? "the chat model";
  const reader = item.readerModelName ?? "the assigned reader";
  if (item.phase === "original_only") return `Original PDF available through Workspace for ${answer}.`;
  if (item.route === "direct_pdf") return `Direct PDF input: ${answer}.`;
  if (item.route === "system_pdf") return `PDF reader: ${reader}. Answer model: ${answer}.`;
  if (item.route === "system_vision" || item.route === "selected_model_vision") {
    return `Page-image reader: ${reader}. Answer model: ${answer}.`;
  }
  return `Basic text extraction for ${answer}.`;
}
