import { decodeTokenUsage } from "../../domain/usage";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { mergeSearchEvidence } from "../../domain/search";
import type { ToolExecutionResult } from "../tools/types";
import {
  MAX_SEARCH_FINDINGS_CHARACTERS,
  normalizeSearchFindings,
  normalizeSearchSources,
  type SearchSource
} from "./evidence";

/** Version 3 numbers each engine's sources beside its findings with the
 * engine's own citation numbers. Version 2 results, which list one merged
 * source list after all findings, still decode and render exactly as saved. */
export const SEARCH_TOOL_RESULT_VERSION = 3;
export const LEGACY_SEARCH_TOOL_RESULT_VERSION = 2;
export type SearchToolResultVersion =
  | typeof LEGACY_SEARCH_TOOL_RESULT_VERSION
  | typeof SEARCH_TOOL_RESULT_VERSION;

function searchResultVersion(result: ToolExecutionResult): SearchToolResultVersion | null {
  const version = result.rawPreview?.searchResultVersion;
  return version === SEARCH_TOOL_RESULT_VERSION || version === LEGACY_SEARCH_TOOL_RESULT_VERSION
    ? version
    : null;
}

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
  protocol?: string;
  revisionId: string;
  sourceAttribution?: "available" | "provider_unavailable";
  sources: readonly SearchSource[];
  status: "complete" | "error";
  usage: ModelRunUsage;
  warning?: string;
}>;

type SearchFailureEvidence = NonNullable<SearchExecutionEvidence["failure"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutCitation({ citation: _citation, ...source }: SearchSource): SearchSource {
  return source;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function decodedUsage(value: unknown): ModelRunUsage | undefined {
  const usage = decodeTokenUsage(value);
  if (!usage || !isRecord(value) || (value.estimatedCostMicros != null &&
    !nonNegativeNumber(value.estimatedCostMicros))) return undefined;
  return { ...usage, ...(value.estimatedCostMicros !== undefined
    ? { estimatedCostMicros: value.estimatedCostMicros as number | null } : {}) };
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
  const executions = result.rawPreview?.searchExecutions;
  return searchResultVersion(result) !== null && Array.isArray(executions) ? executions : null;
}

export function searchExecutionPreviewCount(result: ToolExecutionResult): number | null {
  return previewExecutions(result)?.length ?? null;
}

export function searchExecutionsFromToolResult(
  result: ToolExecutionResult
): SearchExecutionEvidence[] {
  const values = previewExecutions(result);
  if (!values || values.length > 3) return [];
  const version = searchResultVersion(result);
  if (version === null) return [];
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
      "protocol",
      "revisionId",
      "sourceAttribution",
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
    // Version 2 never carried citation numbers; it decodes exactly as before.
    const sources = normalizeSearchSources(sourceValues, 20).map((source) =>
      version === LEGACY_SEARCH_TOOL_RESULT_VERSION ? withoutCitation(source) : source);
    if (sources.length !== sourceValues.length) return [];
    const sourceAttribution = value.sourceAttribution === undefined ||
      value.sourceAttribution === "available"
      ? value.sourceAttribution
      : value.sourceAttribution === "provider_unavailable"
        ? value.sourceAttribution
        : null;
    if (sourceAttribution === null) return [];
    const providerSourcesUnavailable =
      sourceAttribution === "provider_unavailable" &&
      value.provider === "deepseek" &&
      value.protocol === "deepseek_responses_web_search";
    if (
      sourceAttribution === "provider_unavailable" && !providerSourcesUnavailable ||
      value.status === "complete" &&
        (!findings || (sources.length === 0 && !providerSourcesUnavailable) || failure)
    ) {
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
      ...(typeof value.protocol === "string" ? { protocol: value.protocol } : {}),
      revisionId: value.revisionId,
      ...(sourceAttribution ? { sourceAttribution } : {}),
      sources,
      status: value.status,
      usage,
      ...(failure ? { failure } : {}),
      ...(findings ? { findings } : {}),
      ...(warning ? { warning } : {})
    }];
  });
}

