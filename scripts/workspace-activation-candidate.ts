import { workspaceToolNameFromNamespaced } from "../lib/server/workspace/toolCatalog";
import type { CatalogWireModel } from "../lib/contracts/catalog";
import { aggregateActivationRows, buildActivationReport, check, digest, projectRow, rowKey, type ActivationRow } from "./workspace-activation-support";

export type GuideCall = { toolName: string; arguments: unknown; result: unknown; state: string;
  roundIndex: number; ordinal: number; startedAt: Date | null; completedAt: Date | null };
type GuideAssessment = "read_before_work" | "work_before_read" | "unverified_read" | "ordering_unknown" | "no_work";
export type OfficeGuideMetric = { key: string; completed: boolean; guideReadBeforeWork: boolean | null;
  guideReadAssessment: GuideAssessment; fullGuideReads: number; readCalls: number; unknownCommands: number };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const guidePath = "/workspace/guides/office.md";

/** Bind the chosen deployment, even when another catalogue entry exposes the
 * same upstream model and controls. Acquisition mode is deliberately absent. */
export function activationModelIdentity(model: Pick<CatalogWireModel, "modelId" | "provider" | "providerFamily" | "upstreamModelId"> | undefined) {
  return model ? { modelId: model.modelId, provider: model.provider, family: model.providerFamily, upstream: model.upstreamModelId } : null;
}

/** Deliberately narrow shell recognition: one read-only command, never a
 * pipeline, substitution, redirect, or a read-and-create compound statement. */
