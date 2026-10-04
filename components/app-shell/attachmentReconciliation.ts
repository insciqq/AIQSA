import {
  partitionAttachmentsForModel,
  unsupportedAttachmentMessage
} from "@/components/app-shell/attachmentCapabilities";
import { withoutAttachmentLimitFeedbackMessage } from "@/components/app-shell/attachmentLimitUsage";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import {
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "@/components/app-shell/composerSessionStore";
import { loadImageModels, useImageModelStore } from "@/components/app-shell/imageModelStore";
import type { CatalogModel } from "@/components/app-shell/types";
import { imageEditingChoiceAvailable } from "@/lib/contracts/imageModels";

/**
 * Explains files the composer refused with its own (personal or Project)
 * model. Only a personal chat's editing route follows the user's image model,
 * so only there the refusal points to Chat defaults, and only once a published
 * model that can edit exists. Unknown image models load once; the message
 * gains the suggestion while it is still the one shown.
 */
export function reportRejectedAttachments(
  fileNames: readonly string[],
  model: CatalogModel | undefined,
  options: Readonly<{ personalChat: boolean; workspaceAvailable: boolean }>
): Promise<void> {
  const sessions = useComposerSessionStore.getState();
  const sessionKey = sessions.activeSessionKey;
  const message = (imageModelChoice: boolean) =>
    unsupportedAttachmentMessage(fileNames, model, false, options.workspaceAvailable, imageModelChoice);
  const choiceMatters = options.personalChat && Boolean(model?.capabilities.imageRoutes);
  const settings = useImageModelStore.getState().settings;
  const shown = message(choiceMatters && settings !== null && imageEditingChoiceAvailable(settings));
  sessions.updateSession(sessionKey, { operationError: shown });
  if (!choiceMatters || settings !== null || shown === message(true)) return Promise.resolve();
  return loadImageModels().then(() => {
    const loaded = useImageModelStore.getState().settings;
    const current = useComposerSessionStore.getState();
    if (!loaded || !imageEditingChoiceAvailable(loaded) ||
      selectComposerSession(current, sessionKey).operationError !== shown) return;
    current.updateSession(sessionKey, { operationError: message(true) });
  });
}

export function reconcileCurrentComposerAttachments(
  sourceSessionKey: ComposerSessionKey,
  renderedModel: CatalogModel,
  options: Readonly<{
    clearResolvedLimitFeedback?: boolean;
    workspaceEnabled?: boolean;
  }> = {}
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
    renderedModel,
    options.workspaceEnabled
  );
  if (unsupported.length === 0) {
    const retainedError = withoutAttachmentLimitFeedbackMessage(
      sourceSession.operationError
    );
    return options.clearResolvedLimitFeedback &&
      retainedError !== sourceSession.operationError
      ? sessionStore.updateSession(sourceSessionKey, {
          operationError: retainedError
        })
      : false;
  }

  const capabilityMessage = unsupportedAttachmentMessage(
    unsupported.map((attachment) => attachment.fileName),
    renderedModel,
    true
  );
  const retainedError = withoutAttachmentLimitFeedbackMessage(
    sourceSession.operationError
  );
  return sessionStore.updateSession(sourceSessionKey, {
    attachments: supported,
    operationError: retainedError
      ? `${retainedError} ${capabilityMessage}`
      : capabilityMessage
  });
}
