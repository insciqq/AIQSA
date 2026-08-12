export const MEMORY_COUNTER_CHECKS = [
  "NONE",
  "ACTIVE_LEAF_BRANCH_ITEMS",
  "FACT_CURRENT_POINTER",
  "ITEM_GENERATION_FINGERPRINT",
  "PROFILE_CONTRIBUTORS",
  "SCOPE_TARGET_ITEMS",
  "SETTINGS_FINGERPRINT_ITEMS",
  "SETTINGS_LOCK_ACTIVE_POINTER",
  "SOURCE_HASH_REVISION",
  "SOURCE_MODE_ITEMS",
  "SOURCE_SUPPRESSION_ITEMS",
  "SOURCE_TARGET_ACCESS",
  "VERSION_SCOPE",
  "VERSION_CURRENT_POINTER",
  "JOB_OUTBOX_FENCE",
  "INDEX_CONFIG_BARRIERS"
] as const;

export type MemoryCounterCheck = (typeof MEMORY_COUNTER_CHECKS)[number];

export type MemoryCounterAdvance = boolean | "AS_SOURCE_REQUIRES" | "WHEN_CHAT_SOURCE";

export const MEMORY_COUNTER_MUTATIONS = [
  "NORMAL_APPEND",
  "TERMINAL_SETTLEMENT",
  "INITIAL_LEXICAL_BOOTSTRAP",
  "BRANCH_PATH_CHANGE",
  "EXPLICIT_SAVE",
  "AUTOMATIC_ADD_OR_REINFORCE",
  "EXPLICIT_EDIT_PIN_RESCOPE_OR_RESOLVE",
  "AUTOMATIC_VERSION_TRANSITION",
  "CHUNK_OR_EPISODE_VISIBILITY_CHANGE",
  "ACTIVE_VECTOR_SETTLEMENT",
  "WORKING_SET_RECALCULATION",
  "PROFILE_REPLACEMENT",
  "FORGET_OR_BULK_CLEAR",
  "SOURCE_HARD_DELETE",
  "SOURCE_EXCLUDE",
  "SOURCE_RESUME",
  "CHAT_ARCHIVE_OR_RESTORE",
  "FOLDER_MOVE",
  "ASSISTANT_ACCESS_CHANGE",
  "SCOPE_TARGET_DELETE",
  "MEMORY_VISIBLE_SETTING_CHANGE",
  "MEMORY_UI_LOCALE_CHANGE",
  "SHADOW_OR_PURGE_PROGRESS",
  "INDEX_GENERATION_ACTIVATION"
] as const;

export type MemoryCounterMutation = (typeof MEMORY_COUNTER_MUTATIONS)[number];

export type MemoryCounterEffect = Readonly<{
  branchGeneration: MemoryCounterAdvance;
  check: MemoryCounterCheck;
  memoryGeneration: boolean;
  memoryRevision: boolean;
  sourceRevision: MemoryCounterAdvance;
}>;

