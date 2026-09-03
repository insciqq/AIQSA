const EN = {
  "settings.heading": "Memory",
  "settings.intro": "Choose what Memory can use in future conversations. You stay in control of every saved detail.",
  "settings.memoryLabel": "Use memories in answers",
  "settings.memoryDescription": "The master switch. Off means answers stop reading what is saved; the list stays.",
  "settings.searchPastChatsLabel": "Search past chats",
  "settings.searchPastChatsDescription": "Let an answer look for details in your earlier chats.",
  "settings.learnAutomaticallyLabel": "Learn automatically",
  "settings.learnAutomaticallySimpleDescription": "Save new details from ordinary chats without asking each time.",
  "settings.synthesisLabel": "Notice repeated details",
  "settings.synthesisDescription": "Occasionally combine several similar facts into one. Combined facts are marked in the list.",
  "settings.decayLabel": "Learn from what you use",
  "settings.decayDescription": "Facts you rely on often are read first when an answer needs them.",
  "settings.statusOn": "On",
  "settings.statusPreparing": "Preparing",
  "settings.statusPaused": "Paused",
  "settings.statusUnavailable": "Temporarily unavailable",
  "settings.statusNeedsSetup": "Needs administrator setup",
  "settings.statusOnDescription": "Turn it off with the first switch below. Nothing is deleted when you do.",
  "settings.temporaryHeading": "Temporary chats",
  "settings.temporaryDescription": "Temporary Chat does not use or create memory.",
  "settings.manageLabel": "Manage memory",
  "settings.manageDescription": "Review, add, edit, or forget the details Memory has saved for you.",
  "settings.resetLabel": "Reset personal memory",
  "settings.resetTitle": "Forget everything?",
  "settings.resetConfirmation": "Memory turns off immediately. Saved details and searchable past-chat context are removed in the background; your conversations are not deleted.",
  "settings.resetConfirm": "Forget everything",
  "settings.resetCancel": "Keep my memories",
  "settings.resetStarted": "Memory is off. Reset cleanup is continuing in the background.",
  "settings.resetComplete": "Personal Memory was reset.",
  "settings.resetError": "Memory could not be reset. Nothing was reported as deleted.",
  "settings.loading": "Loading Memory settings…",
  "settings.loadError": "Memory settings could not be loaded.",
  "settings.retry": "Retry",
  "settings.saved": "Memory setting saved.",
  "settings.stale": "Memory settings changed elsewhere. The current server state has been reloaded.",
  "settings.saveError": "Memory setting could not be saved.",
  "manager.title": "Manage Memories",
  "manager.new": "Add memory",
  "manager.categoryFilter": "Category",
  "manager.sourceFilter": "Source",
  "manager.allCategories": "All categories",
  "manager.allSources": "Saved and learned",
  "manager.savedByYou": "Saved by you",
  "manager.learnedFromChat": "Learned from chat",
  "manager.sourceUnavailable": "Source unavailable",
  "manager.updatedLabel": "Updated",
  "manager.categoryAboutYou": "About you",
  "manager.categoryPreferences": "Preferences",
  "manager.categoryWork": "Work",
  "manager.categoryGoals": "Goals",
  "manager.categoryConstraints": "Constraints and routines",
  "manager.categoryOther": "Other",
  "manager.formAutomaticClassification": "Memory will categorize this statement and check that it is safe to save.",
  "manager.searchLabel": "Search saved memories",
  "manager.searchPlaceholder": "Search memories…",
  "manager.searchAction": "Search",
  "manager.clearSearch": "Clear search",
  "manager.loading": "Loading saved memories…",
  "manager.loadError": "Saved memories could not be loaded.",
  "manager.retry": "Retry",
  "manager.empty": "Nothing saved yet",
  "manager.emptyDescription": "Say \u201cremember that\u2026\u201d in a chat, or write the first fact yourself. Everything saved shows up here with where it came from.",
  "manager.noResults": "No saved memories match this search.",
  "manager.loadMore": "Load more",
  "manager.loadingMore": "Loading more…",
  "manager.edit": "Edit",
  "manager.forget": "Forget",
  "manager.forgetting": "Forgetting…",
  "manager.never": "Never",
  "manager.notSet": "Not set",
  "manager.createTitle": "Save a new memory",
  "manager.editTitle": "Edit saved memory",
  "manager.statement": "Exact statement",
  "manager.statementHelp": "Write it as a fact about you. Never save passwords or access tokens.",
  "manager.saveNew": "Save memory",
  "manager.saveChanges": "Save",
  "manager.cancel": "Cancel",
  "manager.saving": "Saving…",
  "manager.saved": "Saved memory committed.",
  "manager.draftStale": "This memory changed elsewhere. Your draft was kept; review it and save again.",
  "manager.validationStatement": "Enter a non-blank statement of 2,000 characters or fewer.",
  "manager.mutationError": "The Memory action did not complete. Nothing was reported as saved.",
  "manager.unavailable": "Memory is temporarily unavailable. Nothing was changed; try again later.",
  "manager.secretRejected": "This statement looks like a secret and was not saved.",
  "manager.forgotten": "Forgotten.",
  "manager.savedUseOff": "Saved; memory use is off. The fact is retained but will not be included in answers until Memory is on.",
  "manager.discardTitle": "Discard Memory draft?",
  "manager.discardBody": "The statement in this unsaved draft will be lost.",
  "manager.keepEditing": "Keep editing",
  "manager.discardDraft": "Discard draft",
  "action.saved": "Memory saved.",
  "action.updated": "Memory updated.",
  "action.forgotten": "Forgotten.",
  "action.ambiguous": "Choose the exact saved memory before AIQSA changes anything.",
  "action.statusDone": "Done",
  "action.statusReady": "Ready",
  "action.statusNeedsChoice": "Needs a choice",
  "action.statusConfirmation": "Confirmation needed",
  "action.statusNotApplied": "Not applied",
  "action.statusThisChat": "This chat only",
  "action.listComplete": "Saved memories",
  "action.searchComplete": "Memory search results",
  "action.ambiguousGuidance": "Several memories match. Choose the exact memory before making a change.",
  "action.ambiguousNoAction": "No change was made yet. Choose one exact item below to continue.",
  "action.matchesHeading": "Possible memory matches",
  "action.matchIndex": "Match {index}",
  "action.memoryIndex": "Memory {index}",
  "action.updateCandidate": "Update this memory",
  "action.forgetCandidate": "Forget this memory",
  "action.mutationError": "Memory action could not be completed. Nothing was changed.",
  "action.correctionLength": "Enter a correction of {count} characters or fewer.",
  "action.correctMemory": "Correct this memory",
  "action.saveCorrection": "Save correction",
  "action.reviewReset": "Review reset",
  "action.resetConfirmation": "Forgetting everything needs your confirmation in Memory settings.",
  "action.rejected": "Memory action was not applied.",
  "action.thisChatOnly": "Saved for this chat only.",
  "action.manage": "Manage Memories",
  "answer.limited": "Memory was used with limitations for this response.",
  "answer.unavailable": "Memory was unavailable for this response.",
  "source.learnedMemory": "Learned memory",
  "source.pastChat": "Past chat",
  "source.savedMemory": "Saved memory",
  "source.savedByYou": "Saved by you",
  "source.learnedFromChat": "Learned from chat",
  "source.dateUnavailable": "Date unavailable",
  "source.corrected": "Memory source corrected.",
  "source.forgotten": "Memory source forgotten.",
  "source.notRelevantDone": "Memory source marked not relevant.",
  "source.ready": "Source is ready to open.",
  "source.actionError": "Memory source action could not be completed. Nothing was changed.",
  "source.unavailableLabel": "Source unavailable",
  "source.unavailableBody": "This Memory source is unavailable.",
  "source.correctStatement": "Correct this statement",
  "source.correct": "Correct",
  "source.notRelevant": "Not relevant",
  "source.open": "Open source",
  "source.heading": "Memory · {count}",
  "source.usedOne": "Used 1 memory",
  "source.usedMany": "Used {count} memories",
  "source.actions": "Memory actions",
  "library.description": "What AIQSA remembers about you between chats. Everything here is yours: edit it, forget it, or turn Memory off in Settings.",
  "library.statusNeedsSetup": "Memory needs administrator setup",
  "library.statusOn": "Memory is on",
  "library.statusPaused": "Memory is paused",
  "library.statusPreparing": "Memory is preparing",
  "library.statusUnavailable": "Memory is temporarily unavailable",
  "library.statusLoadError": "Memory status could not be loaded",
  "library.needsSetupDescription": "Saved memories remain available for you to manage.",
  "library.onDescription": "Saved memories may help personalize future answers.",
  "library.pausedDescription": "Saved memories remain available, but answers do not use them.",
  "library.preparingDescription": "Memory is getting ready. Saved memories remain available to manage.",
  "library.unavailableDescription": "Memory is unavailable for now. Saved memories remain available to manage.",
  "library.loadingDescription": "Loading the current Memory status…",
  "library.loadErrorDescription": "Try loading Memory status again.",
  "library.controlsHeading": "Memory controls",
  "library.savedHeading": "Saved memories",
  "library.savedDescription": "Review, add, correct, or forget the personal details AIQSA has saved.",
  "library.longFactDescription": "A saved fact can hold up to 2 000 characters. Long ones are folded to three lines in the list and open in full when edited.",
  "library.pausedManagementDescription": "You can still read, edit and forget every fact while Memory is off. Turning it back on uses the same list \u2014 nothing is re-learned from scratch.",
  "library.temporaryDescription": "Temporary chats never read or write Memory, and project chats use no personal memory at all.",
  "common.on": "On",
  "common.off": "Off"
} as const;

