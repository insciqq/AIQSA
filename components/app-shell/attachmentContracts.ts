import type { CHAT_PDF_ROUTE_UNAVAILABLE_CODE } from "@/lib/contracts/chatPdfPreparation";
import type {
  PdfProcessingWire,
  UploadedAttachmentWire
} from "@/lib/contracts/uploads";

export type ComposerPdfProcessing = PdfProcessingWire;
export type ComposerAttachment = UploadedAttachmentWire;

export type ComposerAttachmentWarning = Readonly<{
  attachmentId: string;
  blocking: boolean;
  /** Set when admission would refuse the PDF; the view adds the administrator hint. */
  code?: typeof CHAT_PDF_ROUTE_UNAVAILABLE_CODE;
  label: "Can't read PDF" | "No text" | "Text limited";
  message: string;
}>;
