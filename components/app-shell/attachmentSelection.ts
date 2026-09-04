import { uploadAcceptFor, uploadFormatFor } from "../../lib/domain/uploadFormats";

export type ComposerAttachmentPolicy = Readonly<{
  documents: boolean;
  /** Accept opaque formats for Workspace staging. */
  files?: boolean;
  images: boolean;
  pdfs: boolean;
}>;

export const DEFAULT_COMPOSER_ATTACHMENT_POLICY: ComposerAttachmentPolicy = {
  documents: true,
  images: true,
  pdfs: true
};

function fileKind(file: File): "document" | "image" | "pdf" | "unsupported" {
  const kind = uploadFormatFor(file.name, file.type, "attachment")?.kind;
  return kind && kind !== "file" ? kind : "unsupported";
}

export function attachmentAcceptForPolicy(policy: ComposerAttachmentPolicy): string {
  // An empty accept attribute is the browser contract for an unrestricted
  // picker. Server validation still owns count, bytes, names and settlement.
  if (policy.files) return "";
  return uploadAcceptFor({
    kinds: [
      ...(policy.documents ? ["document" as const] : []),
      ...(policy.pdfs ? ["pdf" as const] : []),
      ...(policy.images ? ["image" as const] : [])
    ],
    scope: "attachment"
  });
}

export function partitionAttachmentSelection(
  files: FileList | readonly File[],
  policy: ComposerAttachmentPolicy
): { accepted: File[]; rejected: File[] } {
  const accepted: File[] = [];
  const rejected: File[] = [];

  for (const file of Array.from(files)) {
    const kind = fileKind(file);
    const allowed = kind === "image"
      ? policy.images
      : kind === "pdf"
        ? policy.pdfs
        : kind === "document" ? policy.documents : Boolean(policy.files);
    (allowed ? accepted : rejected).push(file);
  }
  return { accepted, rejected };
}

export function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes("Files");
}