export type MemoryUiCopyKey = keyof typeof EN;

export const MEMORY_UI_COPY: Readonly<Record<MemoryUiCopyKey, string>> =
  Object.freeze(EN);

export const MEMORY_UI_COPY_KEYS = Object.freeze(
  Object.keys(EN) as MemoryUiCopyKey[]
);

export function memoryUiCopy(key: MemoryUiCopyKey): string {
  const value = MEMORY_UI_COPY[key];
  if (!value) throw new Error(`memory_ui_copy_missing:${key}`);
  return value;
}

export const MEMORY_UI_LOCALE = "en-US";

export function formatMemoryUiCopy(
  key: MemoryUiCopyKey,
  values: Readonly<Record<string, number | string>>
): string {
  let value = memoryUiCopy(key);
  for (const [name, replacement] of Object.entries(values)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

export function memoryCategoryLabel(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "about":
    case "about_you":
    case "identity":
      return memoryUiCopy("manager.categoryAboutYou");
    case "preference":
    case "preferences":
      return memoryUiCopy("manager.categoryPreferences");
    case "work":
      return memoryUiCopy("manager.categoryWork");
    case "goal":
    case "goals":
      return memoryUiCopy("manager.categoryGoals");
    case "constraint":
    case "constraints":
    case "constraints_and_routines":
    case "habit":
    case "routine":
    case "routines":
      return memoryUiCopy("manager.categoryConstraints");
    default:
      return memoryUiCopy("manager.categoryOther");
  }
}
