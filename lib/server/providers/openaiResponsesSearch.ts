import { admittedOutputAllowance } from "./modelOutputAllowance";
import { dispatchSearchRequest } from "./searchDispatch";
import { safeExternalHref } from "../../domain/links";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { withoutOpenAiAttribution, withoutOpenAiAttributionInText } from "../../domain/searchAttribution";
import { searchSourceFallbackTitle } from "../../domain/searchSources";
import {
  OPENAI_RESPONSES_REASONING_REQUEST_MAPPING,
  type ProviderReasoningRequestMapping
} from "../../contracts/providerReasoningRequestMapping";
import {
  applyProviderReasoningRequestMapping,
  isCanonicalResponsesReasoningRequestMapping
} from "./reasoningRequestMapping";
import {
  extractOpenAIUsage,
  normalizeCompletedOpenAIResponse,
  openAIResponseStatus
} from "./openaiResponsesResponse";
import type { OpenAIResponsesClient } from "./openaiResponsesTransport";
import {
  normalizeSearchFindings,
  normalizeSearchSources,
  searchSourcesFromCitationArtifacts
} from "../search/evidence";
import { SEARCH_RESULT_LIST_FINDINGS } from "../search/toolResult";
import {
  ProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchAdapter,
  type ProviderSearchRequest,
  type ProviderSearchResult
} from "./types";

export const OPENAI_RESPONSES_SEARCH_MIN_OUTPUT_TOKENS = 16;
export const OPENAI_RESPONSES_SEARCH_MAX_OUTPUT_TOKENS = Number.MAX_SAFE_INTEGER;

/*
 * The client engine's speed and shape knobs, measured with the eval
 * (`scripts/eval/web-search-quality.ts`, engine `openai-client`). Reasoning
 * effort is the lowest one the technical model advertises for search
 * (`lowestSupportedOpenAIResponsesSearchEffort`).
 */
/** How much page context the hosted `web_search` tool gathers per search; null sends the provider's default. */
export const OPENAI_SEARCH_CONTEXT_SIZE: "low" | "medium" | "high" | null = "low";
/** The most entries, one per source, the technical model is asked to write. */
export const OPENAI_SEARCH_MAX_ENTRIES = 10;
/**
 * OpenAI returns no page text to the caller, so each source's passage comes
 * from the technical model: one line per source it relied on, tied to that
 * source by the citation in the line. The line's fields become the source's
 * snippet and date; its URL and title come only from the citation.
 */
export const OPENAI_SEARCH_INSTRUCTIONS = [
  "Search the web for the query. Work from the search result list; open a page only when the list lacks the fact the query asks for.",
  `Then write one line per source you relied on, most relevant first, at most ${OPENAI_SEARCH_MAX_ENTRIES} lines, each in this form:`,
  "Claim: <what this source says about the query> | Passage: \"<a short passage quoted exactly from the source>\" | Date: <the page's publication date as YYYY-MM-DD>",
  "Leave out Passage or Date when you do not have it. Cite the source within its line. Write nothing else."
].join("\n");

// GPT-5 accepts "minimal" for answers but cannot use web_search at that level.
// Choose the next advertised Search-compatible effort, or omit the override.
const effortOrder = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const operationLimit = 32;
const operationStringLimit = 512;
const operationUrlLimit = 2_048;

type OpenAIResponsesSearchProvider = "openai" | "openai_compatible";

export type OpenAIResponsesSearchRequestBody = Readonly<{
  background: false;
  include: readonly ["web_search_call.action.sources"];
  input: readonly [{
    content: readonly [{ text: string; type: "input_text" }];
    role: "user";
  }];
  instructions: string;
  max_output_tokens: number;
  model: string;
  reasoning?: Readonly<{ effort: string }>;
  store: false;
  stream: false;
  tool_choice: "required";
  tools: readonly [OpenAIResponsesWebSearchTool];
}>;

type OpenAIResponsesWebSearchTool = Readonly<{
  search_context_size?: NonNullable<typeof OPENAI_SEARCH_CONTEXT_SIZE>;
  type: "web_search";
}>;

