import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { requirePaidStand, type PaidStand } from "./workspace-user-paid-support";
import type { ActivationClass } from "./workspace-activation-prompts";
import { workspaceToolNameFromNamespaced } from "../lib/server/workspace/toolCatalog";
import { projectActivationAccounting, type ActivationAccounting } from "./workspace-activation-accounting";

export class ActivationFailure extends Error {}
export function check(value: unknown, code: string): asserts value {
  if (!value) throw new ActivationFailure(code);
}
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const serializeActivationJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export function requireActivationTarget(mode: string | undefined, variant: string | undefined, stand: PaidStand) {
  check(mode === "DISPOSABLE", "experiment_opt_in_required");
  check(variant && /^[a-z][a-z0-9_-]{0,47}$/u.test(variant), "variant_invalid");
  check(/^aiqsa-(?:ws-paid|[a-z0-9_]+-qol)-[a-f0-9]{12}$/u.test(stand.name), "experiment_project_invalid");
  // Preserve the shared runtime/loopback guards while accepting a lane-owned
  // dev-server project. The actual Docker/database identity is checked below.
  const target = requirePaidStand(mode, { ...stand, name: `aiqsa-ws-paid-${stand.name.slice(-12)}` });
  return { ...target, project: stand.name, variant };
}
export function requireExternalDirectory(directory: string, repository: string) {
  check(isAbsolute(directory), "report_directory_absolute_required");
  const canonical = realpathSync(directory);
  const rel = relative(realpathSync(repository), canonical);
  check(rel.startsWith(`..${sep}`) || isAbsolute(rel), "report_inside_repository");
  check(resolve(canonical) !== sep, "report_directory_invalid");
  return canonical;
}
export type ExperimentCell = {
  provider: "codex-lb" | "anthropic" | "gemini";
  model: string; reasoning: "low" | "medium" | "default"; repetitions: number;
};
export type ActivationRow = ExperimentCell & {
  promptId: string; class: ActivationClass; language: "ru" | "en"; repetition: number;
  activated: boolean; guestExecution: boolean; toolCalls: number; toolRounds: number; skillDeliveries: number;
  searchUsed: boolean; exportedFiles: number; oraclePassed: boolean | null; officeValid: boolean | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; costMicros: number | null;
  answerRequests: number | null; auxiliaryRequests: number; latencyMs: number;
  paidRequests: number | null;
  accounting?: ActivationAccounting;
  status: "complete" | "error" | "cancelled" | "not_run"; errorCode: string | null;
};
export function rowKey(row: Pick<ActivationRow, "provider" | "model" | "reasoning" | "promptId" | "repetition">) {
  return [row.provider, row.model, row.reasoning, row.promptId, row.repetition].join(":");
}
export function resumeAction(input: { reported: boolean; submitted: boolean; acceptedRuns: number }) {
  check(input.acceptedRuns === 0 || input.acceptedRuns === 1, "exactly_one_admission_required");
  if (input.reported) return "cleanup_reported" as const;
  if (input.acceptedRuns === 1) return "collect_existing" as const;
  check(!input.submitted, "ambiguous_dispatch_requires_diagnosis");
  return "discard_unsent" as const;
}
const finiteCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableCount = (value: unknown) => value === null || finiteCount(value);
// Positive projection: runtime objects, raw provider errors and unknown keys
// never become report fields. Reject malformed known values as well.
export function projectRow(row: ActivationRow): ActivationRow {
  check(["codex-lb", "anthropic", "gemini"].includes(row.provider) && /^[a-zA-Z0-9._/-]{1,100}$/u.test(row.model), "report_cell_invalid");
  check(["low", "medium", "default"].includes(row.reasoning) && [1, 3].includes(row.repetitions), "report_cell_invalid");
  check(/^[DNB](0[1-9]|10)$/u.test(row.promptId) && ["ru", "en"].includes(row.language), "report_prompt_invalid");
  check(["not_needed", "needed", "borderline"].includes(row.class), "report_class_invalid");
  check(finiteCount(row.repetition) && row.repetition >= 1 && row.repetition <= row.repetitions, "report_repetition_invalid");
  check([row.activated, row.guestExecution, row.searchUsed].every(value => typeof value === "boolean"), "report_boolean_invalid");
  check([row.oraclePassed, row.officeValid].every(value => value === null || typeof value === "boolean"), "report_oracle_invalid");
  check([row.toolCalls, row.toolRounds, row.skillDeliveries, row.exportedFiles, row.auxiliaryRequests, row.latencyMs].every(finiteCount), "report_count_invalid");
  check([row.inputTokens, row.outputTokens, row.totalTokens, row.costMicros, row.answerRequests, row.paidRequests].every(nullableCount), "report_usage_invalid");
  check(["complete", "error", "cancelled", "not_run"].includes(row.status), "report_status_invalid");
  check(row.errorCode === null || /^[a-z][a-z0-9_]{0,95}$/u.test(row.errorCode), "report_error_invalid");
  const accounting = row.accounting ? projectActivationAccounting(row.accounting) : undefined;
  if (accounting) check(row.inputTokens === accounting.inputTokens.total && row.outputTokens === accounting.outputTokens.total &&
    row.totalTokens === accounting.totalTokens.total && row.costMicros === accounting.estimatedCostMicros.total &&
    row.paidRequests === accounting.paidRequests, "report_accounting_mismatch");
  return {
    ...(accounting ? { accounting } : {}),
    provider: row.provider, model: row.model, reasoning: row.reasoning, repetitions: row.repetitions,
    promptId: row.promptId, class: row.class, language: row.language, repetition: row.repetition,
    activated: row.activated, guestExecution: row.guestExecution, toolCalls: row.toolCalls, toolRounds: row.toolRounds,
    skillDeliveries: row.skillDeliveries, searchUsed: row.searchUsed, exportedFiles: row.exportedFiles,
    oraclePassed: row.oraclePassed, officeValid: row.officeValid,
    inputTokens: row.inputTokens, outputTokens: row.outputTokens, totalTokens: row.totalTokens, costMicros: row.costMicros,
    answerRequests: row.answerRequests, auxiliaryRequests: row.auxiliaryRequests, paidRequests: row.paidRequests, latencyMs: row.latencyMs,
    status: row.status, errorCode: row.errorCode
  };
}
export function activationMeasurement(calls: { toolName: string; roundIndex: number; state: string }[], skillDeliveries: number) {
  const workspaceCalls = calls.map(call => ({ ...call, originalName: workspaceToolNameFromNamespaced(call.toolName) }));
  return {
    activated: skillDeliveries > 0 || workspaceCalls.some(call => call.originalName !== null ||
      ["checkpoint_outputs", "analyze_image"].includes(call.toolName)),
    guestExecution: workspaceCalls.some(call => call.state === "complete" && call.originalName !== null &&
      ["sandbox_exec", "sandbox_shell", "sandbox_exec_start"].includes(call.originalName)),
    toolCalls: calls.length, toolRounds: new Set(calls.map(call => call.roundIndex)).size, skillDeliveries,
    searchUsed: calls.some(call => /(?:^|_)(search_web|web_search|search)$/u.test(call.toolName))
  };
}
function rate(numerator: number, denominator: number) {
  return { numerator, denominator, fraction: denominator ? numerator / denominator : null };
}
function usage(rows: ActivationRow[], field: "inputTokens" | "outputTokens" | "totalTokens" | "costMicros" | "answerRequests" | "paidRequests") {
  const known = rows.filter(row => row[field] !== null);
  const accountingField = field === "costMicros" ? "estimatedCostMicros" :
    field === "inputTokens" || field === "outputTokens" || field === "totalTokens" ? field : null;
  const knownSum = rows.reduce((sum, row) => sum + (accountingField && row.accounting
    ? row.accounting[accountingField].knownSum : field === "paidRequests" && row.accounting
      ? row.accounting.paidRequestCounts.knownSum : row[field] ?? 0), 0);
  return { total: known.length === rows.length ? knownSum : null, knownSum, reported: known.length, missing: rows.length - known.length };
}
export function aggregateActivationRows(rows: ActivationRow[]) {
  const executed = rows.filter(row => row.status !== "not_run");
  const needed = executed.filter(row => row.class === "needed");
  const office = executed.filter(row => row.officeValid !== null);
  const mean = (field: "toolCalls" | "latencyMs") => executed.length ? executed.reduce((sum, row) => sum + row[field], 0) / executed.length : null;
  return {
    planned: rows.length, executed: executed.length, paidRunAdmissions: executed.length, notRun: rows.length - executed.length,
    activation: rate(executed.filter(row => row.activated).length, executed.length),
    meanToolCalls: mean("toolCalls"), searchUse: rate(executed.filter(row => row.searchUsed).length, executed.length),
    neededSuccess: rate(needed.filter(row => row.status === "complete" && row.oraclePassed).length, needed.length),
    officeValidity: rate(office.filter(row => row.officeValid).length, office.length),
    completed: rate(executed.filter(row => row.status === "complete").length, executed.length),
    inputTokens: usage(executed, "inputTokens"), outputTokens: usage(executed, "outputTokens"), totalTokens: usage(executed, "totalTokens"),
    costMicros: usage(executed, "costMicros"), answerRequests: usage(executed, "answerRequests"),
    paidRequests: usage(executed, "paidRequests"),
    auxiliaryRequests: executed.reduce((sum, row) => sum + row.auxiliaryRequests, 0), meanLatencyMs: mean("latencyMs")
  };
}
export function buildActivationReport(input: { variant: string; corpusHash: string; sourceHash: string; configurationHash: string;
  executionConfigurationHash?: string; oracleHash?: string; treatmentHash?: string; rows: ActivationRow[]; cleanup: boolean }) {
  check(/^[a-z][a-z0-9_-]{0,47}$/u.test(input.variant), "variant_invalid");
  check([input.corpusHash, input.sourceHash, input.configurationHash].every(value => /^[a-f0-9]{64}$/u.test(value)), "report_hash_invalid");
  check([input.executionConfigurationHash, input.oracleHash, input.treatmentHash].every(value => value === undefined || /^[a-f0-9]{64}$/u.test(value)), "report_hash_invalid");
  const rows = input.rows.map(projectRow);
  const executed = rows.filter(row => row.status !== "not_run");
  check(new Set(rows.map(rowKey)).size === rows.length, "duplicate_execution");
  const groups = new Map<string, ActivationRow[]>();
  for (const row of rows) {
    const key = [row.provider, row.model, row.reasoning, row.class].join(":");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return {
    version: 1, variant: input.variant, corpusHash: input.corpusHash, sourceHash: input.sourceHash,
    ...(input.executionConfigurationHash ? { executionConfigurationHash: input.executionConfigurationHash } : {}),
    ...(input.oracleHash ? { oracleHash: input.oracleHash } : {}),
    ...(input.treatmentHash ? { treatmentHash: input.treatmentHash } : {}),
    accountingVersion: executed.length > 0 && executed.every(row => row.accounting) ? 2 : 1,
    configurationHash: input.configurationHash, cleanupComplete: input.cleanup,
    totals: aggregateActivationRows(rows),
    cells: [...groups.values()].map(group => ({ provider: group[0].provider, model: group[0].model, reasoning: group[0].reasoning, class: group[0].class, ...aggregateActivationRows(group) })),
    prompts: [...new Set(rows.map(row => [row.provider, row.model, row.reasoning, row.promptId].join(":")))].map(key => {
      const group = rows.filter(row => [row.provider, row.model, row.reasoning, row.promptId].join(":") === key);
      return { provider: group[0].provider, model: group[0].model, reasoning: group[0].reasoning, promptId: group[0].promptId,
        activation: rate(group.filter(row => row.activated).length, group.filter(row => row.status !== "not_run").length) };
    }), rows
  };
}
