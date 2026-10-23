/*
 * `update_plan`: the agent's step plan, shown to the user as progress.
 *
 * The tool design follows OpenAI Codex's plan tool
 * (codex-rs/core/src/tools/handlers/plan.rs and plan_spec.rs, commit
 * 334527705c4a2d077efce577925247d87f10d2b1). Copyright 2025 OpenAI, Apache
 * License 2.0 (lib/server/engine/prompts/THIRD_PARTY_NOTICES.txt).
 *
 * Changes by AIQSA: arguments are validated with bounds and at most one
 * `in_progress` step, and errors name the offending field.
 */
import { harnessToolError, type HarnessToolDescriptor } from "./harnessTool";
import { hasInvalidProviderToolArguments, type ModelToolCall, type ToolExecutionResult } from "./types";

export const UPDATE_PLAN_TOOL_NAME = "update_plan";

export const UPDATE_PLAN_LIMITS = Object.freeze({
  explanationCharacters: 2_000,
  stepCharacters: 500,
  steps: 50
});

export const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed"] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

/** A validated plan update; the transcript's tool call is its only record. */
export type PlanUpdate = Readonly<{
  explanation?: string;
  plan: readonly Readonly<{ status: PlanStepStatus; step: string }>[];
}>;

const DESCRIPTION = `Updates the task plan shown to the user as progress.
Provide the whole current plan each time: a list of short steps, each with a status (pending, in_progress or completed), and an optional explanation of what changed.
At most one step can be in_progress at a time; mark steps completed as you finish them, and all of them when the work is done.
Changes nothing else and stores nothing beyond this chat. Result: "Plan updated", or an error naming the invalid field.`;

const INPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    explanation: { description: "Optional explanation for this plan update.", type: "string" },
    plan: {
      description: "The list of steps.",
      items: {
        additionalProperties: false,
        properties: {
          status: { description: "Step status.", enum: [...PLAN_STEP_STATUSES], type: "string" },
          step: { description: "Task step text.", type: "string" }
        },
        required: ["step", "status"],
        type: "object"
      },
      type: "array"
    }
  },
  required: ["plan"],
  type: "object"
};

export const updatePlanTool: HarnessToolDescriptor = Object.freeze({
  description: DESCRIPTION,
  effects: "none",
  inputSchema: INPUT_SCHEMA,
  name: UPDATE_PLAN_TOOL_NAME,
  needsApproval: false,
  requiresVm: false,
  tool: Object.freeze({ capability: "session", description: DESCRIPTION, inputSchema: INPUT_SCHEMA, name: UPDATE_PLAN_TOOL_NAME, strict: false })
});

/** The plan of a call's arguments, or what is wrong with them. */
export function parsePlanUpdate(value: Record<string, unknown>): Readonly<{ ok: true; update: PlanUpdate }> | Readonly<{ message: string; ok: false }> {
  const fail = (message: string) => ({ message, ok: false as const });
  const unknown = Object.keys(value).filter((key) => key !== "plan" && key !== "explanation");
  if (unknown.length) return fail(`Unknown argument ${JSON.stringify(unknown[0])}; pass only plan and an optional explanation.`);
  const { explanation, plan } = value;
  if (explanation !== undefined && typeof explanation !== "string") return fail("explanation must be a string.");
  if (typeof explanation === "string" && explanation.length > UPDATE_PLAN_LIMITS.explanationCharacters) {
    return fail(`explanation is longer than ${UPDATE_PLAN_LIMITS.explanationCharacters} characters; shorten it.`);
  }
  if (!Array.isArray(plan) || !plan.length) return fail("plan must be a non-empty list of {step, status} items.");
  if (plan.length > UPDATE_PLAN_LIMITS.steps) return fail(`plan has ${plan.length} steps; the limit is ${UPDATE_PLAN_LIMITS.steps}. Group related steps.`);
  const steps: { status: PlanStepStatus; step: string }[] = [];
  for (const [index, item] of plan.entries()) {
    const at = `plan[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return fail(`${at} must be an object with step and status.`);
    const { status, step, ...rest } = item as Record<string, unknown>;
    const extra = Object.keys(rest)[0];
    if (extra !== undefined) return fail(`${at} has unknown field ${JSON.stringify(extra)}; use only step and status.`);
    if (typeof step !== "string" || !step.trim()) return fail(`${at}.step must be a non-empty string.`);
    if (step.length > UPDATE_PLAN_LIMITS.stepCharacters) return fail(`${at}.step is longer than ${UPDATE_PLAN_LIMITS.stepCharacters} characters; shorten it.`);
    if (typeof status !== "string" || !(PLAN_STEP_STATUSES as readonly string[]).includes(status)) {
      return fail(`${at}.status must be one of ${PLAN_STEP_STATUSES.join(", ")}.`);
    }
    steps.push({ status: status as PlanStepStatus, step: step.trim() });
  }
  const active = steps.filter((step) => step.status === "in_progress").length;
  if (active > 1) return fail(`${active} steps are in_progress; at most one step can be in_progress at a time.`);
  const trimmed = typeof explanation === "string" ? explanation.trim() : "";
  return { ok: true, update: { ...(trimmed ? { explanation: trimmed } : {}), plan: steps } };
}

/**
 * Accepts a plan update. The model gets "Plan updated" (as in Codex); the
 * validated plan travels in `rawPreview.plan` for the progress display.
 */
export function executeUpdatePlan(call: ModelToolCall): ToolExecutionResult {
  if (hasInvalidProviderToolArguments(call.arguments)) {
    return harnessToolError(call, "update_plan_invalid", "The arguments were not valid JSON. Pass {\"plan\": [{\"step\": \"...\", \"status\": \"pending\"}]}.");
  }
  const parsed = parsePlanUpdate(call.arguments);
  if (!parsed.ok) return harnessToolError(call, "update_plan_invalid", parsed.message);
  return {
    callId: call.id,
    content: [{ text: "Plan updated", type: "text" }],
    name: call.name,
    rawPreview: { plan: parsed.update },
    status: "complete"
  };
}
