/**
 * The native engine's compaction, for the agent loop. Before each model
 * request the loop measures the context (`measureContext`) and asks
 * `planCompaction` what to do: start a background `compact`, swap a prepared
 * item in, wait for the running one, compact in the foreground, or nothing.
 * A compaction item is appended to the transcript at a request boundary; on a
 * provider context-length rejection the loop plans with `overflow`, compacts
 * and retries once. When no compaction helps, `fitToolResults` makes the one
 * request fit by handle, or the run fails with `context_too_large`. Every
 * call takes the run's `engineItemRules`. The loop's side is
 * `lib/server/engine/runContext.ts`.
 */
export {
  compact,
  COMPACTION_DEFAULTS,
  type CompactInput,
  type CompactionFailureCode,
  type CompactionMetadata,
  type CompactionMode,
  type CompactionModelCall,
  type CompactionModelRequest,
  type CompactionModelResult,
  type CompactionOutcome,
  type CompactionPath,
  type CompactOptions
} from "./compact";
export { CONTEXT_TOO_LARGE, fitToolResults, type ToolResultFit } from "./fallback";
export { APPROVAL_PENDING_TEXT, engineItemRules, type CompactionItemRules } from "./items";
export { COMPACTION_TRIGGER_ITEM, nativeCompactionFrom, responsesCompactionInput } from "./native";
export {
  COMPACTION_RETENTION,
  COMPACTION_THRESHOLDS,
  compactionCutCurrent,
  compactionRetention,
  findCompactionCut,
  planCompaction,
  usableContextTokens,
  type BackgroundCompactionState,
  type CompactionCut,
  type CompactionPlan,
  type CompactionPlanInput,
  type CompactionRetention,
  type CompactionWindow
} from "./policy";
export {
  buildRetainedContext,
  buildStateBlock,
  defaultCompactionToolKind,
  defaultResultHandle,
  type CompactionResultHandle,
  type CompactionToolClassifier,
  type CompactionToolKind
} from "./retained";