export const MEMORY_COUNTER_EFFECTS: Readonly<Record<MemoryCounterMutation, MemoryCounterEffect>> =
  Object.freeze({
    ACTIVE_VECTOR_SETTLEMENT: Object.freeze({
      branchGeneration: false,
      check: "ITEM_GENERATION_FINGERPRINT",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    }),
    ASSISTANT_ACCESS_CHANGE: Object.freeze({
      branchGeneration: false,
      check: "SOURCE_TARGET_ACCESS",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    }),
    AUTOMATIC_ADD_OR_REINFORCE: Object.freeze({
      branchGeneration: false,
      check: "FACT_CURRENT_POINTER",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    }),
    AUTOMATIC_VERSION_TRANSITION: Object.freeze({
      branchGeneration: false,
      check: "VERSION_CURRENT_POINTER",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    }),
    BRANCH_PATH_CHANGE: Object.freeze({
      branchGeneration: true,
      check: "ACTIVE_LEAF_BRANCH_ITEMS",
      memoryGeneration: true,
      memoryRevision: true,
      sourceRevision: true
    }),
    CHAT_ARCHIVE_OR_RESTORE: Object.freeze({
      branchGeneration: false,
      check: "NONE",
      memoryGeneration: false,
      memoryRevision: false,
      sourceRevision: false
    }),
    CHUNK_OR_EPISODE_VISIBILITY_CHANGE: Object.freeze({
      branchGeneration: false,
      check: "SOURCE_HASH_REVISION",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    }),
    EXPLICIT_EDIT_PIN_RESCOPE_OR_RESOLVE: Object.freeze({
      branchGeneration: false,
      check: "VERSION_SCOPE",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    }),
    EXPLICIT_SAVE: Object.freeze({
      branchGeneration: false,
      check: "FACT_CURRENT_POINTER",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    }),
    FOLDER_MOVE: Object.freeze({
      branchGeneration: false,
      check: "SOURCE_TARGET_ACCESS",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: true
    }),
    FORGET_OR_BULK_CLEAR: Object.freeze({
      branchGeneration: false,
      check: "SOURCE_SUPPRESSION_ITEMS",
      memoryGeneration: true,
      memoryRevision: true,
      sourceRevision: false
    }),
    INDEX_GENERATION_ACTIVATION: Object.freeze({
      branchGeneration: false,
      check: "INDEX_CONFIG_BARRIERS",
      memoryGeneration: true,
      memoryRevision: true,
      sourceRevision: false
    }),
    INITIAL_LEXICAL_BOOTSTRAP: Object.freeze({
      branchGeneration: false,
      check: "SETTINGS_LOCK_ACTIVE_POINTER",
      memoryGeneration: false,
      memoryRevision: false,
      sourceRevision: false
    }),
    MEMORY_UI_LOCALE_CHANGE: Object.freeze({
      branchGeneration: false,
      check: "NONE",
      memoryGeneration: false,
      memoryRevision: false,
      sourceRevision: false
    }),
    MEMORY_VISIBLE_SETTING_CHANGE: Object.freeze({
      branchGeneration: false,
      check: "SETTINGS_FINGERPRINT_ITEMS",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    }),
    NORMAL_APPEND: Object.freeze({
      branchGeneration: false,
      check: "SOURCE_HASH_REVISION",
      memoryGeneration: false,
      memoryRevision: false,
      sourceRevision: true
    }),
    PROFILE_REPLACEMENT: Object.freeze({
      branchGeneration: false,
      check: "PROFILE_CONTRIBUTORS",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    }),
    SCOPE_TARGET_DELETE: Object.freeze({
      branchGeneration: false,
      check: "SCOPE_TARGET_ITEMS",
      memoryGeneration: true,
      memoryRevision: true,
      sourceRevision: "WHEN_CHAT_SOURCE"
    }),
    SHADOW_OR_PURGE_PROGRESS: Object.freeze({
      branchGeneration: false,
      check: "JOB_OUTBOX_FENCE",
      memoryGeneration: false,
      memoryRevision: false,
      sourceRevision: false
    }),
    SOURCE_EXCLUDE: Object.freeze({
      branchGeneration: false,
      check: "SOURCE_MODE_ITEMS",
      memoryGeneration: true,
      memoryRevision: true,
      sourceRevision: true
    }),
    SOURCE_HARD_DELETE: Object.freeze({
      branchGeneration: "AS_SOURCE_REQUIRES",
      check: "SOURCE_SUPPRESSION_ITEMS",
      memoryGeneration: true,
      memoryRevision: true,
      sourceRevision: "WHEN_CHAT_SOURCE"
    }),
    SOURCE_RESUME: Object.freeze({
      branchGeneration: false,
      check: "SOURCE_SUPPRESSION_ITEMS",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: true
    }),
    TERMINAL_SETTLEMENT: Object.freeze({
      branchGeneration: false,
      check: "SOURCE_HASH_REVISION",
      memoryGeneration: false,
      memoryRevision: false,
      sourceRevision: true
    }),
    WORKING_SET_RECALCULATION: Object.freeze({
      branchGeneration: false,
      check: "VERSION_CURRENT_POINTER",
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    })
  });

export function memoryCounterEffectFor(mutation: MemoryCounterMutation): MemoryCounterEffect {
  return MEMORY_COUNTER_EFFECTS[mutation];
}

export function memoryCounterEffectMatches(
  mutation: MemoryCounterMutation,
  actual: MemoryCounterEffect
): boolean {
  const expected = MEMORY_COUNTER_EFFECTS[mutation];
  return expected.branchGeneration === actual.branchGeneration &&
    expected.sourceRevision === actual.sourceRevision &&
    expected.memoryGeneration === actual.memoryGeneration &&
    expected.memoryRevision === actual.memoryRevision &&
    expected.check === actual.check;
}
