export type ComposerAttachmentPolicy = Readonly<{
  documents: boolean;
  images: boolean;
  pdfs: boolean;
}>;

export const DEFAULT_COMPOSER_ATTACHMENT_POLICY: ComposerAttachmentPolicy = {
  documents: true,
  images: true,
  pdfs: true
};

const documentAttachmentAccept =
  ".txt,.md,.markdown,.csv,.json,.html,.htm,.doc,.docx,.xlsx,.pptx,.rtf,.odt,text/plain,text/markdown,text/csv,application/json,text/html,application/msword,application/rtf,text/rtf,application/vnd.oasis.opendocument.text,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation";
const imageAttachmentAccept = "image/png,image/jpeg,image/webp,image/gif";

function fileKind(file: File): "document" | "image" | "pdf" | "unsupported" {
  const name = file.name.toLocaleLowerCase();
  if (
    ["image/gif", "image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    /\.(?:gif|jpe?g|png|webp)$/u.test(name)
  ) {
    return "image";
  }
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return "pdf";
  }
  if (
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
    /\.(?:csv|docx?|html?|json|md|markdown|odt|pptx|rtf|txt|xlsx)$/u.test(name)
  ) {
    return "document";
  }
  return "unsupported";
}

export function attachmentAcceptForPolicy(policy: ComposerAttachmentPolicy): string {
  return [
    policy.documents ? documentAttachmentAccept : null,
    policy.pdfs ? "application/pdf" : null,
    policy.images ? imageAttachmentAccept : null
  ].filter(Boolean).join(",");
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
        : kind === "document" && policy.documents;
    (allowed ? accepted : rejected).push(file);
  }
  return { accepted, rejected };
}

export function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes("Files");
}
