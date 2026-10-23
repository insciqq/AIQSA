/**
 * The native engine's harness tools, for its registry. They are not part of
 * the old core's tool catalog, which is frozen.
 *
 * - `apply_patch` (local, needs the Workspace VM): `executeApplyPatch` over
 *   `workspaceApplyPatchFiles`, which takes the registry's dispatcher of
 *   Workspace tool calls.
 * - `update_plan` (no effects): `executeUpdatePlan`; the validated plan is in
 *   the result's `rawPreview.plan` for the progress display.
 * - `read_secret` (no effects, no VM): `executeReadSecret` over
 *   `createRunSecretSource` (`lib/server/workspace/secrets/runSecrets.ts`),
 *   whose `list` also gives the secret names for the system prompt.
 */
import { applyPatchTool } from "./applyPatch";
import type { HarnessToolDescriptor } from "./harnessTool";
import { readSecretTool } from "./readSecret";
import { updatePlanTool } from "./updatePlan";

export {
  APPLY_PATCH_LIMITS,
  APPLY_PATCH_TOOL_NAME,
  ApplyPatchFileError,
  applyPatchTool,
  executeApplyPatch,
  resolveApplyPatchPath,
  workspaceApplyPatchFiles,
  type ApplyPatchFiles,
  type WorkspaceTextFile,
  type WorkspaceToolCaller
} from "./applyPatch";
export { APPLY_PATCH_LARK_GRAMMAR } from "./applyPatchFormat";
export { harnessToolError, type HarnessToolDescriptor, type HarnessToolEffects, type HarnessToolExecute } from "./harnessTool";
export { READ_SECRET_LIMITS, READ_SECRET_TOOL_NAME, executeReadSecret, readSecretTool } from "./readSecret";
export {
  PLAN_STEP_STATUSES,
  UPDATE_PLAN_LIMITS,
  UPDATE_PLAN_TOOL_NAME,
  executeUpdatePlan,
  parsePlanUpdate,
  updatePlanTool,
  type PlanStepStatus,
  type PlanUpdate
} from "./updatePlan";
export { createRunSecretSource, type RunSecretEntry, type RunSecretScope, type RunSecretSource } from "../workspace/secrets/runSecrets";

export const HARNESS_TOOLS: readonly HarnessToolDescriptor[] = Object.freeze([applyPatchTool, updatePlanTool, readSecretTool]);
