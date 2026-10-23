import { createHash } from "node:crypto";
import {
  WORKSPACE_ACTIVITY_MAX_FILE_CHANGES,
  WORKSPACE_ACTIVITY_MAX_PLAN_ITEMS,
  type ThreadWorkspaceActivityEntry
} from "@/lib/contracts/workspace";
import { displayPath } from "../workspace/activityProjection";
import { clipWorkspaceActivityText, plainWorkspaceActivityText } from "../workspace/activityText";
import { APPLY_PATCH_LIMITS, resolveApplyPatchPath } from "./applyPatch";
import { parsePatch } from "./applyPatchFormat";
import type { PlanUpdate } from "./updatePlan";

/**
 * The thread's progress rows of two harness tools, on the Workspace activity
 * feed every answer already persists and renders (`workspace_activity`):
 * - `update_plan`: one `plan` row per run that every accepted update replaces,
 *   its steps marked done or current, shown as the answer's plan;
 * - `apply_patch`: one `file_change` row per call naming the files it
 *   changes, running while it runs and then succeeded or failed.
 * Step text is the model's own, made one plain bounded line.
 */

const hash = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);

/** The contract's bound for one plan step's text. */
const PLAN_STEP_CHARACTERS = 512;

function planStepText(value: string): string {
  return clipWorkspaceActivityText(plainWorkspaceActivityText(value).replace(/\s+/gu, " ").trim(), PLAN_STEP_CHARACTERS).trim();
}

/** The run's plan row after one accepted update; null when no step has text to show. */
export function planActivityEntry(input: Readonly<{ callId: string; runId: string; update: PlanUpdate }>): ThreadWorkspaceActivityEntry | null {
  const items = input.update.plan.slice(0, WORKSPACE_ACTIVITY_MAX_PLAN_ITEMS).flatMap((step) => {
    const text = planStepText(step.step);
    return text ? [{ ...(step.status === "in_progress" ? { active: true as const } : {}), completed: step.status === "completed", text }] : [];
  });
  if (items.length === 0) return null;
  return {
    // One row per run, so a reload shows the latest plan; every call is its own update.
    id: `plan:${hash(input.runId)}`,
    items,
    kind: "plan",
    phase: items.every((item) => item.completed) ? "succeeded" : "running",
    updateId: `update:${hash(input.runId, input.callId)}`
  };
}

export type PatchActivityChange = Readonly<{ action: "add" | "delete" | "update"; displayPath: string }>;

/**
 * The files a patch names, as the thread shows them (a move is its source
 * deleted and its target added); empty for a patch that does not parse or
 * names a path `apply_patch` refuses, which fails before touching anything.
 */
export function patchActivityChanges(args: Readonly<Record<string, unknown>>): readonly PatchActivityChange[] {
  const input = args.input;
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > APPLY_PATCH_LIMITS.patchBytes) return [];
  const shown = (path: string) => displayPath(resolveApplyPatchPath(path));
  try {
    const changes: PatchActivityChange[] = [];
    for (const hunk of parsePatch(input)) {
      const path = shown(hunk.path);
      if (!path) return [];
      if (hunk.kind === "update" && hunk.movePath) {
        const target = shown(hunk.movePath);
        if (!target) return [];
        if (target !== path) {
          changes.push({ action: "delete", displayPath: path }, { action: "add", displayPath: target });
          continue;
        }
      }
      changes.push({ action: hunk.kind, displayPath: path });
    }
    return changes;
  } catch {
    return [];
  }
}

/** One call's `file_change` row in a phase. */
export function patchActivityEntry(input: Readonly<{
  callId: string;
  changes: readonly PatchActivityChange[];
  durationMs?: number;
  phase: "cancelled" | "failed" | "running" | "succeeded";
  startedAt: Date;
}>): ThreadWorkspaceActivityEntry {
  return {
    changes: input.changes.slice(0, WORKSPACE_ACTIVITY_MAX_FILE_CHANGES),
    count: input.changes.length,
    ...(input.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(input.durationMs)) } : {}),
    id: `patch:${hash(input.callId)}`,
    kind: "file_change",
    phase: input.phase,
    startedAt: input.startedAt.toISOString(),
    updateId: `update:${hash(input.callId, input.phase)}`
  };
}
