import type {
  MemoryFactState,
  MemoryModality,
  MemoryReceipt,
  MemoryReceiptItem,
  MemoryReceiptItemType,
  MemoryReceiptLifecycleState,
  MemoryScopeType,
  MemorySensitivityClass,
  MemoryUiLocale
} from "@/lib/contracts/memory";
import { MEMORY_PRESENTATION_LOCALE } from "@/lib/contracts/memoryPresentation";

export const MEMORY_UI_COPY_KEYS = [
  "settings.heading",
  "settings.intro",
  "settings.informationHeading",
  "settings.informationManage",
  "settings.informationTemporary",
  "settings.informationDestinations",
  "settings.informationRisk",
  "settings.loading",
  "settings.loadError",
  "settings.retry",
  "settings.policyHeading",
  "settings.policyDescription",
  "settings.useFactsDescription",
  "settings.referenceHistoryDescription",
  "settings.historyIndexing",
  "settings.learnAutomaticallyDescription",
  "settings.capabilityReady",
  "settings.capabilityUnavailable",
  "settings.capabilitiesHeading",
  "settings.capabilityExplicit",
  "settings.capabilityHistory",
  "settings.capabilityLearning",
  "settings.capabilityRussian",
  "settings.destinationsHeading",
  "settings.destinationsDescription",
  "settings.destinationsAdminManaged",
  "settings.answerDestination",
  "settings.systemDestination",
  "settings.embeddingDestination",
  "settings.rerankerDestination",
  "settings.selectedAtRun",
  "settings.destinationUnavailable",
  "settings.currentFingerprint",
  "settings.acceptedFingerprint",
  "settings.policyVersion",
  "settings.acceptedAt",
  "settings.notAccepted",
  "settings.reviewAction",
  "settings.acceptAction",
  "settings.cancelReview",
  "settings.reviewComplete",
  "settings.saved",
  "settings.stale",
  "settings.saveError",
  "settings.manageDescription",
  "settings.manageUnavailable",
  "manager.title",
  "manager.back",
  "manager.new",
  "manager.searchLabel",
  "manager.searchPlaceholder",
  "manager.searchAction",
  "manager.clearSearch",
  "manager.loading",
  "manager.loadError",
  "manager.retry",
  "manager.empty",
  "manager.noResults",
  "manager.loadMore",
  "manager.loadingMore",
  "manager.selectPrompt",
  "manager.pinned",
  "manager.explicit",
  "manager.automatic",
  "manager.deferred",
  "manager.global",
  "manager.sources",
  "manager.sourceCount",
  "manager.updated",
  "manager.detail",
  "manager.backToList",
  "manager.edit",
  "manager.pin",
  "manager.unpin",
  "manager.forget",
  "manager.authority",
  "manager.scope",
  "manager.state",
  "manager.index",
  "manager.category",
  "manager.modality",
  "manager.sensitivity",
  "manager.created",
  "manager.lastConfirmed",
  "manager.lastUsed",
  "manager.validity",
  "manager.currentVersion",
  "manager.never",
  "manager.notSet",
  "manager.evidenceHeading",
  "manager.evidenceDescription",
  "manager.evidenceLoading",
  "manager.evidenceError",
  "manager.evidenceEmpty",
  "manager.evidenceMore",
  "manager.supports",
  "manager.contradicts",
  "manager.evidenceMessage",
  "manager.evidenceAction",
  "manager.evidenceEpisode",
  "manager.observed",
  "manager.whyRemembered",
  "manager.whyAutomatic",
  "manager.whyExplicit",
  "manager.conflictHeading",
  "manager.conflictDescription",
  "manager.conflictChoose",
  "manager.conflictCorrection",
  "manager.conflictCorrectionHelp",
  "manager.conflictResolve",
  "manager.conflictResolving",
  "manager.keepUnresolved",
  "manager.feedbackHeading",
  "manager.feedbackDescription",
  "manager.feedbackIncorrect",
  "manager.feedbackNotUseful",
  "manager.feedbackComment",
  "manager.feedbackCommentHelp",
  "manager.feedbackRecorded",
  "manager.feedbackRetracted",
  "manager.feedbackUndone",
  "manager.undo",
  "manager.resolved",
  "manager.lifecycleHeading",
  "manager.lifecycleDescription",
  "manager.versionHistory",
  "manager.eventHistory",
  "manager.createTitle",
  "manager.editTitle",
  "manager.statement",
  "manager.statementHelp",
  "manager.categoryHelp",
  "manager.modalityHelp",
  "manager.saveNew",
  "manager.saveChanges",
  "manager.cancel",
  "manager.saving",
  "manager.saved",
  "manager.draftStale",
  "manager.validationStatement",
  "manager.validationCategory",
  "manager.mutationError",
  "manager.secretRejected",
  "manager.forgetTitle",
  "manager.forgetDescription",
  "manager.forgetConfirm",
  "manager.forgetting",
  "manager.forgotten",
  "manager.forgetRestored",
  "manager.deleteHeading",
  "manager.deleteDescription",
  "manager.deleteTitle",
  "manager.deleteExplanation",
  "manager.deleteRetention",
  "manager.deleteConfirmation",
  "manager.deletionDetails",
  "manager.deleteWorking",
  "manager.deleteProgress",
  "manager.deletePending",
  "manager.deleteRunning",
  "manager.deleteRetry",
  "manager.deleteSucceeded",
  "manager.deleteCheckAgain",
  "manager.deleteStatusId",
  "manager.lastAudit",
  "manager.deleteStale",
  "manager.savedUseOff",
  "manager.closeDraftWarning",
  "manager.discardTitle",
  "manager.discardBody",
  "manager.keepEditing",
  "manager.discardDraft",
  "receipt.label",
  "receipt.usedOne",
  "receipt.usedMany",
  "receipt.degraded",
  "receipt.outcome",
  "receipt.exactText",
  "receipt.type",
  "receipt.source",
  "receipt.sourceUnavailable",
  "receipt.scope",
  "receipt.version",
  "receipt.selection",
  "action.saved",
  "action.updated",
  "action.forgotten",
  "action.markedIncorrect",
  "action.edit",
  "action.undo",
  "action.restore",
  "action.saveEdit",
  "action.cancelEdit",
  "action.working",
  "action.restored",
  "action.removed",
  "action.changed",
  "action.changeFailed",
  "action.ambiguous",
  "action.manage",
  "common.on",
  "common.off",
  "common.available",
  "common.unavailable"
] as const;