export type OpenAIResponsesSearchAdapterOptions = Readonly<{
  client: OpenAIResponsesClient;
  provider: OpenAIResponsesSearchProvider;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function safeOperationHttpHref(value: unknown): string | undefined {
  const href = safeExternalHref(value);
  if (!href || href.length > operationUrlLimit) return undefined;
  try {
    const url = new URL(href);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedProviderLabel(provider: OpenAIResponsesSearchProvider): string {
  return provider === "openai" ? "openai" : "openai-compatible";
}

function openAISearchPolicy(request: ProviderSearchRequest) {
  const policy = request.searchPolicy;
  if (
    (policy.provider !== "openai" && policy.provider !== "openai_compatible") ||
    policy.strategyId !== "openai-responses-web-search" ||
    !boundedString(policy.modelId, 256) ||
    !boundedString(request.strategyId, 512) ||
    !Number.isSafeInteger(policy.maxOutputTokens) ||
    policy.maxOutputTokens < OPENAI_RESPONSES_SEARCH_MIN_OUTPUT_TOKENS ||
    policy.maxOutputTokens > OPENAI_RESPONSES_SEARCH_MAX_OUTPUT_TOKENS ||
    (policy.reasoningPolicy !== "lowest_supported" &&
      policy.reasoningPolicy !== "provider_default")
  ) {
    throw new Error("openai_search_policy_invalid");
  }
  return policy;
}

export function lowestSupportedOpenAIResponsesSearchEffort(
  capabilities: ProviderModelCapabilities
): string | undefined {
  if (!capabilities.reasoning) return undefined;
  const supported = new Set(
    Array.isArray(capabilities.reasoningEfforts)
      ? capabilities.reasoningEfforts.filter((value): value is string =>
          typeof value === "string" && value.trim().length > 0)
      : []
  );
  return effortOrder.find((effort) => supported.has(effort));
}

export function buildOpenAIResponsesSearchRequest(
  request: ProviderSearchRequest
): OpenAIResponsesSearchRequestBody {
  const policy = openAISearchPolicy(request);
  const effort = policy.reasoningPolicy === "lowest_supported"
    ? lowestSupportedOpenAIResponsesSearchEffort(policy.modelCapabilities)
    : undefined;
  const body: OpenAIResponsesSearchRequestBody = {
    background: false,
    include: ["web_search_call.action.sources"],
    input: [{
      content: [{ text: request.query, type: "input_text" }],
      role: "user"
    }],
    instructions: OPENAI_SEARCH_INSTRUCTIONS,
    max_output_tokens: policy.maxOutputTokens,
    model: policy.modelId.trim(),
    ...(effort ? { reasoning: { effort } } : {}),
    store: false,
    stream: false,
    tool_choice: "required",
    tools: [{
      ...(OPENAI_SEARCH_CONTEXT_SIZE ? { search_context_size: OPENAI_SEARCH_CONTEXT_SIZE } : {}),
      type: "web_search"
    }]
  };
  return request.generationBudget ? { ...body, max_output_tokens: admittedOutputAllowance(request.generationBudget, body) } : body;
}

function compatibleBody(
  body: OpenAIResponsesSearchRequestBody,
  mapping: ProviderReasoningRequestMapping
): Record<string, unknown> {
  const { background: _background, ...portable } = body;
  const output: Record<string, unknown> = { ...portable };
  if (body.reasoning && !isCanonicalResponsesReasoningRequestMapping(mapping)) {
    delete output.reasoning;
    applyProviderReasoningRequestMapping(output, mapping, {
      effort: body.reasoning.effort
    });
  }
  return output;
}

function requestBody(
  request: ProviderSearchRequest,
  options: OpenAIResponsesSearchAdapterOptions
): Record<string, unknown> {
  const policy = openAISearchPolicy(request);
  if (policy.provider !== options.provider) {
    throw new Error("openai_search_policy_invalid");
  }
  const body = buildOpenAIResponsesSearchRequest(request);
  return options.provider === "openai"
    ? { ...body }
    : compatibleBody(
        body,
        options.reasoningRequestMapping ?? OPENAI_RESPONSES_REASONING_REQUEST_MAPPING
      );
}

function safeAction(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type === "search" || value.type === "open_page" || value.type === "find_in_page"
    ? value.type
    : undefined;
  const query = boundedString(value.query, operationStringLimit);
  const pattern = boundedString(value.pattern, operationStringLimit);
  const url = safeOperationHttpHref(value.url);
  const queries = Array.isArray(value.queries)
    ? value.queries.flatMap((candidate) => {
        const normalized = boundedString(candidate, operationStringLimit);
        return normalized ? [normalized] : [];
      }).slice(0, 8)
    : [];
  const action = {
    ...(type ? { type } : {}),
    ...(query ? { query } : {}),
    ...(queries.length ? { queries } : {}),
    ...(pattern ? { pattern } : {}),
    ...(url ? { url } : {})
  };
  return Object.keys(action).length ? action : undefined;
}

function operationTruncationMarker(provider: OpenAIResponsesSearchProvider): ModelRunSseEvent {
  return {
    data: {
      artifactType: "search",
      payload: {
        outputIndex: Number.MAX_SAFE_INTEGER,
        provider: normalizedProviderLabel(provider),
        type: "web_search_call"
      }
    },
    type: "artifact"
  };
}

function safeSearchArtifacts(
  response: Readonly<Record<string, unknown>>,
  provider: OpenAIResponsesSearchProvider
): ModelRunSseEvent[] {
  const output = Array.isArray(response.output) ? response.output : [];
  const artifacts: ModelRunSseEvent[] = [];
  let truncated = false;
  for (const [outputIndex, item] of output.entries()) {
    if (!isRecord(item) || item.type !== "web_search_call") {
      continue;
    }
    if (artifacts.length >= operationLimit) {
      truncated = true;
      break;
    }
    const id = boundedString(item.id, 256);
    const status = boundedString(item.status, 64);
    const action = safeAction(item.action);
    artifacts.push({
      data: {
        artifactType: "search",
        payload: {
          ...(action ? { action } : {}),
          ...(id ? { id } : {}),
          outputIndex,
          provider: normalizedProviderLabel(provider),
          ...(status ? { status } : {}),
          type: "web_search_call"
        }
      },
      type: "artifact"
    });
  }
  if (truncated) artifacts.push(operationTruncationMarker(provider));
  return artifacts;
}

function safeActionSources(response: Readonly<Record<string, unknown>>) {
  const output = Array.isArray(response.output) ? response.output : [];
  return normalizeSearchSources(output.flatMap((item) =>
    isRecord(item) && item.type === "web_search_call" && isRecord(item.action) &&
      Array.isArray(item.action.sources)
      ? item.action.sources
      : []
  ));
}

/** The page a URL names for matching a cited source to a browsed one:
 * OpenAI adds attribution (`utm_source=openai`) to cited URLs only, so every
 * `utm_*` parameter is ignored. Any other difference is another page. */
function citedPageIdentity(value: string): string {
  try {
    const url = new URL(value);
    // Both sides are serialized alike, whether or not a parameter was removed.
    url.search = new URLSearchParams([...url.searchParams]
      .filter(([name]) => !name.toLowerCase().startsWith("utm_"))).toString();
    return url.toString();
  } catch {
    return value;
  }
}

/** The page a raw citation URL names, as `citedPageIdentity` keys it; undefined for an unsafe link. */
function citationPage(value: unknown): string | undefined {
  const href = safeExternalHref(value);
  return href ? citedPageIdentity(withoutOpenAiAttribution(href)) : undefined;
}

type TextSpan = Readonly<{ end: number; start: number }>;

function textIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A code point offset as a UTF-16 offset, undefined past the end. */
function utf16Offset(text: string, codePoints: number): number | undefined {
  let units = 0;
  let count = 0;
  for (const character of text) {
    if (count === codePoints) return units;
    units += character.length;
    count += 1;
  }
  return count === codePoints ? units : undefined;
}

/**
 * Where a citation sits in its text block. OpenAI counts offsets in code
 * points, which differ from UTF-16 only after an astral character, so the
 * reading whose span holds the cited link wins, code points first. A
 * citation without offsets is found by its link in the text, else nowhere.
 */
function citationSpan(text: string, annotation: Readonly<Record<string, unknown>>): TextSpan | undefined {
  const url = typeof annotation.url === "string" ? annotation.url : "";
  if (textIndex(annotation.start_index) && textIndex(annotation.end_index) &&
    annotation.start_index <= annotation.end_index) {
    const start = utf16Offset(text, annotation.start_index);
    const end = utf16Offset(text, annotation.end_index);
    const candidates = [
      ...start !== undefined && end !== undefined ? [{ end, start }] : [],
      ...annotation.end_index <= text.length ? [{ end: annotation.end_index, start: annotation.start_index }] : []
    ];
    return candidates.find((span) => url && text.slice(span.start, span.end).includes(url)) ?? candidates[0];
  }
  const at = url ? text.indexOf(url) : -1;
  return at < 0 ? undefined : markdownLinkSpan(text, at, at + url.length);
}

/** A link target's span widened to its whole Markdown link, `[label](url)`, and the parentheses around it. */
function markdownLinkSpan(text: string, start: number, end: number): TextSpan {
  const open = text.slice(start - 2, start) === "](" && text[end] === ")" ? text.lastIndexOf("[", start - 2) : -1;
  if (open < 0) return { end, start };
  return text[open - 1] === "(" && text[end + 1] === ")"
    ? { end: end + 2, start: open - 1 }
    : { end: end + 1, start: open };
}

const ENTRY_FIELD = /^(claim|passage|quote|date)\s*:\s*(.*)$/isu;
const QUOTE_MARKS = /^["'“”„«»‘’]+|["'“”„«»‘’]+$/gu;

/** An entry line's claim, quoted passage and date, from the line with its citations already removed. */
function entryFields(line: string): Readonly<{ date?: string; snippet?: string }> {
  const text = withoutOpenAiAttributionInText(line)
    // A link the model wrote is never a source: only its words stay.
    .replace(/\[([^\]]*)\]\(\s*https?:\/\/[^)\s]*\s*\)/giu, "$1")
    .replace(/\(\s*\)|\[\s*\]/gu, "")
    .replace(/\*\*|__/gu, "")
    .replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/u, "");
  const claim: string[] = [];
  let passage: string | undefined;
  let date: string | undefined;
  for (const segment of text.split("|").map((part) => part.trim()).filter(Boolean)) {
    const field = ENTRY_FIELD.exec(segment);
    const label = field?.[1]?.toLowerCase();
    const value = field?.[2]?.trim() ?? segment;
    if (label === "passage" || label === "quote") {
      passage = value.replace(QUOTE_MARKS, "").trim() || passage;
    } else if (label === "date") {
      const known = value.replace(/[.;,]+$/u, "").trim();
      if (known.length <= 40 && /\d/u.test(known)) date = known;
    } else if (value) {
      claim.push(value);
    }
  }
  const said = claim.join(" ").replace(/\s+/gu, " ").trim();
  const snippet = [said, passage ? `Quote: "${passage}"` : ""].filter(Boolean).join(" ");
  return { ...(date ? { date } : {}), ...(snippet ? { snippet } : {}) };
}

type EntryEvidence = Readonly<{ date?: string; snippets: readonly string[] }>;

type CitedEntries = Readonly<{
  /** Each cited page's entries by `citedPageIdentity`. */
  byPage: ReadonlyMap<string, EntryEvidence>;
  /** The lines of the model's text that no citation ties to a source. */
  uncited: string;
}>;

/**
 * The technical model's entries: each line of its text that carries a
 * citation is that cited page's entry; a citation alone on its line belongs
 * to the uncited line above it. Only the page identity of a citation is
 * used here; sources take their URL and title from the citation artifacts.
 */
function citedEntries(response: Readonly<Record<string, unknown>>): CitedEntries {
  const byPage = new Map<string, { date?: string; snippets: string[] }>();
  const uncited: string[] = [];
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!isRecord(block) || block.type !== "output_text" || typeof block.text !== "string") continue;
      const text = block.text;
      const lines: { cited: Set<string>; end: number; spans: TextSpan[]; start: number }[] = [];
      for (let start = 0; start <= text.length;) {
        const newline = text.indexOf("\n", start);
        const end = newline < 0 ? text.length : newline;
        lines.push({ cited: new Set(), end, spans: [], start });
        start = end + 1;
      }
      const annotations = Array.isArray(block.annotations) ? block.annotations : [];
      for (const annotation of annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation") continue;
        const page = citationPage(annotation.url);
        const span = citationSpan(text, annotation);
        const line = span && lines.find((candidate) => candidate.start <= span.start && span.start <= candidate.end);
        if (!page || !span || !line) continue;
        line.cited.add(page);
        line.spans.push({ end: Math.min(span.end, line.end), start: span.start });
      }
      const carried = new Set<number>();
      const entries = lines.map((line, index) => {
        if (line.cited.size === 0) return null;
        let body = text.slice(line.start, line.end);
        for (const span of [...line.spans].sort((left, right) => right.start - left.start)) {
          body = `${body.slice(0, span.start - line.start)}${body.slice(span.end - line.start)}`;
        }
        let fields = entryFields(body);
        if (!fields.snippet) {
          // A citation alone on its line cites the nearest uncited line above it.
          let above = index - 1;
          while (above >= 0 && !/[\p{L}\p{N}]/u.test(text.slice(lines[above]!.start, lines[above]!.end))) above -= 1;
          if (above >= 0 && lines[above]!.cited.size === 0 && !carried.has(above)) {
            carried.add(above);
            fields = { ...entryFields(text.slice(lines[above]!.start, lines[above]!.end)), ...fields.date ? { date: fields.date } : {} };
          }
        }
        return { cited: line.cited, fields };
      });
      for (const [index, line] of lines.entries()) {
        const entry = entries[index];
        if (!entry) {
          const body = text.slice(line.start, line.end).trim();
          if (!carried.has(index) && /[\p{L}\p{N}]/u.test(body)) uncited.push(body);
          continue;
        }
        for (const page of entry.cited) {
          const evidence = byPage.get(page) ?? { snippets: [] };
          if (entry.fields.snippet && !evidence.snippets.includes(entry.fields.snippet)) {
            evidence.snippets.push(entry.fields.snippet);
          }
          if (!evidence.date && entry.fields.date) evidence.date = entry.fields.date;
          byPage.set(page, evidence);
        }
      }
    }
  }
  return { byPage, uncited: uncited.join("\n").trim() };
}

