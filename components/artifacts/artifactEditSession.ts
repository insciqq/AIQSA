import { composerSessionKey, useComposerSessionStore, type ComposerArtifactEdit } from "@/components/app-shell/composerSessionStore";
import type { ArtifactRuntimeError } from "@/lib/contracts/artifactRuntime";
import { artifactRuntimeFixDraft } from "./artifactRuntimeSession";

/** Editing intent is attached to this chat's next message, never hidden in its text. */
export function setArtifactEditSession(chatId: string, target: ComposerArtifactEdit, intent: "edit" | "runtime_error" = "edit", error?: ArtifactRuntimeError | null): void {
  useComposerSessionStore.getState().updateSession(composerSessionKey(chatId), (current) => ({
    artifactEdit: target,
    artifactCreate: null,
    ...(intent === "runtime_error" && !current.draft.trim() ? {
      draft: artifactRuntimeFixDraft(error)
    } : {})
  }));
}