export type MemoryUiCopyKey = (typeof MEMORY_UI_COPY_KEYS)[number];
type MemoryUiCopyLocale = Readonly<Record<MemoryUiCopyKey, string>>;

const EN = {
  "settings.heading": "Memory",
  "settings.intro": "Choose what AIQSA may remember and inspect the exact saved facts under your account.",
  "settings.informationHeading": "How Memory uses your data",
  "settings.informationManage": "Saved and automatically learned memories remain manageable here. Turning a gate off keeps existing data.",
  "settings.informationTemporary": "Temporary chats do not use Memory. Deleting a standalone memory does not rewrite earlier chats, runs, provider retention, or operator backups.",
  "settings.informationDestinations": "Eligible snippets may be sent to the selected answer provider and may coexist with administrator-connected Search, Knowledge, and tools.",
  "settings.informationRisk": "The administrator connection is the default trust decision. Combining Memory with external tools retains residual prompt-injection and disclosure risk.",
  "settings.loading": "Loading Memory settings…",
  "settings.loadError": "Memory settings could not be loaded.",
  "settings.retry": "Retry",
  "settings.policyHeading": "Remembering policy",
  "settings.policyDescription": "These three choices are independent. Turning one off retains existing data.",
  "settings.useFactsDescription": "Allow eligible saved and learned facts to be included in future answers.",
  "settings.referenceHistoryDescription": "Allow eligible retained chat history to be searched as Memory when this capability is available.",
  "settings.historyIndexing": "Indexing {completed} of {total} chats",
  "settings.learnAutomaticallyDescription": "Allow qualified automatic learning from retained chats when this capability is available.",
  "settings.capabilityReady": "Available now",
  "settings.capabilityUnavailable": "Preference is stored; this capability is not active in the current installation.",
  "settings.capabilitiesHeading": "Current capabilities",
  "settings.capabilityExplicit": "Explicit saved memories",
  "settings.capabilityHistory": "Chat-history recall",
  "settings.capabilityLearning": "Automatic learning",
  "settings.capabilityRussian": "Russian qualification",
  "settings.destinationsHeading": "Memory data destinations",
  "settings.destinationsDescription": "Review the current destinations before any affected external Memory processing continues.",
  "settings.destinationsAdminManaged": "Destination trust and renewal are managed by an administrator. No action is required from you.",
  "settings.answerDestination": "Selected answer model",
  "settings.systemDestination": "System Memory model",
  "settings.embeddingDestination": "Embedding deployment",
  "settings.rerankerDestination": "Remote reranker",
  "settings.selectedAtRun": "Selected and recorded for each accepted run",
  "settings.destinationUnavailable": "Not configured or unavailable",
  "settings.currentFingerprint": "Current destination fingerprint",
  "settings.acceptedFingerprint": "Accepted destination fingerprint",
  "settings.policyVersion": "Policy version",
  "settings.acceptedAt": "Accepted",
  "settings.notAccepted": "Not accepted",
  "settings.reviewAction": "Review destinations",
  "settings.acceptAction": "Accept current destinations",
  "settings.cancelReview": "Close review",
  "settings.reviewComplete": "Current Memory destinations accepted.",
  "settings.saved": "Memory setting saved.",
  "settings.stale": "Memory settings changed elsewhere. The current server state has been reloaded.",
  "settings.saveError": "Memory setting could not be saved.",
  "settings.manageDescription": "Review, add, correct, pin, or forget exact saved facts. This remains separate from automatic learning and chat-history recall.",
  "settings.manageUnavailable": "Explicit Memory management is not active in the current installation.",
  "manager.title": "Manage Memories",
  "manager.back": "Back to Memory settings",
  "manager.new": "New memory",
  "manager.searchLabel": "Search saved memories",
  "manager.searchPlaceholder": "Search exact saved facts",
  "manager.searchAction": "Search",
  "manager.clearSearch": "Clear search",
  "manager.loading": "Loading saved memories…",
  "manager.loadError": "Saved memories could not be loaded.",
  "manager.retry": "Retry",
  "manager.empty": "No saved memories yet.",
  "manager.noResults": "No saved memories match this search.",
  "manager.loadMore": "Load more",
  "manager.loadingMore": "Loading more…",
  "manager.selectPrompt": "Select a saved memory to inspect its exact statement and evidence.",
  "manager.pinned": "Pinned",
  "manager.explicit": "Explicit user save",
  "manager.automatic": "Learned automatically",
  "manager.deferred": "deferred candidates",
  "manager.global": "Your account",
  "manager.sources": "sources",
  "manager.sourceCount": "Source count",
  "manager.updated": "Updated",
  "manager.detail": "Memory detail",
  "manager.backToList": "Back to saved memories",
  "manager.edit": "Edit",
  "manager.pin": "Pin",
  "manager.unpin": "Unpin",
  "manager.forget": "Forget",
  "manager.authority": "Authority",
  "manager.scope": "Scope",
  "manager.state": "State",
  "manager.index": "Search index",
  "manager.category": "Category",
  "manager.modality": "Kind",
  "manager.sensitivity": "Sensitivity",
  "manager.created": "Created",
  "manager.lastConfirmed": "Last confirmed",
  "manager.lastUsed": "Last used",
  "manager.validity": "Validity",
  "manager.currentVersion": "Current version",
  "manager.never": "Never",
  "manager.notSet": "Not set",
  "manager.evidenceHeading": "Evidence history",
  "manager.evidenceDescription": "Bounded source evidence supporting or contradicting versions of this exact fact. Hidden reasoning is never shown.",
  "manager.evidenceLoading": "Loading evidence…",
  "manager.evidenceError": "Evidence could not be loaded.",
  "manager.evidenceEmpty": "No source evidence is available for this memory.",
  "manager.evidenceMore": "Load more evidence",
  "manager.supports": "Supports",
  "manager.contradicts": "Contradicts",
  "manager.evidenceMessage": "Retained chat message",
  "manager.evidenceAction": "Explicit user action",
  "manager.evidenceEpisode": "Qualified chat episode",
  "manager.observed": "Observed",
  "manager.whyRemembered": "Why this was remembered",
  "manager.whyAutomatic": "AIQSA learned this from eligible retained-chat evidence. You can inspect the bounded evidence and correct the result without exposing hidden model reasoning.",
  "manager.whyExplicit": "This version was created by an explicit user save or correction, so it outranks automatically learned evidence.",
  "manager.conflictHeading": "Needs your choice",
  "manager.conflictDescription": "The retained evidence supports different current values. Choose one, enter the correct value, or leave the conflict unresolved.",
  "manager.conflictChoose": "Use this value",
  "manager.conflictCorrection": "Correct value",
  "manager.conflictCorrectionHelp": "Your correction becomes a new explicit version and outranks automatic evidence.",
  "manager.conflictResolve": "Save correction",
  "manager.conflictResolving": "Resolving…",
  "manager.keepUnresolved": "Keep unresolved",
  "manager.feedbackHeading": "Help Memory learn",
  "manager.feedbackDescription": "Feedback is private. It informs later learning but does not silently change this fact.",
  "manager.feedbackIncorrect": "This is incorrect",
  "manager.feedbackNotUseful": "Not useful",
  "manager.feedbackComment": "Private note (optional)",
  "manager.feedbackCommentHelp": "Stored only with your feedback; do not include secrets.",
  "manager.feedbackRecorded": "Private Memory feedback recorded.",
  "manager.feedbackRetracted": "Memory feedback undone.",
  "manager.feedbackUndone": "Undone",
  "manager.undo": "Undo",
  "manager.resolved": "Conflict resolved with an explicit version.",
  "manager.lifecycleHeading": "Version and lifecycle history",
  "manager.lifecycleDescription": "Bounded version and state changes for this fact; prompts and hidden reasoning are not included.",
  "manager.versionHistory": "Versions",
  "manager.eventHistory": "Lifecycle events",
  "manager.createTitle": "Save a new memory",
  "manager.editTitle": "Edit saved memory",
  "manager.statement": "Exact statement",
  "manager.statementHelp": "AIQSA stores this text exactly as entered. Do not save passwords, access tokens, or other secrets.",
  "manager.categoryHelp": "Lowercase letters, numbers, underscores, or hyphens; start with a letter.",
  "manager.modalityHelp": "Choose the closest factual kind. This does not change the exact statement.",
  "manager.saveNew": "Save memory",
  "manager.saveChanges": "Save changes",
  "manager.cancel": "Cancel",
  "manager.saving": "Saving…",
  "manager.saved": "Saved memory committed.",
  "manager.draftStale": "This memory changed elsewhere. Your draft was kept; review the current version and save again.",
  "manager.validationStatement": "Enter a non-blank statement of 2,000 characters or fewer.",
  "manager.validationCategory": "Enter a valid category or leave it blank when creating a memory.",
  "manager.mutationError": "The Memory action did not complete. Nothing was reported as saved.",
  "manager.secretRejected": "This statement looks like a secret and was not saved.",
  "manager.forgetTitle": "Forget this memory?",
  "manager.forgetDescription": "Future Memory use stops immediately and unchanged evidence is suppressed from relearning. Retained chat text and old accepted runs are not rewritten.",
  "manager.forgetConfirm": "Forget this memory",
  "manager.forgetting": "Forgetting…",
  "manager.forgotten": "Forgotten.",
  "manager.forgetRestored": "Memory restored.",
  "manager.deleteHeading": "Delete saved memories",
  "manager.deleteDescription": "Delete every currently saved explicit memory from this account.",
  "manager.deleteTitle": "Delete all saved memories?",
  "manager.deleteExplanation": "All currently saved memories stop being used immediately; their plaintext derivatives are then purged asynchronously.",
  "manager.deleteRetention": "Retained raw chats are not deleted, immutable accepted destination runs are not rewritten, and provider retention or operator backups remain separate.",
  "manager.deleteConfirmation": "Only the currently admitted set is deleted. A memory saved after admission is outside this deletion.",
  "manager.deletionDetails": "What is and is not deleted",
  "manager.deleteWorking": "Starting durable deletion…",
  "manager.deleteProgress": "Durable deletion progress",
  "manager.deletePending": "Future retrieval is fenced. Physical plaintext purge is queued.",
  "manager.deleteRunning": "Future retrieval is fenced. Physical plaintext purge is running.",
  "manager.deleteRetry": "Future retrieval is fenced. Physical deletion is waiting to retry automatically.",
  "manager.deleteSucceeded": "All admitted saved-memory plaintext derivatives passed the durable deletion audit.",
  "manager.deleteCheckAgain": "Check deletion status",
  "manager.deleteStatusId": "Deletion reference",
  "manager.lastAudit": "Last deletion audit",
  "manager.deleteStale": "Memory changed before deletion admission. Review the current list and confirm again.",
  "manager.savedUseOff": "Saved; memory use is off. The fact is retained but will not be included in answers until Use memory facts is on.",
  "manager.closeDraftWarning": "Unsaved Memory draft",
  "manager.discardTitle": "Discard Memory draft?",
  "manager.discardBody": "The exact statement and metadata in this unsaved draft will be lost.",
  "manager.keepEditing": "Keep editing",
  "manager.discardDraft": "Discard draft",
  "receipt.label": "Memory",
  "receipt.usedOne": "1 memory used",
  "receipt.usedMany": "memories used",
  "receipt.degraded": "retrieval degraded safely",
  "receipt.outcome": "Outcome",
  "receipt.exactText": "Exact included text",
  "receipt.type": "Type",
  "receipt.source": "Source",
  "receipt.sourceUnavailable": "The source conversation is no longer available.",
  "receipt.scope": "Scope",
  "receipt.version": "Version",
  "receipt.selection": "Selection",
  "action.saved": "Memory saved.",
  "action.updated": "Memory updated.",
  "action.forgotten": "Forgotten.",
  "action.markedIncorrect": "Incorrect Memory feedback recorded privately.",
  "action.edit": "Edit",
  "action.undo": "Undo",
  "action.restore": "Restore",
  "action.saveEdit": "Save",
  "action.cancelEdit": "Cancel",
  "action.working": "Applying…",
  "action.restored": "Memory restored.",
  "action.removed": "Saved memory removed.",
  "action.changed": "Saved text updated.",
  "action.changeFailed": "Could not change this memory.",
  "action.ambiguous": "Choose the exact saved memory before AIQSA changes anything.",
  "action.manage": "Manage Memories",
  "common.on": "On",
  "common.off": "Off",
  "common.available": "Available",
  "common.unavailable": "Unavailable"
} satisfies MemoryUiCopyLocale;


