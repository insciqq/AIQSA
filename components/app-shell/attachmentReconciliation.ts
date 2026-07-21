import {
  partitionAttachmentsForModel,
  unsupportedAttachmentMessage
} from "@/components/app-shell/attachmentCapabilities";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import {
  useComposerSessionStore,
  type ComposerSessionKey
} from "@/components/app-shell/composerSessionStore";
import type { CatalogModel } from "@/components/app-shell/types";

export function reconcileCurrentComposerAttachments(
  sourceSessionKey: ComposerSessionKey,
  renderedModel: CatalogModel
): boolean {
  const sessionStore = useComposerSessionStore.getState();
  if (sessionStore.activeSessionKey !== sourceSessionKey) {
    return false;
  }

  const controls = useComposerControlStore.getState();
  if (
    controls.selectedProvider !== renderedModel.provider ||
    controls.selectedModelId !== renderedModel.modelId
  ) {
    return false;
  }

  const sourceSession = sessionStore.sessionsByKey[sourceSessionKey];
  if (!sourceSession || sourceSession.pendingUploadGenerations.length > 0) {
    return false;
  }

  const { supported, unsupported } = partitionAttachmentsForModel(
    sourceSession.attachments,
    renderedModel
  );
  if (unsupported.length === 0) {
    return false;
  }

  const capabilityMessage = unsupportedAttachmentMessage(
    unsupported.map((attachment) => attachment.fileName),
    renderedModel,
    true
  );
  return sessionStore.updateSession(sourceSessionKey, {
    attachments: supported,
    operationError: sourceSession.operationError
      ? `${sourceSession.operationError} ${capabilityMessage}`
      : capabilityMessage
  });
}
