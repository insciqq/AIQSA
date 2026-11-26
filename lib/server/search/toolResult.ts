import { decodeTokenUsage, reportedCostMicros } from "../../domain/usage";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { mergeSearchEvidence, searchProtocolReportsNoResults } from "../../domain/search";
import { takeUtf16SafePrefix } from "../../domain/utf16";
import type { ToolExecutionResult } from "../tools/types";
import {
  MAX_SEARCH_FINDINGS_CHARACTERS,
  normalizeSearchFindings,
  normalizeSearchSources,
  SEARCH_NO_RESULTS_FINDINGS,
  type SearchSource
} from "./evidence";

/** Version 4 renders each source as a self-contained entry (number, title,
 * site, date, URL and a bounded excerpt) from the stored source fields, so a
 * cut of the text never separates a URL from its result. Version 3 numbers
 * each engine's sources beside its findings with the engine's own citation
 * numbers; version 2 lists one merged source list after all findings. Results
 * saved in versions 2 and 3 still decode and render exactly as saved. */
export const SEARCH_TOOL_RESULT_VERSION = 4;
export const CITED_SEARCH_TOOL_RESULT_VERSION = 3;
export const LEGACY_SEARCH_TOOL_RESULT_VERSION = 2;
export type SearchToolResultVersion =
  | typeof LEGACY_SEARCH_TOOL_RESULT_VERSION
  | typeof CITED_SEARCH_TOOL_RESULT_VERSION
  | typeof SEARCH_TOOL_RESULT_VERSION;

/**
 * The findings of an engine whose answer is its list of results (a raw
 * results API such as the DeepSeek Search API), in these server-owned words.
 * Version 4 shows such an engine as its entries alone: the excerpts are in
 * its sources, so an adapter of any results engine only fills sources.
 */
export const SEARCH_RESULT_LIST_FINDINGS = "The search returned the results listed with their excerpts.";

/** The most characters of a source's excerpt one entry shows, so about ten
 * entries fit a tool result the model reads whole (`lib/server/engine/toolResults.ts`). */
export const SEARCH_ENTRY_EXCERPT_CHARACTERS = 1_500;

function searchResultVersion(result: ToolExecutionResult): SearchToolResultVersion | null {
  const version = result.rawPreview?.searchResultVersion;
  return version === SEARCH_TOOL_RESULT_VERSION || version === CITED_SEARCH_TOOL_RESULT_VERSION ||
    version === LEGACY_SEARCH_TOOL_RESULT_VERSION
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
    // DeepSeek's hosted Search, retired 2026-10-24, returned findings without
    // source links. Its stored results keep decoding, so the transcripts of
    // the answers that used it still rehydrate; nothing writes them any more.
    const providerSourcesUnavailable =
      sourceAttribution === "provider_unavailable" &&
      value.provider === "deepseek" &&
      value.protocol === "deepseek_responses_web_search";
    // A raw results API's empty answer carries only the server's own words.
    const explicitNoResults = sources.length === 0 &&
      sourceAttribution !== "provider_unavailable" &&
      searchProtocolReportsNoResults(value.protocol, value.provider) &&
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

/** One engine's sources with their numbers. A cited source keeps the number
 * its findings use; the others follow the highest such number, so an engine
 * without citation numbers is numbered by position. */
function numberedSources(engine: RenderedEngine): Readonly<{ number: number; source: SearchSource }>[] {
  let next = engine.sources.reduce((highest, source) => Math.max(highest, source.citation ?? 0), 0);
  return engine.sources.map((source) => ({ number: source.citation ?? ++next, source }));
}

/** Version 3's numbered sources of one engine, "" without sources. */
function engineSourcesText(engine: RenderedEngine): string {
  return engine.sources.length
    ? `Sources for ${JSON.stringify(engine.displayName)}:\n${numberedSources(engine).map(({ number, source }) =>
        `[${number}] ${source.title} — ${source.url}`).join("\n")}`
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

/** Web text on one line: an entry's own lines stay the server's. */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** The host a URL names, without `www.`. */
function siteOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./u, "") || null;
  } catch {
    return null;
  }
}

/** An ISO date-time as its date; any other date as the source gave it. */
function dateOf(value: string): string {
  const date = oneLine(value);
  return /^\d{4}-\d{2}-\d{2}T/u.test(date) ? date.slice(0, 10) : date;
}

/** A snippet within the entry bound, cut at a word where one is near. */
function excerptOf(snippet: string): string {
  const text = oneLine(snippet);
  if (text.length <= SEARCH_ENTRY_EXCERPT_CHARACTERS) return text;
  const prefix = takeUtf16SafePrefix(text, SEARCH_ENTRY_EXCERPT_CHARACTERS - 1);
  const space = prefix.lastIndexOf(" ");
  return `${(space >= SEARCH_ENTRY_EXCERPT_CHARACTERS / 2 ? prefix.slice(0, space) : prefix).trimEnd()}…`;
}

