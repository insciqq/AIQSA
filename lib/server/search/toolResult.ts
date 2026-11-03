import { decodeTokenUsage, reportedCostMicros } from "../../domain/usage";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { mergeSearchEvidence } from "../../domain/search";
import { takeUtf16SafePrefix } from "../../domain/utf16";
import type { ToolExecutionResult } from "../tools/types";
import {
  MAX_SEARCH_FINDINGS_CHARACTERS,
  normalizeSearchFindings,
  normalizeSearchSources,
  SEARCH_NO_RESULTS_FINDINGS,
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
  /** USD the provider reported for this engine call (OpenRouter `usage.cost`);
   * absent when it reported none. */
  costUsd?: number;
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
      "costUsd",
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
    if (value.costUsd !== undefined && !nonNegativeNumber(value.costUsd)) return [];
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
    const sources = normalizeSearchSources(sourceValues).map((source) =>
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
    // A raw results API's empty answer carries only the server's own words.
    const explicitNoResults = sources.length === 0 &&
      sourceAttribution !== "provider_unavailable" &&
      value.provider === "deepseek" &&
      value.protocol === "deepseek_search_api" &&
      findings === SEARCH_NO_RESULTS_FINDINGS;
    if (
      sourceAttribution === "provider_unavailable" && !providerSourcesUnavailable ||
      value.status === "complete" &&
        (!findings || (sources.length === 0 && !providerSourcesUnavailable && !explicitNoResults) || failure)
    ) {
      return [];
    }
    if (value.status === "error" && !failure) return [];
    return [{
      ...(value.costUsd !== undefined ? { costUsd: value.costUsd as number } : {}),
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

/** A Search engine call as a run usage attribution. */
export type SearchUsageAttribution = Readonly<{
  /** Micro-dollars the provider reported for the call. Absent when it reported
   * none: the run's attribution row then prices the call from the engine
   * model's token prices and per-search fee. */
  estimatedCostMicros?: number | null;
  modelId: string;
  operationCount: 1;
  provider: string;
  purpose: "web_search";
  usage: ModelRunUsage;
}>;

/** The paid call of one engine as a run usage attribution: its tokens and the
 * searches it reported; a reported cost settles the call. */
export function searchUsageAttribution(execution: SearchExecutionEvidence): SearchUsageAttribution {
  return {
    ...(execution.costUsd !== undefined ? { estimatedCostMicros: reportedCostMicros(execution.costUsd) } : {}),
    modelId: execution.modelId ?? "search",
    operationCount: 1,
    provider: execution.provider,
    purpose: "web_search",
    usage: execution.usage
  };
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

/** One engine's numbered source lines. A cited source keeps the number its
 * findings use; the others follow the highest such number, so an engine
 * without citation numbers is numbered by position. */
function engineSourceLines(engine: RenderedEngine): Readonly<{ line: string; number: number }>[] {
  let next = engine.sources.reduce((highest, source) => Math.max(highest, source.citation ?? 0), 0);
  return engine.sources.map((source) => {
    const number = source.citation ?? ++next;
    return { line: `[${number}] ${source.title} — ${source.url}`, number };
  });
}

/** One engine's numbered sources, "" without sources. */
function engineSourcesText(engine: RenderedEngine): string {
  return engine.sources.length
    ? `Sources for ${JSON.stringify(engine.displayName)}:\n${engineSourceLines(engine).map(({ line }) => line).join("\n")}`
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

/** How many of an engine's first sources a fair share keeps besides those its shown findings cite. */
export const SEARCH_FAIR_SHARE_FIRST_SOURCES = 3;

/** A citation in findings: `[3]` or `[3, 5]`. */
const CITATION = /\[(\d{1,4}(?:\s*,\s*\d{1,4})*)\]/gu;
/** Where the next DeepSeek Search API entry starts (`[n] title — label`, `lib/server/providers/deepSeekSearchApi.ts`). */
const DEEPSEEK_ENTRY_START = /\n\n(?=\[\d{1,4}\] )/gu;

type SourceLine = Readonly<{ line: string; number: number }>;

type FairShareBlock = Readonly<{
  displayName: string;
  findings: string;
  findingsStart: number;
  header: string;
  lines: readonly SourceLine[];
  size: number;
  sourcesStart: number;
  start: number;
  wholeEntries: boolean;
}>;

function citedNumbers(text: string): Set<number> {
  const cited = new Set<number>();
  for (const match of text.matchAll(CITATION)) {
    for (const value of match[1]!.split(",")) cited.add(Number(value.trim()));
  }
  return cited;
}

/** The beginning of findings within `room`: whole DeepSeek entries when one fits, else a cut at a paragraph, line or word end. */
function findingsPrefix(findings: string, room: number, wholeEntries: boolean): string {
  if (findings.length <= room) return findings;
  if (room <= 0) return "";
  if (wholeEntries) {
    let end = 0;
    for (const match of findings.matchAll(DEEPSEEK_ENTRY_START)) {
      if (match.index > room) break;
      end = match.index;
    }
    if (end > 0) return findings.slice(0, end);
  }
  const prefix = takeUtf16SafePrefix(findings, room);
  const half = Math.floor(room / 2);
  for (const boundary of ["\n\n", "\n", " "]) {
    const at = prefix.lastIndexOf(boundary);
    if (at >= half) return prefix.slice(0, at).trimEnd();
  }
  return prefix;
}

/** Max-min fair shares of `budget`: a block smaller than its share keeps all of it, and what it leaves goes to the larger ones. */
function fairShares(sizes: readonly number[], budget: number): number[] {
  const shares = sizes.map(() => 0);
  let open = sizes.map((_, index) => index);
  let left = budget;
  while (open.length > 0) {
    const share = Math.floor(left / open.length);
    const small = open.filter((index) => sizes[index]! <= share);
    if (small.length === 0) {
      for (const index of open) shares[index] = share;
      break;
    }
    for (const index of small) {
      shares[index] = sizes[index]!;
      left -= sizes[index]!;
    }
    open = open.filter((index) => sizes[index]! > share);
  }
  return shares;
}

/** The characters a sources part takes: the blank line before it, its heading and one line per source. */
function sourcesCost(heading: string, lines: readonly SourceLine[]): number {
  return lines.length === 0 ? 0 : 2 + heading.length + lines.reduce((sum, { line }) => sum + 1 + line.length, 0);
}

/** One engine block within `room`: what it keeps verbatim, and a note for each part it cut. */
function fairShareBlock(block: FairShareBlock, room: number): Readonly<{ shown: number; text: string }> {
  const name = JSON.stringify(block.displayName);
  const heading = `Sources for ${name}:`;
  const sourcesFor = (kept: string) => {
    const cited = citedNumbers(kept);
    return block.lines.filter((line, index) => index < SEARCH_FAIR_SHARE_FIRST_SOURCES || cited.has(line.number));
  };
  const cost = (kept: string, lines: readonly SourceLine[]) => block.header.length + kept.length + sourcesCost(heading, lines);
  let findingsRoom = room - block.header.length - sourcesCost(heading, block.lines.slice(0, SEARCH_FAIR_SHARE_FIRST_SOURCES));
  let kept = findingsPrefix(block.findings, findingsRoom, block.wholeEntries);
  let lines = sourcesFor(kept);
  // Each pass keeps a shorter beginning, which cites no more sources than a longer one, so it ends within room or with nothing kept.
  while (kept.length > 0 && cost(kept, lines) > room) {
    findingsRoom = kept.length - (cost(kept, lines) - room);
    kept = findingsPrefix(block.findings, findingsRoom, block.wholeEntries);
    lines = sourcesFor(kept);
  }
  while (lines.length > 0 && cost(kept, lines) > room) lines = lines.slice(0, -1);
  let findingsPart = `${block.header}${kept}`;
  if (kept.length < block.findings.length) {
    findingsPart += `${kept ? "\n" : ""}[Search source ${name}: findings cut here, ${kept.length} of ${block.findings.length} characters ` +
      `shown; the rest starts at offset ${block.findingsStart + kept.length} of the saved result.]`;
  }
  const parts = [findingsPart];
  if (block.lines.length > 0) {
    const cut = lines.length < block.lines.length
      ? `[Sources for ${name}: ${lines.length} of ${block.lines.length} shown, the first ${SEARCH_FAIR_SHARE_FIRST_SOURCES} and those ` +
        `the shown findings cite; the whole list starts at offset ${block.sourcesStart} of the saved result.]`
      : null;
    parts.push([...lines.length > 0 ? [heading, ...lines.map(({ line }) => line)] : [], ...cut ? [cut] : []].join("\n"));
  }
  return { shown: cost(kept, lines), text: parts.join("\n\n") };
}

/**
 * The model's view of a merged search result too long to show whole (`lib/server/engine/toolResults.ts`): each engine block gets a fair
 * share of `budget`, so the engine listed last is no longer lost in the omitted middle (acceptance run 2026-11-02: of three selected
 * engines the model saw one and a half). A block keeps its header, the beginning of its findings (whole DeepSeek entries), the source
 * lines that beginning cites and its first few, and says what it left out and at which offset of the saved text the rest starts. Every
 * kept part is the saved text verbatim, so a quote from one checks against the saved copy. Null unless the result is a current-version
 * search result of two or more engine blocks whose text is exactly `text`; the caller then cuts it as any other result.
 */
export function searchToolResultFairShare(
  result: ToolExecutionResult,
  text: string,
  budget: number
): Readonly<{ shown: number; text: string }> | null {
  if (searchResultVersion(result) !== SEARCH_TOOL_RESULT_VERSION) return null;
  const executions = canonicalExecutions(result);
  if (!executions || searchToolResultText(executions) !== text) return null;
  const engines = executions.filter((engine) => engine.status === "complete" && engine.findings);
  if (engines.length < 2) return null;
  const blocks: FairShareBlock[] = [];
  let start = 0;
  for (const engine of engines) {
    const header = findingsHeader(engine);
    const findings = engine.findings!;
    const sources = engineSourcesText(engine);
    const findingsStart = start + header.length;
    const size = header.length + findings.length + (sources ? 2 + sources.length : 0);
    blocks.push({ displayName: engine.displayName, findings, findingsStart, header, lines: engineSourceLines(engine), size,
      sourcesStart: findingsStart + findings.length + 2, start, wholeEntries: engine.provider === "deepseek" && engine.protocol === "deepseek_search_api" });
    start += size + 2;
  }
  const warnings = searchWarningsText(executions);
  const shares = fairShares(blocks.map((block) => block.size), budget - (warnings ? warnings.length + 2 : 0));
  const rendered = blocks.map((block, index) => block.size <= shares[index]!
    ? { shown: block.size, text: text.slice(block.start, block.start + block.size) }
    : fairShareBlock(block, shares[index]!));
  return {
    shown: rendered.reduce((sum, block) => sum + block.shown, 0) + warnings.length,
    text: [...rendered.map((block) => block.text), ...warnings ? [warnings] : []].join("\n\n")
  };
}
