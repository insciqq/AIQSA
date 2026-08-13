import type { MemoryUiLocale } from "@/lib/contracts/memory";
import { MEMORY_PRESENTATION_LOCALE } from "@/lib/contracts/memoryPresentation";

const COPY = {
  EN: {
    advanced: "Advanced details",
    advancedAttempts: "Cleanup attempts",
    advancedError: "Last error code",
    advancedFenced: "Made unavailable",
    advancedLastAudit: "Last audit",
    advancedReference: "Deletion reference",
    advancedUpdated: "Updated",
    archiveAction: "Archive instead",
    blocked: "Cleanup needs administrator attention. The chat remains unavailable.",
    cancel: "Cancel",
    close: "Close",
    confirmBody: "This chat will disappear immediately and cannot be restored.",
    confirmLabel: "Delete permanently",
    confirmTitle: "Delete this chat permanently?",
    disclosureBackups: "Operator backups may retain an older copy until their normal rotation or reconciliation.",
    disclosureCrossChat: "Answers already accepted in other chats keep their frozen evidence, but the source is shown as deleted and cannot be opened.",
    disclosureProvider: "This does not erase data already sent to an AI provider or external tool; their retention policy still applies.",
    forgetHelp: "This additionally forgets explicit saved memories whose evidence came from this chat. Other saved memories are unchanged.",
    forgetLabel: "Also forget saved memories from this chat",
    noticeAction: "View progress",
    noticeBlocked: "Chat deleted · cleanup needs attention",
    noticePending: "Chat deleted · cleanup is finishing",
    noticeSucceeded: "Chat deletion completed",
    refresh: "Refresh status",
    refreshing: "Refreshing…",
    retryWait: "The chat is unavailable. Cleanup will retry automatically.",
    stale: "The chat changed. Review the refreshed details, then confirm again.",
    statePending: "The chat is unavailable. Cleanup is queued in the background.",
    stateRunning: "The chat is unavailable. Private data cleanup is in progress.",
    stateSucceeded: "The chat and its owned data have been removed.",
    statusBody: "You can keep using AIQSA while cleanup continues.",
    statusTitle: "Permanent deletion",
    unavailable: "Permanent deletion is not available yet.",
    unknownError: "Could not delete this chat. Nothing was deleted; try again."
  }
} as const;

export type PermanentChatDeletionUiCopyKey = keyof typeof COPY.EN;

export function permanentChatDeletionUiCopy(
  _locale: MemoryUiLocale,
  key: PermanentChatDeletionUiCopyKey
): string {
  return COPY[MEMORY_PRESENTATION_LOCALE][key];
}