/** One self-contained entry: `[n] title — site, date`, the URL on its own line, then the excerpt when known. */
function entryText(number: number, source: SearchSource): string {
  const title = oneLine(source.title);
  const site = siteOf(source.url);
  const facts = [site !== title ? site : null, source.date ? dateOf(source.date) : null].filter(Boolean).join(", ");
  const excerpt = source.snippet ? excerptOf(source.snippet) : "";
  return [`[${number}] ${title}${facts ? ` — ${facts}` : ""}`, source.url, ...excerpt ? [excerpt] : []].join("\n");
}

type EntryLayout = Readonly<{ end: number; number: number; start: number }>;

/** Where one engine's parts sit in a version 4 text, by absolute offset. */
type EngineLayout = Readonly<{
  displayName: string;
  entries: readonly EntryLayout[];
  /** Findings shown before the entries; null for a result list. */
  findings: string | null;
  findingsStart: number;
  header: string;
  size: number;
  start: number;
}>;

type ResultLayout = Readonly<{ blocks: readonly EngineLayout[]; text: string; warnings: string }>;

/**
 * Version 4: each successful engine's findings, unless it is a result list
 * (`SEARCH_RESULT_LIST_FINDINGS`), then its sources as numbered entries
 * separated by blank lines, and the warnings line last. Findings are never
 * rewritten; entries carry only the stored source fields.
 */
function resultLayout(executions: readonly SearchExecutionEvidence[]): ResultLayout {
  const blocks: EngineLayout[] = [];
  let text = "";
  for (const engine of executions) {
    if (engine.status !== "complete" || !engine.findings) continue;
    if (text) text += "\n\n";
    const start = text.length;
    const header = findingsHeader(engine);
    const numbered = numberedSources(engine);
    const findings = engine.findings === SEARCH_RESULT_LIST_FINDINGS && numbered.length > 0 ? null : engine.findings;
    text += header;
    const findingsStart = text.length;
    if (findings !== null) text += findings;
    if (numbered.length > 0 && findings !== null) text += `\n\nSources for ${JSON.stringify(engine.displayName)}:\n`;
    const entries: EntryLayout[] = [];
    for (const [index, { number, source }] of numbered.entries()) {
      if (index > 0) text += "\n\n";
      const entryStart = text.length;
      text += entryText(number, source);
      entries.push({ end: text.length, number, start: entryStart });
    }
    blocks.push({ displayName: engine.displayName, entries, findings, findingsStart, header, size: text.length - start, start });
  }
  const warnings = searchWarningsText(executions);
  if (warnings) text += `${text ? "\n\n" : ""}${warnings}`;
  return { blocks, text: text || "Every selected search engine failed.", warnings };
}

