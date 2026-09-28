"use client";

/*
 * Gallery slot of the Assistants tab: the gallery, the detail sheet over it
 * and the delete dialog, adapted from the library view.
 */
import type { AssistantLibraryView } from "@/components/assistants/libraryViewContracts";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import type { AssistantsTabPropsV2 } from "./AssistantsTabV2";
import { AssistantDeleteDialogV2 } from "./gallery/AssistantDeleteDialogV2";
import { AssistantDetailSheetV2 } from "./gallery/AssistantDetailSheetV2";
import { AssistantGalleryV2 } from "./gallery/AssistantGalleryV2";

export function AssistantGalleryEntryV2({ view }: AssistantsTabPropsV2) {
  return (
    <AssistantGalleryV2
      busy={view?.busy ?? false}
      catalogError={view?.catalogError ?? null}
      catalogState={view?.catalogState ?? "loading"}
      gallery={view?.gallery ?? null}
      // The open detail sheet shows the notice instead.
      notice={view?.detail ? null : view?.notice ?? null}
      onDismissNotice={() => view?.onDismissNotice()}
      onFromCurrentChat={() => view?.newAssistant.onFromCurrentChat()}
      onNewAssistant={() => view?.newAssistant.onOpen()}
      onRetry={() => view?.onRetryCatalog()}
    />
  );
}

/**
 * The detail sheet. A starter chip chooses the Assistant for a new chat
 * through the gallery's Start chat, which leaves Studio, and then sends the
 * starter from that chat's composer.
 */
export function AssistantDetailSheetEntryV2({
  composer,
  view
}: Pick<AssistantsTabPropsV2, "composer"> & Readonly<{ view: AssistantLibraryView }>) {
  // The latest composer this tab rendered: Studio unmounts it right after the chat opens.
  const sendStarter = useEventCallback((prompt: string) => composer.assistant.sendStarter(prompt));
  const detail = view.detail;
  if (!detail) return null;
  return (
    <AssistantDetailSheetV2
      busy={view.busy}
      gallery={view.gallery}
      notice={view.notice}
      sheet={detail}
      onDismissNotice={view.onDismissNotice}
      onStartWithStarter={(assistantId, starter) => {
        void view.gallery.onStartChat(assistantId).then((started) => {
          // The new chat renders after the Assistant is chosen; send from it then.
          if (started) window.setTimeout(() => sendStarter(starter), 0);
        });
      }}
    />
  );
}

export function AssistantDeleteDialogEntryV2({ view }: Readonly<{ view: AssistantLibraryView }>) {
  return view.deletion ? <AssistantDeleteDialogV2 view={view.deletion} /> : null;
}
