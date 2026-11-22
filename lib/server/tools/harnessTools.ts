/**
 * The native engine's harness tools, which the engine's registry builds
 * itself; tests that cover every tool's schema read them from this list.
 *
 * - `apply_patch` (local, needs the Workspace VM): `executeApplyPatch` over
 *   `workspaceApplyPatchFiles`, which takes the registry's dispatcher of
 *   Workspace tool calls; the thread shows one row of its files
 *   (`harnessActivity.ts`).
 * - `update_plan` (no effects): `executeUpdatePlan`; the validated plan is in
 *   the result's `rawPreview.plan`, and the thread shows it as the answer's
 *   plan (`harnessActivity.ts`).
 * - `read_secret` (no effects, no VM): `executeReadSecret` over
 *   `createRunSecretSource` (`lib/server/workspace/secrets/runSecrets.ts`),
 *   whose `list` also gives the secret names for the system prompt
 *   (`lib/server/engine/systemPrompt.ts`).
 */
import { applyPatchTool } from "./applyPatch";
import type { HarnessToolDescriptor } from "./harnessTool";
import { readSecretTool } from "./readSecret";
import { updatePlanTool } from "./updatePlan";

export const HARNESS_TOOLS: readonly HarnessToolDescriptor[] = Object.freeze([applyPatchTool, updatePlanTool, readSecretTool]);