export function searchToolResultText(
  executions: readonly SearchExecutionEvidence[],
  version: SearchToolResultVersion = SEARCH_TOOL_RESULT_VERSION
): string {
  if (version === SEARCH_TOOL_RESULT_VERSION) return resultLayout(executions).text;
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


/** How many of an engine's first entries a fair share keeps besides those its shown findings cite. */
export const SEARCH_FAIR_SHARE_FIRST_SOURCES = 3;

/** A citation in findings: `[3]` or `[3, 5]`. */
const CITATION = /\[(\d{1,4}(?:\s*,\s*\d{1,4})*)\]/gu;

function citedNumbers(text: string): Set<number> {
  const cited = new Set<number>();
  for (const match of text.matchAll(CITATION)) {
    for (const value of match[1]!.split(",")) cited.add(Number(value.trim()));
  }
  return cited;
}

/** The beginning of findings within `room`, cut at a paragraph, line or word end. */
function findingsPrefix(findings: string, room: number): string {
  if (findings.length <= room) return findings;
  if (room <= 0) return "";
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

/** Entry numbers as ranges, such as `1-7, 9`. */
function numberRanges(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((left, right) => left - right);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end += 1;
    ranges.push(end === index ? `${sorted[index]}` : `${sorted[index]}-${sorted[end]}`);
    index = end + 1;
  }
  return ranges.join(", ");
}

/**
 * One engine block within `room`: the beginning of its findings, then whole entries (the first few, those the shown findings cite,
 * then the next ones in order while they fit), and a note for each part it cut naming the offset of the saved text where it starts.
 */
function fairShareBlock(block: EngineLayout, room: number, text: string): Readonly<{ shown: number; text: string }> {
  const name = JSON.stringify(block.displayName);
  const heading = `Sources for ${name}:\n`;
  // After findings, the first entry carries the blank line and the heading; every later one its blank line.
  const headingCost = block.findings === null ? 0 : 2 + heading.length;
  const entryCost = (entry: EntryLayout, first: boolean) => entry.end - entry.start + (first ? headingCost : 2);
  const findings = block.findings ?? "";
  const firstCost = block.entries.slice(0, SEARCH_FAIR_SHARE_FIRST_SOURCES)
    .reduce((sum, entry, index) => sum + entryCost(entry, index === 0), 0);
  const kept = findingsPrefix(findings, room - block.header.length - firstCost);
  const cited = citedNumbers(kept);
  let left = room - block.header.length - kept.length;
  const chosen = new Set<number>();
  const add = (index: number): boolean => {
    const cost = entryCost(block.entries[index]!, chosen.size === 0);
    if (cost > left) return false;
    chosen.add(index);
    left -= cost;
    return true;
  };
  for (const [index, entry] of block.entries.entries()) {
    if (index < SEARCH_FAIR_SHARE_FIRST_SOURCES || cited.has(entry.number)) add(index);
  }
  for (let index = 0; index < block.entries.length; index += 1) {
    if (!chosen.has(index) && !add(index)) break;
  }
  const shown = block.entries.filter((_, index) => chosen.has(index));
  const firstLeftOut = block.entries.find((_, index) => !chosen.has(index));
  let output = `${block.header}${kept}`;
  if (kept.length < findings.length) {
    output += `${kept ? "\n" : ""}[Search source ${name}: findings cut here, ${kept.length} of ${findings.length} characters shown; ` +
      `the rest starts at offset ${block.findingsStart + kept.length} of the saved result.]`;
  }
  const list = [
    ...shown.length > 0 ? [`${block.findings === null ? "" : heading}${shown.map((entry) => text.slice(entry.start, entry.end)).join("\n\n")}`] : [],
    ...firstLeftOut
      ? [`[${block.findings === null ? `Search source ${name}` : `Sources for ${name}`}: ${shown.length} of ${block.entries.length} results ` +
        `shown${shown.length > 0 ? ` (${numberRanges(shown.map((entry) => entry.number))})` : ""}; the first one left out, ` +
        `result ${firstLeftOut.number}, starts at offset ${firstLeftOut.start} of the saved result.]`]
      : []
  ].join("\n\n");
  if (list) output += block.findings === null ? list : `\n\n${list}`;
  return { shown: room - left, text: output };
}

/**
 * The model's view of a search result too long to show whole (`lib/server/engine/toolResults.ts`): each engine block gets a fair
 * share of `budget`, so no engine is lost in an omitted middle (acceptance run 2026-11-02: of three selected engines the model saw one
 * and a half). A block keeps its header, the beginning of its findings and whole entries, so a URL never leaves its result, and says
 * what it left out and at which offset of the saved text the rest starts. Every kept part is the saved text verbatim, so a quote from
 * one checks against the saved copy. Null unless the result is a current-version search result with an engine block whose text is
 * exactly `text`; the caller then cuts it as any other result.
 */
export function searchToolResultFairShare(
  result: ToolExecutionResult,
  text: string,
  budget: number
): Readonly<{ shown: number; text: string }> | null {
  const layout = currentLayout(result, text);
  if (!layout || layout.blocks.length === 0) return null;
  const warnings = layout.warnings;
  const shares = fairShares(layout.blocks.map((block) => block.size), budget - (warnings ? warnings.length + 2 : 0));
  const rendered = layout.blocks.map((block, index) => block.size <= shares[index]!
    ? { shown: block.size, text: text.slice(block.start, block.start + block.size) }
    : fairShareBlock(block, shares[index]!, text));
  return {
    shown: rendered.reduce((sum, block) => sum + block.shown, 0) + warnings.length,
    text: [...rendered.map((block) => block.text), ...warnings ? [warnings] : []].join("\n\n")
  };
}

/** The layout of a current-version search result whose text is exactly `text`, else null. */
function currentLayout(result: ToolExecutionResult, text: string): ResultLayout | null {
  if (searchResultVersion(result) !== SEARCH_TOOL_RESULT_VERSION) return null;
  const executions = canonicalExecutions(result);
  if (!executions) return null;
  const layout = resultLayout(executions);
  return layout.text === text ? layout : null;
}

/**
 * Where each entry of a current-version search result sits in `text`, as `[start, end)`: a cut of the text that must not separate a
 * URL from its result moves out of these spans. Null unless `text` is exactly the result's own text.
 */
export function searchToolResultEntrySpans(
  result: ToolExecutionResult,
  text: string
): readonly (readonly [number, number])[] | null {
  return currentLayout(result, text)?.blocks.flatMap((block) => block.entries.map((entry) => [entry.start, entry.end] as const)) ?? null;
}