function refusedWithoutText(response: Readonly<Record<string, unknown>>): boolean {
  const output = Array.isArray(response.output) ? response.output : [];
  const blocks = output.flatMap((item) =>
    isRecord(item) && item.type === "message" && Array.isArray(item.content) ? item.content : []);
  return blocks.some((block) => isRecord(block) && block.type === "refusal") &&
    !blocks.some((block) => isRecord(block) && block.type === "output_text" &&
      typeof block.text === "string" && block.text.trim());
}

function completedSearchOperationCount(response: Readonly<Record<string, unknown>>): number {
  const output = Array.isArray(response.output) ? response.output : [];
  return output.filter((item) =>
    isRecord(item) && item.type === "web_search_call" && item.status === "completed"
  ).length;
}

function incompleteReason(response: Readonly<Record<string, unknown>>): string | undefined {
  if (openAIResponseStatus(response) !== "incomplete" || !isRecord(response.incomplete_details)) {
    return undefined;
  }
  const reason = response.incomplete_details.reason;
  return reason === "max_output_tokens" || reason === "content_filter" ? reason : undefined;
}

function responseId(response: Readonly<Record<string, unknown>>): string | undefined {
  return boundedString(response.id, 256);
}

function failureCode(status: string): string {
  return status === "incomplete" || status === "failed" || status === "cancelled"
    ? `openai_response_${status}`
    : "openai_response_not_completed";
}

