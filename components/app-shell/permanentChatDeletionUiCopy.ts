const COPY = {
    advanced: "Advanced details",
    archiveAction: "Archive instead",
    blocked: "Cleanup needs administrator attention. The chat remains unavailable.",
    busy: "This chat is busy. Wait for the current response to finish, then try again.",
    cancel: "Cancel",
    close: "Close",
    confirmBody: "This chat will disappear immediately and cannot be restored.",
    confirmLabel: "Delete permanently",
    confirmTitle: "Delete this chat permanently?",
    disclosureBackups: "Operator backups may retain an older copy until their normal rotation or reconciliation.",
    disclosureCrossChat: "Answers already accepted in other chats stay unchanged, but the source is shown as deleted and cannot be opened.",
    disclosureProvider: "This does not erase data already sent to an AI provider or external tool; their retention policy still applies.",
    forgetHelp: "This additionally forgets explicit saved memories sourced from this chat. Other saved memories are unchanged.",
    forgetLabel: "Also forget saved memories from this chat",
    noticeAction: "View progress",
    noticeBlocked: "Chat deleted · cleanup needs attention",
    noticePending: "Chat deleted · cleanup is finishing",
    noticeSucceeded: "Chat deletion completed",
    refresh: "Refresh status",
    refreshing: "Refreshing…",
    stale: "The chat changed. Review it, then confirm again.",
    stateRunning: "The chat is unavailable. Private data cleanup is in progress.",
    stateSucceeded: "The chat and its owned data have been removed.",
    statusBody: "You can keep using AIQSA while cleanup continues.",
    statusTitle: "Permanent deletion",
    unavailable: "Permanent deletion is not available yet.",
    unknownError: "Could not confirm the latest deletion state. Check the chat and try again."
} as const;

export type PermanentChatDeletionUiCopyKey = keyof typeof COPY;

export function permanentChatDeletionUiCopy(
  key: PermanentChatDeletionUiCopyKey
): string {
  return COPY[key];
}