export const MEMORY_UI_COPY: Readonly<Record<typeof MEMORY_PRESENTATION_LOCALE, MemoryUiCopyLocale>> =
  Object.freeze({ EN: Object.freeze(EN) });

export function memoryUiCopy(locale: MemoryUiLocale, key: MemoryUiCopyKey): string {
  const value = MEMORY_UI_COPY[MEMORY_PRESENTATION_LOCALE][key];
  if (!value) throw new Error(`memory_ui_copy_missing:${locale}:${key}`);
  return value;
}

const FACT_STATE_LABELS: Readonly<Record<typeof MEMORY_PRESENTATION_LOCALE, Readonly<Record<MemoryFactState, string>>>> = {
  EN: {
    ACTIVE: "Active",
    CONFLICTED: "Conflicted",
    EXPIRED: "Expired",
    FORGOTTEN: "Forgotten",
    ORPHANED: "Orphaned",
    RETRACTED: "Retracted"
  }
};

const MODALITY_LABELS: Readonly<Record<typeof MEMORY_PRESENTATION_LOCALE, Readonly<Record<MemoryModality, string>>>> = {
  EN: {
    CONSIDERATION: "Consideration",
    CONSTRAINT: "Constraint",
    EVENT: "Event",
    HABIT: "Habit",
    INTENTION: "Intention",
    PLAN: "Plan",
    PREFERENCE: "Preference",
    STATE: "State",
    WORKFLOW: "Workflow"
  }
};

