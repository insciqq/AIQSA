import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { mergeSearchEvidence } from "../../domain/search";
import type { ToolExecutionResult } from "../tools/types";
import {
  MAX_SEARCH_FINDINGS_CHARACTERS,
  normalizeSearchFindings,
  normalizeSearchSources,
  type SearchSource
} from "./evidence";

export const SEARCH_TOOL_RESULT_VERSION = 2;

function persistedContentMarker(version: number) {
  return {
    type: "json" as const,
    value: { aiqsaType: "search_result", version }
  };
}

export type SearchExecutionEvidence = Readonly<{
  displayName: string;
  failure?: Readonly<{
    code: string;
    providerStatus?: string;
    reason?: string;
  }>;
  findings?: string;
  invocationId: string;
  modelId: string | null;
  optionId: string;
  provider: string;
  revisionId: string;
  sources: readonly SearchSource[];
  status: "complete" | "error";
  usage: ModelRunUsage;
  warning?: string;
}>;

type SearchFailureEvidence = NonNullable<SearchExecutionEvidence["failure"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function decodedUsage(value: unknown): ModelRunUsage | undefined {
  if (!isRecord(value) ||
    !nonNegativeNumber(value.inputTokens) ||
    !nonNegativeNumber(value.outputTokens) ||
    !nonNegativeNumber(value.reasoningTokens) ||
    (value.cachedInputTokens !== undefined && !nonNegativeNumber(value.cachedInputTokens)) ||
    (value.cacheWriteInputTokens !== undefined && !nonNegativeNumber(value.cacheWriteInputTokens)) ||
    (value.totalTokens !== undefined && !nonNegativeNumber(value.totalTokens)) ||
    (value.estimatedCostMicros !== undefined && value.estimatedCostMicros !== null &&
      !nonNegativeNumber(value.estimatedCostMicros))) {
    return undefined;
  }
  return {
    ...(value.cachedInputTokens !== undefined ? { cachedInputTokens: value.cachedInputTokens } : {}),
    ...(value.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: value.cacheWriteInputTokens }
      : {}),
    ...(value.estimatedCostMicros !== undefined
      ? { estimatedCostMicros: value.estimatedCostMicros }
      : {}),
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    reasoningTokens: value.reasoningTokens,
    ...(value.totalTokens !== undefined ? { totalTokens: value.totalTokens } : {})
  };
}

function normalizedFailureCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value)
    ? value
    : "search_execution_failed";
}

function boundedFailureField(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function decodedFindings(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeSearchFindings(value);
  } catch {
    return undefined;
  }
}

function decodedFailure(value: unknown): SearchFailureEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const code = normalizedFailureCode(value.code);
  const providerStatus = boundedFailureField(value.providerStatus, 64);
  const reason = boundedFailureField(value.reason, 128);
  return {
    code,
    ...(providerStatus ? { providerStatus } : {}),
    ...(reason ? { reason } : {})
  };
}

function previewExecutions(result: ToolExecutionResult): unknown[] | null {
  const rawPreview = result.rawPreview;
  return rawPreview?.searchResultVersion === SEARCH_TOOL_RESULT_VERSION &&
    Array.isArray(rawPreview.searchExecutions)
    ? rawPreview.searchExecutions
    : null;
}

export function searchExecutionPreviewCount(result: ToolExecutionResult): number | null {
  return previewExecutions(result)?.length ?? null;
}