function simpleCommand(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  const parts = value.trim().match(/(?:'[^']*'|"[^"$`]*"|[^\s'"`$;&|<>()\\]+)/gu);
  if (!parts || parts.join(" ") !== value.trim().replace(/\s+/gu, " ")) return null;
  return parts.map(part => part.replace(/^(['"])(.*)\1$/u, "$2"));
}
function guideRead(call: GuideCall): boolean {
  const name = workspaceToolNameFromNamespaced(call.toolName), args = object(call.arguments);
  if (name === "sandbox_fs_read") return args.path === guidePath && (args.encoding === undefined || args.encoding === "utf8");
  if (name !== "sandbox_exec" && name !== "sandbox_shell") return false;
  const tokens = Array.isArray(args.args) && args.args.every(value => typeof value === "string") && typeof args.command === "string"
    ? [args.command, ...args.args as string[]] : simpleCommand(args.command);
  if (!tokens) return false;
  const [command, ...rest] = tokens;
  if (command === "cat") return rest.length === 1 && rest[0] === guidePath || rest.length === 2 && rest[0] === "--" && rest[1] === guidePath;
  if (command === "head") return rest.length === 1 && rest[0] === guidePath ||
    rest.length === 3 && rest[0] === "-n" && /^\d{1,7}$/u.test(rest[1]) && rest[2] === guidePath;
  return command === "sed" && rest.length === 3 && rest[0] === "-n" && /^(?:p|1,\d{1,7}p)$/u.test(rest[1]) && rest[2] === guidePath;
}
function fullGuideDelivered(call: GuideCall, guide: string): boolean {
  if (!guideRead(call) || call.state !== "complete" || !call.completedAt) return false;
  const result = object(call.result);
  if (result.status !== "complete" || object(result.rawPreview).truncated === true || !Array.isArray(result.content)) return false;
  // Inspect only the retained model-facing result. A large original retained
  // in ToolObservation but replaced by a reader handle is not delivery proof.
  return result.content.some(part => {
    const item = object(part);
    let payload: Record<string, unknown>;
    try { payload = object(item.type === "text" && typeof item.text === "string" && item.text.length <= 128 * 1024
      ? JSON.parse(item.text) : item.type === "json" ? item.value : undefined); } catch { return false; }
    if (payload.ok !== true || payload.truncated === true || Array.isArray(payload.truncated) && payload.truncated.length > 0) return false;
    const data = object(payload.data), bytes = data.content ?? data.stdout;
    return (bytes === guide || bytes === `${guide}\n`) && data.truncated !== true &&
      (data.exitCode === undefined || data.exitCode === 0) && (data.success === undefined || data.success === true);
  });
}
export function officeGuideMetric(row: ActivationRow, calls: readonly GuideCall[], guide: string): OfficeGuideMetric {
  check(["N04", "N09", "N10"].includes(row.promptId), "office_metric_prompt_invalid");
  const ordered = [...calls].sort((a, b) => a.roundIndex - b.roundIndex || a.ordinal - b.ordinal);
  const reads = ordered.filter(guideRead), fullReads = reads.filter(call => fullGuideDelivered(call, guide));
  const work = ordered.filter(call => {
    const name = workspaceToolNameFromNamespaced(call.toolName);
    return call.toolName === "checkpoint_outputs" || name !== null && !guideRead(call) &&
      !["sandbox_fs_read", "sandbox_fs_list", "sandbox_fs_stat"].includes(name);
  });
  const first = work[0];
  let assessment: GuideAssessment;
  let before: boolean | null = false;
  if (!first) assessment = "no_work";
  else if (fullReads.some(read => read.roundIndex < first.roundIndex && read.completedAt && first.startedAt &&
    read.completedAt.getTime() <= first.startedAt.getTime())) { assessment = "read_before_work"; before = true; }
  else if (!first.startedAt || fullReads.some(read => read.roundIndex < first.roundIndex && !read.completedAt)) {
    assessment = "ordering_unknown"; before = null;
  } else if (reads.some(read => read.roundIndex < first.roundIndex) && !fullReads.some(read => read.roundIndex < first.roundIndex)) {
    assessment = "unverified_read"; before = null;
  } else assessment = "work_before_read";
  return { key: rowKey(row), completed: row.status === "complete", guideReadBeforeWork: before, guideReadAssessment: assessment,
    fullGuideReads: fullReads.length, readCalls: reads.length,
    unknownCommands: work.filter(call => ["sandbox_exec", "sandbox_shell", "sandbox_exec_start"].includes(workspaceToolNameFromNamespaced(call.toolName) ?? "")).length };
}
export function projectOfficeGuideMetric(metric: OfficeGuideMetric): OfficeGuideMetric {
  check(/^(codex-lb|anthropic|gemini):[a-zA-Z0-9._/-]{1,100}:(low|medium|default):N(04|09|10):[1-3]$/u.test(metric.key), "office_metric_key_invalid");
  check(typeof metric.completed === "boolean" && (metric.guideReadBeforeWork === null || typeof metric.guideReadBeforeWork === "boolean") &&
    ["read_before_work", "work_before_read", "unverified_read", "ordering_unknown", "no_work"].includes(metric.guideReadAssessment) &&
    [metric.fullGuideReads, metric.readCalls, metric.unknownCommands].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000), "office_metric_invalid");
  check(metric.fullGuideReads <= metric.readCalls && (metric.guideReadBeforeWork === true) === (metric.guideReadAssessment === "read_before_work"), "office_metric_inconsistent");
  return { key: metric.key, completed: metric.completed, guideReadBeforeWork: metric.guideReadBeforeWork,
    guideReadAssessment: metric.guideReadAssessment, fullGuideReads: metric.fullGuideReads, readCalls: metric.readCalls, unknownCommands: metric.unknownCommands };
}
export function officeGuideReport(rows: readonly OfficeGuideMetric[]) {
  const projected = rows.map(projectOfficeGuideMetric);
  check(new Set(projected.map(row => row.key)).size === projected.length, "office_metric_duplicate");
  return { version: 1, measurement: "full_release_result_before_later_work_round" as const,
    denominator: projected.length, completed: projected.filter(row => row.completed).length,
    readBeforeWork: projected.filter(row => row.guideReadBeforeWork === true).length,
    unknown: projected.filter(row => row.guideReadBeforeWork === null).length, rows: projected };
}

export type LookupRow = { sample: number; row: ActivationRow };
export const lookupSamples = 5;
export function projectLookupRow(entry: LookupRow): LookupRow {
  const row = projectRow(entry.row);
  check(Number.isInteger(entry.sample) && entry.sample >= 1 && entry.sample <= lookupSamples && row.provider === "codex-lb" &&
    row.model === "gpt-5.6-sol" && ["low", "medium"].includes(row.reasoning) && row.promptId === "B02" && row.class === "borderline" &&
    row.repetitions === 1 && row.repetition === 1, "lookup_row_invalid");
  return { sample: entry.sample, row };
}
export const lookupKey = (entry: LookupRow) => `${entry.row.reasoning}:${entry.sample}`;
export function lookupReport(entries: readonly LookupRow[]) {
  const rows = entries.map(projectLookupRow);
  check(new Set(rows.map(lookupKey)).size === rows.length && rows.length <= 10, "lookup_duplicate");
  const completedWithoutActivation = rows.filter(entry => entry.row.status === "complete" && !entry.row.activated).length;
  return { version: 1, purpose: "supplemental_b02_lookup" as const, planned: 10, perReasoning: lookupSamples,
    completedWithoutActivation, requiredWithoutActivation: 9,
    passed: rows.length === 10 ? rows.every(entry => entry.row.status === "complete") && completedWithoutActivation >= 9 : null,
    totals: aggregateActivationRows(rows.map(entry => entry.row)), rows };
}

/** The separate lookup acquisition must use the same candidate release as its
 * completed core. Keep its cost separate, and expose their honest combined sum. */
export function readLookupCoreReport(bytes: Buffer, expectedHash: string, sourceHash: string, corpusHash: string, oracleHash: string) {
  check(/^[a-f0-9]{64}$/u.test(expectedHash) && bytes.length <= 4 * 1024 * 1024 && digest(bytes) === expectedHash, "lookup_core_digest_mismatch");
  const raw = object(JSON.parse(bytes.toString("utf8")));
  check(raw.version === 1 && raw.cleanupComplete === true && raw.sourceHash === sourceHash && raw.corpusHash === corpusHash &&
    raw.oracleHash === oracleHash && Array.isArray(raw.rows) && raw.rows.length === 240, "lookup_core_mismatch");
  const report = buildActivationReport({ variant: raw.variant as string, sourceHash, corpusHash,
    configurationHash: raw.configurationHash as string, oracleHash,
    treatmentHash: raw.treatmentHash as string,
    executionConfigurationHash: raw.executionConfigurationHash as string, rows: raw.rows as ActivationRow[], cleanup: true });
  const codex = report.rows.filter(row => row.provider === "codex-lb");
  check(codex.length === 180 && codex.every(row => row.model === "gpt-5.6-sol" && row.status !== "not_run"), "lookup_core_incomplete");
  check(typeof report.treatmentHash === "string", "lookup_core_treatment_missing");
  return { hash: expectedHash, report };
}
export function requireLookupTreatment(core: ReturnType<typeof readLookupCoreReport>, treatmentHash: string): void {
  check(core.report.treatmentHash === treatmentHash, "lookup_core_treatment_changed");
}