const SENSITIVITY_LABELS: Readonly<
  Record<typeof MEMORY_PRESENTATION_LOCALE, Readonly<Record<MemorySensitivityClass, string>>>
> = {
  EN: {
    HIGHLY_SENSITIVE: "Highly sensitive",
    NORMAL: "Normal",
    SECRET: "Secret",
    SENSITIVE: "Sensitive"
  }
};

export function memoryFactStateLabel(locale: MemoryUiLocale, value: MemoryFactState): string {
  void locale;
  return FACT_STATE_LABELS[MEMORY_PRESENTATION_LOCALE][value];
}

export function memoryModalityLabel(locale: MemoryUiLocale, value: MemoryModality): string {
  void locale;
  return MODALITY_LABELS[MEMORY_PRESENTATION_LOCALE][value];
}

export function memorySensitivityLabel(
  locale: MemoryUiLocale,
  value: MemorySensitivityClass
): string {
  void locale;
  return SENSITIVITY_LABELS[MEMORY_PRESENTATION_LOCALE][value];
}

const RECEIPT_ITEM_TYPE_LABELS: Readonly<
  Record<typeof MEMORY_PRESENTATION_LOCALE, Readonly<Record<MemoryReceiptItemType, string>>>
> = {
  EN: {
    EPISODE: "Previous-chat episode",
    FACT_VERSION: "Saved fact version",
    PROFILE: "Memory summary",
    RECALL_CHUNK: "Previous-chat excerpt"
  }
};