/** Version 2's merged numbered source list, or "" without sources. */
function searchSourcesText(executions: readonly SearchExecutionEvidence[]): string {
  const sources = mergeSearchEvidence(
    executions.map((execution) => execution.optionId),
    executions.filter((execution) => execution.status === "complete").map((execution) => ({
      invocationId: execution.invocationId,
      optionId: execution.optionId,
      sources: execution.sources
    }))
  );
  return sources.length
    ? `Sources:\n${sources.map((source, index) =>
        `${index + 1}. ${source.title} — ${source.url}`).join("\n")}`
    : "";
}

type RenderedEngine = Pick<SearchExecutionEvidence, "displayName" | "findings" | "sources" | "status">;

function findingsHeader(engine: RenderedEngine): string {
  return `Search source ${JSON.stringify(engine.displayName)}:\n`;
}

/** One engine's numbered sources, "" without sources. A cited source keeps
 * the number its findings use; the others follow the highest such number, so
 * an engine without citation numbers is numbered by position. */
function engineSourcesText(engine: RenderedEngine): string {
  let next = Math.max(0, ...engine.sources.map((source) => source.citation ?? 0));
  return engine.sources.length
    ? `Sources for ${JSON.stringify(engine.displayName)}:\n${engine.sources.map((source) =>
        `[${source.citation ?? ++next}] ${source.title} — ${source.url}`).join("\n")}`
    : "";
}

/** Version 3: each successful engine's findings, each followed by its own
 * numbered sources. Provider text is never rewritten. */
function engineBlocksText(engines: readonly RenderedEngine[]): string {
  return engines.flatMap((engine) => engine.status === "complete" && engine.findings
    ? [[`${findingsHeader(engine)}${engine.findings}`, engineSourcesText(engine)].filter(Boolean).join("\n\n")]
    : []).join("\n\n");
}

function searchWarningsText(executions: readonly SearchExecutionEvidence[]): string {
  const warnings = executions.flatMap((execution) => {
    const warning = execution.failure?.code ?? execution.warning;
    return warning
      ? [{ displayName: execution.displayName, warning }]
      : [];
  });
  return warnings.length
    ? `Search warnings: ${warnings.map((warning) =>
        `${JSON.stringify(warning.displayName)}: ${warning.warning}`).join("; ")}`
    : "";
}