export function searchExecutionsFromToolResult(
  result: ToolExecutionResult
): SearchExecutionEvidence[] {
  const values = previewExecutions(result);
  if (!values || values.length > 3) return [];
  const version = result.rawPreview?.searchResultVersion;
  if (version !== SEARCH_TOOL_RESULT_VERSION) return [];
  return values.flatMap((value): SearchExecutionEvidence[] => {
    if (!isRecord(value)) return [];
    const usage = decodedUsage(value.usage);
    if (!(
      typeof value.invocationId === "string" &&
      (value.modelId === null || typeof value.modelId === "string") &&
      typeof value.optionId === "string" &&
      typeof value.provider === "string" &&
      typeof value.revisionId === "string" &&
      Array.isArray(value.sources) &&
      (value.findings === undefined || (
        typeof value.findings === "string" &&
        value.findings.length <= MAX_SEARCH_FINDINGS_CHARACTERS
      )) &&
      (value.status === "complete" || value.status === "error") &&
      usage !== undefined
    )) return [];
    const allowedKeys = new Set([
      "displayName",
      "failure",
      "findings",
      "invocationId",
      "modelId",
      "optionId",
      "provider",
      "revisionId",
      "sources",
      "status",
      "usage",
      "warning"
    ]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) return [];
    const failure = value.failure === undefined ? undefined : decodedFailure(value.failure);
    if (value.failure !== undefined && !failure) return [];
    const findings = decodedFindings(value.findings);
    if (value.findings !== undefined && !findings) return [];
    const warning = value.warning === undefined
      ? undefined
      : boundedFailureField(value.warning, 512);
    if (value.warning !== undefined && !warning) return [];
    const sourceValues = value.sources as unknown[];
    const sources = normalizeSearchSources(sourceValues, 20);
    if (sources.length !== sourceValues.length) return [];
    if (value.status === "complete" && (!findings || sources.length === 0 || failure)) {
      return [];
    }
    if (value.status === "error" && !failure) return [];
    return [{
      displayName: typeof value.displayName === "string" && value.displayName.trim()
        ? value.displayName.trim().slice(0, 256)
        : "Search source",
      invocationId: value.invocationId,
      modelId: value.modelId,
      optionId: value.optionId,
      provider: value.provider,
      revisionId: value.revisionId,
      sources,
      status: value.status,
      usage,
      ...(failure ? { failure } : {}),
      ...(findings ? { findings } : {}),
      ...(warning ? { warning } : {})
    }];
  });
}

export function searchToolResultText(executions: readonly SearchExecutionEvidence[]): string {
  const successful = executions.filter((execution) => execution.status === "complete");
  const sources = mergeSearchEvidence(
    executions.map((execution) => execution.optionId),
    successful.map((execution) => ({
      invocationId: execution.invocationId,
      optionId: execution.optionId,
      sources: execution.sources
    }))
  );
  const warnings = executions.flatMap((execution) => {
    const warning = execution.failure?.code ?? execution.warning;
    return warning
      ? [{ displayName: execution.displayName, warning }]
      : [];
  });
  return [
    ...successful.flatMap((execution) => execution.findings
      ? [`Search source ${JSON.stringify(execution.displayName)}:\n${execution.findings}`]
      : []),
    sources.length
      ? `Sources:\n${sources.map((source, index) =>
          `${index + 1}. ${source.title} — ${source.url}`).join("\n")}`
      : "",
    warnings.length
      ? `Search warnings: ${warnings.map((warning) =>
          `${JSON.stringify(warning.displayName)}: ${warning.warning}`).join("; ")}`
      : ""
  ].filter(Boolean).join("\n\n") || "Every selected search engine failed.";
}

export function searchToolResultContent(
  executions: readonly SearchExecutionEvidence[]
): ToolExecutionResult["content"] {
  return [{ text: searchToolResultText(executions), type: "text" }];
}

function markerContent(result: ToolExecutionResult, version: number): boolean {
  const [entry] = result.content;
  return result.content.length === 1 && entry?.type === "json" && isRecord(entry.value) &&
    entry.value.aiqsaType === "search_result" && entry.value.version === version &&
    Object.keys(entry.value).length === 2;
}

function canonicalExecutions(result: ToolExecutionResult): SearchExecutionEvidence[] | null {
  const values = previewExecutions(result);
  if (!values || values.length === 0) return null;
  const executions = searchExecutionsFromToolResult(result);
  if (executions.length !== values.length) return null;
  const expectedStatus = executions.some((execution) => execution.status === "complete")
    ? "complete"
    : "error";
  return result.status === expectedStatus ? executions : null;
}

/** Replace derived provider-facing text with a versioned marker before durable
 * JSON serialization. Findings and sources remain once in the purpose-built
 * Search checkpoint and are deterministically rehydrated when read. */
export function compactSearchToolExecutionResult(
  result: ToolExecutionResult
): ToolExecutionResult | null {
  const version = result.rawPreview?.searchResultVersion;
  if (version === undefined) return result;
  if (
    version !== SEARCH_TOOL_RESULT_VERSION ||
    markerContent(result, version)
  ) return null;
  const executions = canonicalExecutions(result);
  if (!executions || result.content.length !== 1 || result.content[0]?.type !== "text" ||
    result.content[0].text !== searchToolResultText(executions)) {
    return null;
  }
  return { ...result, content: [persistedContentMarker(version)] };
}

export function rehydratePersistedSearchToolExecutionResult(
  result: ToolExecutionResult
): ToolExecutionResult | null {
  const version = result.rawPreview?.searchResultVersion;
  if (version === undefined) return result;
  if (
    version !== SEARCH_TOOL_RESULT_VERSION ||
    !markerContent(result, version)
  ) return null;
  const executions = canonicalExecutions(result);
  return executions ? { ...result, content: searchToolResultContent(executions) } : null;
}