const RECEIPT_SOURCE_MODE_LABELS: Readonly<
  Record<typeof MEMORY_PRESENTATION_LOCALE, Readonly<Record<MemoryReceiptItem["sourceMode"], string>>>
> = {
  EN: {
    AUTOMATIC: "Automatically learned evidence",
    EXPLICIT: "Explicit user action",
    HISTORY: "Retained chat history",
    PROFILE: "Derived Memory summary"
  }
};

const RECEIPT_SCOPE_LABELS: Readonly<
  Record<typeof MEMORY_PRESENTATION_LOCALE, Readonly<Record<MemoryScopeType, string>>>
> = {
  EN: {
    ASSISTANT: "Assistant",
    CHAT: "Chat",
    FOLDER: "Folder",
    GLOBAL_USER: "Your account"
  }
};

const RECEIPT_LIFECYCLE_LABELS: Readonly<
  Record<typeof MEMORY_PRESENTATION_LOCALE, Readonly<Record<MemoryReceiptLifecycleState, string>>>
> = {
  EN: {
    CURRENT: "Current",
    LATER_FORGOTTEN: "Later forgotten",
    SOURCE_DELETED: "Source deleted"
  }
};

export function memoryReceiptItemTypeLabel(
  locale: MemoryUiLocale,
  value: MemoryReceiptItemType
): string {
  void locale;
  return RECEIPT_ITEM_TYPE_LABELS[MEMORY_PRESENTATION_LOCALE][value];
}

