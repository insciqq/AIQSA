import type { CatalogModel } from "@/components/app-shell/types";
import type {
  ComposerAttachment,
  ComposerAttachmentPolicy
} from "@/components/chat/Composer";

export function attachmentPolicyForModel(
  model: CatalogModel | undefined
): ComposerAttachmentPolicy {
  const pdfs = Boolean(
    model && model.capabilities.documentInputMode !== "none"
  );

  return {
    documents: Boolean(model),
    images: Boolean(model?.capabilities.imageInput),
    pdfs
  };
}

export function modelSupportsAttachment(
  model: CatalogModel | undefined,
  attachment: ComposerAttachment
): boolean {
  const policy = attachmentPolicyForModel(model);

  if (attachment.kind === "image") {
    return policy.images;
  }

  return attachment.kind === "pdf" ? policy.pdfs : policy.documents;
}

export function partitionAttachmentsForModel(
  attachments: readonly ComposerAttachment[],
  model: CatalogModel | undefined
): {
  supported: ComposerAttachment[];
  unsupported: ComposerAttachment[];
} {
  const supported: ComposerAttachment[] = [];
  const unsupported: ComposerAttachment[] = [];

  for (const attachment of attachments) {
    (modelSupportsAttachment(model, attachment) ? supported : unsupported).push(
      attachment
    );
  }

  return { supported, unsupported };
}

export function unsupportedAttachmentMessage(
  fileNames: readonly string[],
  model: CatalogModel | undefined,
  removed = false
): string {
  const label = model?.displayName ?? "The selected model";
  const names = fileNames.join(", ");
  return removed
    ? `Removed ${fileNames.length === 1 ? "an attachment" : `${fileNames.length} attachments`} unsupported by ${label}: ${names}`
    : `${label} does not support ${fileNames.length === 1 ? "this attachment" : "these attachments"}: ${names}`;
}
