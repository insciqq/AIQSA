import type {
  PdfProcessingWire,
  UploadedAttachmentWire
} from "@/lib/contracts/uploads";

export type ComposerPdfProcessing = PdfProcessingWire;
export type ComposerAttachment = UploadedAttachmentWire;

export type ComposerAttachmentWarning = Readonly<{
  attachmentId: string;
  blocking: boolean;
  label: "No text" | "Text limited";
  message: string;
}>;