export function createOpenAIResponsesSearchAdapter(
  options: OpenAIResponsesSearchAdapterOptions
): ProviderSearchAdapter {
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview(request) {
      const canonicalBody = buildOpenAIResponsesSearchRequest(request);
      const body = requestBody(request, options);
      return {
        body: {
          ...(typeof body.background === "boolean" ? { background: body.background } : {}),
          max_output_tokens: body.max_output_tokens,
          model: body.model,
          reasoning: canonicalBody.reasoning,
          store: body.store,
          stream: body.stream,
          tool: "web_search"
        },
        provider: normalizedProviderLabel(options.provider),
        queryCharacters: request.query.length,
        redactions: ["search_query"],
        stage: "tool_search"
      };
    },
    async search(request, searchOptions = {}): Promise<ProviderSearchResult> {
      const body = requestBody(request, options);
      const response = await dispatchSearchRequest(searchOptions, {
        body, execute: () => options.client.create(body, {
          signal: searchOptions.signal,
          ...(typeof searchOptions.timeoutMs === "number"
            ? { timeoutMs: searchOptions.timeoutMs }
            : {})
        }), usage: extractOpenAIUsage
      });
      const status = openAIResponseStatus(response);
      if (status !== "completed") {
        const reason = incompleteReason(response);
        throw new ProviderSearchExecutionError({
          artifacts: safeSearchArtifacts(response, options.provider),
          code: failureCode(status),
          ...(status === "unknown" ? {} : { providerStatus: status }),
          ...(reason ? { reason } : {}),
          usage: extractOpenAIUsage(response)
        });
      }

      const providerResponseId = responseId(response);
      const completed = normalizeCompletedOpenAIResponse(
        response,
        providerResponseId,
        normalizedProviderLabel(options.provider)
      );
      const operationArtifacts = safeSearchArtifacts(response, options.provider);
      const artifacts = [
        ...operationArtifacts,
        ...completed.events.filter((event) =>
          event.type === "artifact" && event.data.artifactType !== "search"
        )
      ];
      if (refusedWithoutText(response)) {
        // A refusal with or without a search before it; its words stay out of the error.
        throw new ProviderSearchExecutionError({
          artifacts: operationArtifacts,
          code: "openai_search_refused",
          providerStatus: status,
          usage: completed.result.usage
        });
      }
      const searchOperationCount = completedSearchOperationCount(response);
      if (searchOperationCount === 0) {
        throw new ProviderSearchExecutionError({
          artifacts: operationArtifacts,
          code: "openai_search_operation_missing",
          providerStatus: status,
          usage: completed.result.usage
        });
      }
      const entries = citedEntries(response);
      // Entries alone carry everything the model wrote when every line cites
      // a source; lines no citation ties to a source stay above the entries;
      // a text without any tied line is the findings as written.
      let findings: string;
      try {
        findings = normalizeSearchFindings(entries.byPage.size === 0
          ? completed.result.finalText
          : entries.uncited || SEARCH_RESULT_LIST_FINDINGS);
      } catch {
        throw new ProviderSearchExecutionError({
          artifacts: operationArtifacts,
          code: "openai_search_findings_invalid",
          usage: completed.result.usage
        });
      }
      // Cited sources come first so no bound can drop what the findings cite.
      // A cited source takes its URL and title from the citation (the URL of
      // the browsed page when the engine also browsed it, so the browsed
      // duplicate is dropped by URL) and its snippet and date from its entry.
      const browsed = safeActionSources(response);
      const sources = normalizeSearchSources([
        ...searchSourcesFromCitationArtifacts(artifacts).map((source) => {
          const page = citedPageIdentity(source.url);
          const same = browsed.find((candidate) => citedPageIdentity(candidate.url) === page);
          const entry = entries.byPage.get(page);
          const snippet = entry?.snippets.join(" … ") || same?.snippet;
          const date = entry?.date ?? same?.date;
          return {
            citation: source.citation,
            ...(date ? { date } : {}),
            ...(snippet ? { snippet } : {}),
            // A citation without a title has its host as one; the browsed page may know better.
            title: same && source.title === searchSourceFallbackTitle(source.url) ? same.title : source.title,
            url: same?.url ?? source.url
          };
        }),
        ...browsed
      ]);
      if (sources.length === 0) {
        throw new ProviderSearchExecutionError({
          artifacts: operationArtifacts,
          code: "openai_search_sources_invalid",
          providerStatus: status,
          usage: completed.result.usage
        });
      }
      return {
        artifacts,
        finalProviderResponsePreview: {
          findingsCharacters: findings.length,
          provider: normalizedProviderLabel(options.provider),
          searchOperationCount,
          sourceCount: sources.length,
          status,
          usage: completed.result.usage
        },
        findings,
        ...(providerResponseId ? { providerResponseId } : {}),
        requestPreview: adapter.buildRequestPreview(request),
        sourceAttribution: "available",
        sources,
        usage: completed.result.usage
      };
    }
  };
  return adapter;
}