export function memoryReceiptSourceModeLabel(
  locale: MemoryUiLocale,
  value: MemoryReceiptItem["sourceMode"]
): string {
  void locale;
  return RECEIPT_SOURCE_MODE_LABELS[MEMORY_PRESENTATION_LOCALE][value];
}

export function memoryReceiptScopeLabel(
  locale: MemoryUiLocale,
  value: MemoryScopeType
): string {
  void locale;
  return RECEIPT_SCOPE_LABELS[MEMORY_PRESENTATION_LOCALE][value];
}

export function memoryReceiptLifecycleLabel(
  locale: MemoryUiLocale,
  value: MemoryReceiptLifecycleState
): string {
  void locale;
  return RECEIPT_LIFECYCLE_LABELS[MEMORY_PRESENTATION_LOCALE][value];
}

/** Compact English evidence summary without exposing source identities. */
export function memoryReceiptUsageLabel(
  locale: MemoryUiLocale,
  receipt: MemoryReceipt
): string {
  locale = MEMORY_PRESENTATION_LOCALE;
  const reusableCount = receipt.items.filter((item) =>
    item.itemType === "FACT_VERSION" || item.itemType === "PROFILE").length;
  const historyItems = receipt.items.filter((item) =>
    item.itemType === "EPISODE" || item.itemType === "RECALL_CHUNK");
  const knownChats = new Set(historyItems.flatMap((item) =>
    item.sourceChatId ? [item.sourceChatId] : []));
  const historyCount = knownChats.size + historyItems.filter((item) =>
    item.sourceChatId === null).length;

  if (historyCount === 0) {
    return reusableCount === 1
      ? memoryUiCopy(locale, "receipt.usedOne")
      : `${memoryUiCopy(locale, "receipt.usedMany")}: ${reusableCount}`;
  }
  const history = `${historyCount} previous ${historyCount === 1 ? "chat" : "chats"}`;
  if (reusableCount === 0) return `${history} used`;
  const reusable = `${reusableCount} ${reusableCount === 1 ? "memory" : "memories"}`;
  return `${reusable} and ${history} used`;
}
