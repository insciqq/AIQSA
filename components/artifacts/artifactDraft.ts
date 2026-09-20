import { composerSessionKey, useComposerSessionStore } from "@/components/app-shell/composerSessionStore";

/** Append to the dispatching chat's current draft, including text typed while
 * the edit binding was being checked. Never overwrite another chat's input. */
export function appendArtifactDraft(chatId: string, instruction: string): void {
  useComposerSessionStore.getState().updateSession(composerSessionKey(chatId), (current) => ({
    draft: current.draft.includes(instruction) ? current.draft
      : current.draft.trim() ? `${current.draft}\n\n${instruction}` : instruction
  }));
}