export function searchToolResultText(
  executions: readonly SearchExecutionEvidence[],
  version: SearchToolResultVersion = SEARCH_TOOL_RESULT_VERSION
): string {
  const successful = executions.filter((execution) => execution.status === "complete");
  return (version === LEGACY_SEARCH_TOOL_RESULT_VERSION
    ? [
        ...successful.flatMap((execution) => execution.findings
          ? [`${findingsHeader(execution)}${execution.findings}`]
          : []),
        searchSourcesText(executions),
        searchWarningsText(executions)
      ]
    : [engineBlocksText(executions), searchWarningsText(executions)]
  ).filter(Boolean).join("\n\n") || "Every selected search engine failed.";
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** Findings within one byte budget: smaller findings stay whole, larger ones
 * are cut at UTF-8 boundaries with an explicit marker. */
function withBoundedFindings<T extends RenderedEngine>(executions: readonly T[], maxFindingsBytes: number): T[] {
  const sizes = executions.map((execution) => execution.status === "complete" && execution.findings
    ? Buffer.byteLength(execution.findings, "utf8") : 0);
  const order = sizes.flatMap((size, index) => size > 0 ? [index] : [])
    .sort((left, right) => sizes[left]! - sizes[right]! || left - right);
  // Smaller findings stay whole; their unused share goes to larger engines.
  const limits = new Map<number, number>();
  let remaining = Math.max(0, Math.floor(maxFindingsBytes));
  for (const [position, index] of order.entries()) {
    const limit = Math.min(sizes[index]!, Math.floor(remaining / (order.length - position)));
    limits.set(index, limit);
    remaining -= limit;
  }
  return executions.map((execution, index) => {
    const limit = limits.get(index);
    return limit === undefined || limit >= sizes[index]! ? execution : {
      ...execution,
      findings: `${utf8Prefix(execution.findings!, limit)}\n[Findings shortened here; the complete saved result remains readable.]`
    };
  });
}

/** The same canonical text with a bounded findings budget. Only findings are
 * shortened; every engine's numbered sources and the warnings stay complete.
 * The caller owns where the complete accepted result can be read. */
export function boundedSearchToolResultText(
  executions: readonly SearchExecutionEvidence[],
  maxFindingsBytes: number
): string {
  return searchToolResultText(withBoundedFindings(executions, maxFindingsBytes));
}

/** A bounded prefix of already rendered canonical text, for a caller that
 * retains only that text; prefer the engine-aware form when available. */
export function shortenedSearchToolResultText(text: string, maxBytes: number): string {
  const prefix = utf8Prefix(text, Math.max(0, Math.floor(maxBytes)));
  return prefix === text ? text
    : `${prefix}\n[Search result shortened here; the complete saved result remains readable.]`;
}

/** Bound rendered canonical text whose per-engine findings are no longer
 * separately available (a restore retains the text and the receipt's thread
 * sources). Version 2 text shortens its findings as one prefix; the merged
 * numbered source list rendered from those sources, and the warnings after
 * it, stay whole. Version 3 text is split into each engine's findings, which
 * are shortened as live delivery does, and every engine's numbered sources
 * and the warnings stay whole. Null when the text is not exactly rendered
 * from those sources (for example a receipt whose trailing sources were
 * dropped to stay bounded). */
export function boundedRenderedSearchToolResultText(
  text: string,
  executions: readonly SearchExecutionEvidence[],
  maxFindingsBytes: number
): string | null {
  return boundedRenderedLegacySearchText(text, executions, maxFindingsBytes) ??
    boundedRenderedEngineText(text, executions, maxFindingsBytes);
}

function boundedRenderedLegacySearchText(
  text: string,
  executions: readonly SearchExecutionEvidence[],
  maxFindingsBytes: number
): string | null {
  const sources = searchSourcesText(executions);
  if (!sources) return null;
  const found = text.lastIndexOf(`\n\n${sources}`);
  const start = found >= 0 ? found + 2 : text.startsWith(sources) ? 0 : -1;
  if (start < 0) return null;
  // Warnings are a single line; nothing else may follow the source list.
  const tail = text.slice(start + sources.length);
  if (tail && !/^\n\nSearch warnings: [^\n]*$/u.test(tail)) return null;
  return start === 0 ? text
    : `${shortenedSearchToolResultText(text.slice(0, start - 2), maxFindingsBytes)}\n\n${text.slice(start)}`;
}

/** Recover each successful engine's findings from version 3 text by the
 * blocks its receipt renders, verified by rendering them again. */
function boundedRenderedEngineText(
  text: string,
  executions: readonly SearchExecutionEvidence[],
  maxFindingsBytes: number
): string | null {
  const engines = executions.filter((execution) => execution.status === "complete");
  // Without any numbered source the text reads the same in both versions and
  // keeps version 2's bound (one findings prefix before the warnings).
  if (!engines.some((engine) => engine.sources.length > 0)) return null;
  const warnings = text.lastIndexOf("\n\nSearch warnings: ");
  const end = warnings >= 0 && !text.includes("\n", warnings + 2) ? warnings : text.length;
  const body = text.slice(0, end);
  const recovered: RenderedEngine[] = [];
  let cursor = 0;
  for (const [index, engine] of engines.entries()) {
    const header = `${index > 0 ? "\n\n" : ""}${findingsHeader(engine)}`;
    if (!body.startsWith(header, cursor)) return null;
    const start = cursor + header.length;
    const sources = engineSourcesText(engine);
    const sourcesBlock = sources ? `\n\n${sources}` : "";
    const following = engines[index + 1];
    const stop = following
      ? body.indexOf(`${sourcesBlock}\n\n${findingsHeader(following)}`, start + 1)
      : body.endsWith(sourcesBlock) ? body.length - sourcesBlock.length : -1;
    if (stop <= start) return null;
    recovered.push({ ...engine, findings: body.slice(start, stop) });
    cursor = stop + sourcesBlock.length;
  }
  if (engineBlocksText(recovered) !== body) return null;
  return `${engineBlocksText(withBoundedFindings(recovered, maxFindingsBytes))}${text.slice(end)}`;
}

/** The merged list never numbers more sources; titles may span lines. */
const RETAINED_SOURCE_ENTRIES = 24;
/** Far above a canonical list and warnings line, far below a tool result. */
const RETAINED_TAIL_BYTES = 128 * 1024;

/** Bound retained canonical text by itself, for a restore whose receipt no
 * longer lists the rendered sources (it dropped snippets or trailing sources
 * to stay bounded). The trailing numbered source list, validated by its
 * consecutive numbering from 1, and the warnings line after it stay whole;
 * only the findings before them are shortened. Version 3 text has no merged
 * list; only its warnings line stays whole here. Null when the text ends with
 * neither. */
export function boundedRetainedSearchToolResultText(text: string, maxFindingsBytes: number): string | null {
  const warnings = text.lastIndexOf("\n\nSearch warnings: ");
  const end = warnings >= 0 && !text.includes("\n", warnings + 2) ? warnings
    : text.startsWith("Search warnings: ") && !text.includes("\n") ? 0 : text.length;
  const body = text.slice(0, end);
  const found = body.lastIndexOf("\n\nSources:\n");
  const sources = found >= 0 ? found + 2 : body.startsWith("Sources:\n") ? 0 : -1;
  const entries = sources >= 0 ? body.slice(sources + "Sources:\n".length).split(/\n(?=\d+\. )/u) : [];
  const numbered = entries.length > 0 && entries.length <= RETAINED_SOURCE_ENTRIES &&
    entries.every((entry, index) => entry.startsWith(`${index + 1}. `) && entry.includes(" — "));
  const start = numbered ? sources : end < text.length ? end + (end > 0 ? 2 : 0) : -1;
  if (start < 0 || Buffer.byteLength(text.slice(start), "utf8") > RETAINED_TAIL_BYTES) return null;
  return start === 0 ? text
    : `${shortenedSearchToolResultText(text.slice(0, start - 2), maxFindingsBytes)}\n\n${text.slice(start)}`;
}

export function searchToolResultContent(
  executions: readonly SearchExecutionEvidence[],
  version: SearchToolResultVersion = SEARCH_TOOL_RESULT_VERSION
): ToolExecutionResult["content"] {
  return [{ text: searchToolResultText(executions, version), type: "text" }];
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
  if (result.rawPreview?.searchResultVersion === undefined) return result;
  const version = searchResultVersion(result);
  if (version === null || markerContent(result, version)) return null;
  const executions = canonicalExecutions(result);
  if (!executions || result.content.length !== 1 || result.content[0]?.type !== "text" ||
    result.content[0].text !== searchToolResultText(executions, version)) {
    return null;
  }
  return { ...result, content: [persistedContentMarker(version)] };
}

export function rehydratePersistedSearchToolExecutionResult(
  result: ToolExecutionResult
): ToolExecutionResult | null {
  if (result.rawPreview?.searchResultVersion === undefined) return result;
  const version = searchResultVersion(result);
  if (version === null || !markerContent(result, version)) return null;
  const executions = canonicalExecutions(result);
  return executions ? { ...result, content: searchToolResultContent(executions, version) } : null;
}
