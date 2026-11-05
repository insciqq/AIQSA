import {
  CHANGE_RESEARCH_FRAME_TOOL_NAME,
  PROPOSE_RESEARCH_PLAN_TOOL_NAME,
  RECORD_EVIDENCE_TOOL_NAME,
  START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME
} from "../../contracts/research";
import { ASK_PARENT_TOOL_NAME, CALL_SUBAGENT_TOOL_NAME, LIST_AGENTS_TOOL_NAME, SEND_AGENT_MESSAGE_TOOL_NAME, STOP_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import { HARNESS_SEARCH_TOOL } from "../engine/prompts/harness";
import { READ_TOOL_RESULT_NAME, toolResultOutputText, type SavedToolResultReader } from "../engine/toolResults";
import type { TranscriptItem } from "../engine/transcript";
import { parsePersistedToolExecutionResult } from "../runs/toolExecutionPersistence";
import type { ToolLoopJsonValue } from "../runs/toolLoopPersistence";
import { FETCH_URL_TOOL_NAME } from "../tools/fetchUrlPlan";
import { READ_SECRET_TOOL_NAME } from "../tools/readSecret";
import type { ToolExecutionResult } from "../tools/types";
import { UPDATE_PLAN_TOOL_NAME } from "../tools/updatePlan";
import { normalizeFetchUrl, withoutFetchUrlAttribution } from "../webFetch/urls";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import type { ResearchOpenedSource } from "./gates";
import { researchSiteHost } from "./sourceQuality";

/**
 * The text agents of a research really got from outside, across its runs: the
 * main agent's tool results and those of its sub-agents' threads, foreground and
 * background, whole where a saved copy can be read. What agents wrote themselves is no
 * evidence, so a report's or a brief's words never count as opened text.
 */
const AGENT_WRITTEN: ReadonlySet<string> = new Set([ASK_PARENT_TOOL_NAME, CALL_SUBAGENT_TOOL_NAME, CHANGE_RESEARCH_FRAME_TOOL_NAME, LIST_AGENTS_TOOL_NAME,
  PROPOSE_RESEARCH_PLAN_TOOL_NAME, READ_SECRET_TOOL_NAME, READ_TOOL_RESULT_NAME, RECORD_EVIDENCE_TOOL_NAME, SEND_AGENT_MESSAGE_TOOL_NAME, START_RESEARCH_TOOL_NAME,
  STOP_SUBAGENT_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME, UPDATE_PLAN_TOOL_NAME]);

/** Bounds one read: a run's opened text is checked in memory. */
export const RESEARCH_SOURCE_LIMITS = Object.freeze({ results: 2_000, totalCharacters: 16_000_000 });

/**
 * Bounds what one write reads of its writer's own results, because reading a whole run at every write would be quadratic in the run.
 * `fetchCalls` are the calls a cited link is looked for among and `citedResults` what is read of it per link; `recentResults` and
 * `characters` are what a quote with no page of its own is looked for in, newest first. An agent records as it goes, so its page is there.
 */
export const RESEARCH_WRITE_SOURCE_LIMITS = Object.freeze({ browserCalls: 200, characters: 3_000_000, citedResults: 4, fetchCalls: 500, recentResults: 48 });

/** The Workspace tools that run a command or read its output, and so may show the browser at work. */
const COMMAND_TOOLS: readonly string[] = (["sandbox_exec", "sandbox_exec_poll", "sandbox_exec_start", "sandbox_shell"] as const).map(namespacedWorkspaceToolName);

/** A managed-browser step line at a line's start, any action (`ops/workspace-guest/python/aiqsa/browser/_format.py`): `[browser #3] click: … @ shop.example/cart`. */
const BROWSER_STEP_HOST = /^\[browser #\d+[^\]\n]*\][^\n]* @ ([^\s/"]+)/gmu;

/**
 * A navigation a command names with its link (`ops/workspace-guest/python/aiqsa/browser/cli.py`): `aiqsa-browser open` or `new-tab`
 * and a link after it on that line, past any flags, or the Python helper's `.open("…")` or `.new_tab("…")`. `proxied` and `proxies`
 * open no page, so they never match.
 */
const COMMAND_NAVIGATION = /aiqsa-browser\s+(?:open|new-tab)\b[^\n]*?(https?:\/\/[^\s'"\\;&|)]+)|\.(?:open|new_tab)\(\s*(?:url\s*=\s*)?['"](https?:\/\/[^'"\s\\]+)/gu;

const stringsOf = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf)
  : isObject(value) ? Object.values(value).flatMap(stringsOf) : [];

/** What a command printed: a Workspace result is JSON whose `stdout` holds the step lines, so each of its strings is read on its own lines. */
function printedText(text: string): string {
  try {
    return stringsOf(JSON.parse(text)).join("\n");
  } catch {
    return text;
  }
}

/**
 * The hosts one command call shows the browser tried: the step lines its output carries, whatever ran them (a CLI call, a script
 * file, `bash -lc`, a redirect), and the links its own navigation names, which a refused open leaves as its only trace. Its
 * arguments are read as one text, so a shell line, a program's argument list and inline code all count alike.
 *
 * Accepted risk (integrator decision 2026-11-05): text that only prints a step line or a navigation command (`echo`, a heredoc, a quoted
 * string) counts too. The agent is cooperative, and the worst a wrong match does is let a site close without a real attempt, which is
 * how closing worked before 2026-11-05; reading too little would refuse a researcher's record for good.
 */
function attemptedHosts(call: ResearchAgentCall): readonly string[] {
  // The program first and its arguments after it, as they run: `{ args, command }` would read backwards.
  const asRun = isObject(call.arguments) ? { command: call.arguments.command, args: call.arguments.args, ...call.arguments } : call.arguments;
  const named = [...stringsOf(asRun).join(" ").matchAll(COMMAND_NAVIGATION)].map((match) => match[1] ?? match[2]!);
  const result = parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName }, call.result as ToolLoopJsonValue);
  const shown = result ? [...printedText(toolResultOutputText(result)).matchAll(BROWSER_STEP_HOST)].map((match) => match[1]!) : [];
  return [...named, ...shown].flatMap((site) => researchSiteHost(site) ?? []);
}

/** A command that drives the Workspace browser: the same reading as `drivesBrowser` in `lib/server/engine/toolRegistry.ts`. Reads such as its `text` print no step line. */
const BROWSER_COMMAND = /aiqsa-browser|from\s+aiqsa\s+import\s+browser|aiqsa\.browser/u;

/** A browser action's step line (`ops/workspace-guest/python/aiqsa/browser/_format.py`), at a line's start in a result stringified or not. */
const BROWSER_STEP_START = /(?:^|"|\\n)\[browser #\d/mu;

/**
 * What a stored result proves. `page`: `fetch_url`, or what a browser command printed. `search`: results a page was found
 * by, not opened. `other`: any other command, file read or MCP result, which holds what anyone put there, so it can only
 * say a page could not be checked. `agent_written`: no evidence at all. The quote check and the gap check both read this.
 */
export type ResearchEvidenceKind = "agent_written" | "other" | "page" | "search";

export function researchEvidenceKind(source: Pick<ResearchOpenedSource, "browser" | "text" | "toolName">): ResearchEvidenceKind {
  if (source.toolName === FETCH_URL_TOOL_NAME) return "page";
  if (HARNESS_SEARCH_TOOL.test(source.toolName)) return "search";
  if (AGENT_WRITTEN.has(source.toolName)) return "agent_written";
  return source.browser === true || BROWSER_STEP_START.test(source.text) ? "page" : "other";
}

/**
 * An excerpt whose whole text could not be saved names itself (`toolOutputExcerpt`, `lib/server/engine/toolResults.ts`), with no
 * handle to read the rest by. A page that quotes this wording earns at most "not checked".
 */
const UNSAVED_EXCERPT = /\[\d+ of \d+ characters omitted here \(characters \d+-\d+\)\. The whole result could not be saved /u;

/** Any excerpt (`toolOutputExcerpt`): a call's row keeps one only for a result too long for the row, whose whole text is its saved copy. */
const EXCERPT = /\[\d+ of \d+ characters omitted here \(characters \d+-\d+\)\. The whole result /u;

function pageUrl(call: TranscriptItem | undefined): string | null {
  if (call?.kind !== "tool_call" || call.name !== FETCH_URL_TOOL_NAME) return null;
  try {
    const parsed = JSON.parse(call.arguments) as { url?: unknown };
    return typeof parsed.url === "string" ? parsed.url : null;
  } catch {
    return null;
  }
}

/** Which run a research is, among the branch's. */
export type ResearchRunPlace = Readonly<{ branchRunIds: readonly string[]; researchRunId: string; runId: string }>;

/**
 * The runs one research ran in, oldest first. An approval continuation is a new run, and what the runs before it read stays under them,
 * a foreground researcher's items under its parent run, so a check of its report and a write of its record look there too. An ordinary
 * run is its own alone, and an earlier answer on the branch is no part of it.
 */
export function researchRunsOnBranch(run: ResearchRunPlace): readonly string[] {
  const from = run.branchRunIds.indexOf(run.researchRunId);
  return [...new Set([...from < 0 ? [] : run.branchRunIds.slice(from), run.runId])];
}

/**
 * A gate's own turn, by the name `researchTurnName` gives it. What a check read is no research: it opens no new round of the gap check, and it does not make a page one a
 * researcher read. A researcher a model happens to name this way goes uncounted too, which only makes the checks stricter, and such a name already meets a gate's thread.
 */
const GATE_TURN = /^(?:gap-judge|skeptic|verifier(?:-\d+)?)-\d+$/u;

/**
 * The addresses a page read answers to by what the agent asked: that link, and the same without its `utm_*` attribution, which
 * `fetch_url` requests in its place when only that form is authorized (`lib/server/tools/fetchUrl.ts`), so a record citing either
 * finds the read.
 */
function askedAddresses(asked: unknown): string[] {
  const link = normalizeFetchUrl(asked);
  if (!link) return [];
  const bare = withoutFetchUrlAttribution(link);
  return bare ? [link, bare] : [link];
}

export function createResearchSources(input: Readonly<{
  chatId: string;
  /** The main agent's items as the run holds them. */
  items(): readonly TranscriptItem[];
  run: ResearchRunPlace;
  savedResults: SavedToolResultReader;
  threads: Pick<SubagentThreadStore, "backgroundRunIds" | "threadEffectItems">;
  userId: string;
}>) {
  const scope = { chatId: input.chatId, userId: input.userId };
  return {
    async opened(signal: AbortSignal, whose?: "researchers"): Promise<readonly ResearchOpenedSource[]> {
      const runIds = researchRunsOnBranch(input.run);
      const background = await input.threads.backgroundRunIds({ ...scope, parentRunIds: runIds });
      const threads = await input.threads.threadEffectItems({ ...scope, runIds: [...runIds, ...background] });
      const read = whose === "researchers" ? threads.filter(({ name }) => !GATE_TURN.test(name ?? "")) : threads;
      const opened: ResearchOpenedSource[] = [];
      let characters = 0;
      for (const list of [input.items(), ...read.map((thread) => thread.items)]) {
        const calls = new Map(list.flatMap((item) => item.kind === "tool_call" ? [[item.callId, item] as const] : []));
        for (const item of list) {
          // A cleared result's stub stands for the result it follows, which is read already (`lib/server/engine/compaction/clearing.ts`).
          if (item.kind !== "tool_result" || item.cleared === true || item.outcome !== "complete" || AGENT_WRITTEN.has(item.name)) continue;
          if (opened.length >= RESEARCH_SOURCE_LIMITS.results || characters >= RESEARCH_SOURCE_LIMITS.totalCharacters) return opened;
          signal.throwIfAborted();
          let text = item.output;
          let partial = false;
          if (item.handle) {
            const saved = await input.savedResults.read({ ...scope, handle: item.handle, signal }).catch(() => null);
            if (saved) text = saved.text;
            else partial = true;
          } else if (UNSAVED_EXCERPT.test(text)) partial = true;
          characters += text.length;
          const call = calls.get(item.callId);
          opened.push({ ...call?.kind === "tool_call" && BROWSER_COMMAND.test(call.arguments) ? { browser: true as const } : {}, partial, text, toolName: item.name, url: pageUrl(call) });
        }
      }
      return opened;
    }
  };
}

/** Whose results a write reads: one agent's (null: the main agent's), under the runs that can hold them. */
export type ResearchAgentScope = Readonly<{ runIds: readonly string[]; threadId: string | null }>;

/**
 * One completed call as its `ModelRunToolCall` row keeps it. The row is settled before the call's batch returns (`toolBatch.ts`), so a
 * later round's write finds it, and it stays through a compaction. `observationId`: its saved copy, which a result too long for the row has.
 */
export type ResearchAgentCall = Readonly<{ arguments: unknown; id: string; observationId: string | null; providerCallId: string; result: unknown; toolName: string }>;

/** An agent's call rows, newest first. */
export type ResearchAgentCalls = Readonly<{
  /**
   * Its newest calls of these tools, finished or failed: a browser refusing a site is an attempt on it too. A reader without it cannot
   * say what the agent's browser tried, so it holds no record back.
   */
  attempts?(agent: ResearchAgentScope, input: Readonly<{ limit: number; toolNames: readonly string[] }>): Promise<readonly ResearchAgentCall[]>;
  /** These calls whole, in the order asked for. */
  calls(agent: ResearchAgentScope, ids: readonly string[]): Promise<readonly ResearchAgentCall[]>;
  /** Its `fetch_url` calls without their results: what finds a link costs no page. */
  fetchCalls(agent: ResearchAgentScope, limit: number): Promise<readonly Pick<ResearchAgentCall, "arguments" | "id">[]>;
  /** Its newest calls of any other tool than these. */
  recentCalls(agent: ResearchAgentScope, input: Readonly<{ excludedTools: readonly string[]; limit: number }>): Promise<readonly ResearchAgentCall[]>;
}>;

/** What one read found. `callIds` are its calls, so a second read skips them; `moreUnread`: it stopped at a bound. */
export type ResearchAgentRead = Readonly<{ callIds: readonly string[]; moreUnread: boolean; sources: readonly ResearchOpenedSource[] }>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What a `fetch_url` result says of its page: its own text, without the fields around it. */
function fetchedPage(result: ToolExecutionResult): Readonly<{ finalUrl: unknown; partial: boolean; text: string }> | null {
  const first = result.content[0];
  const value: unknown = first?.type === "json" ? first.value : null;
  return isObject(value) && typeof value.text === "string" ? { finalUrl: value.finalUrl, partial: value.truncated === true, text: value.text } : null;
}

/**
 * What one write reads of its own agent's results, and nothing else: a page reaches the store only from the agent that saw it. Which
 * reads hold a link is known from the arguments alone, so a record whose page was fetched costs that page's rows. Only a quote not on
 * it goes on to the agent's latest results, where a browser's pages are, since they have no link of their own.
 */
export function createResearchAgentSources(input: Readonly<{
  calls: ResearchAgentCalls;
  chatId: string;
  savedResults: SavedToolResultReader;
  userId: string;
}>) {
  const limits = RESEARCH_WRITE_SOURCE_LIMITS;

  async function wholeText(text: string, observationId: string | null, signal: AbortSignal): Promise<Pick<ResearchOpenedSource, "partial" | "text">> {
    if (!EXCERPT.test(text)) return { partial: false, text };
    if (!observationId) return { partial: true, text };
    const saved = await input.savedResults.read({ chatId: input.chatId, handle: `tor1_${observationId}`, signal, userId: input.userId }).catch(() => null);
    return saved ? { partial: false, text: saved.text } : { partial: true, text };
  }

  /** `url`: a cited link when the call read it or was sent on to it, so a redirect's page is that link's own. */
  async function sourceOf(call: ResearchAgentCall, links: ReadonlySet<string>, signal: AbortSignal): Promise<ResearchOpenedSource | null> {
    const result = parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName }, call.result as ToolLoopJsonValue);
    if (!result) return null;
    const page = call.toolName === FETCH_URL_TOOL_NAME ? fetchedPage(result) : null;
    const read = page ? { partial: page.partial, text: page.text } : await wholeText(toolResultOutputText(result), call.observationId, signal);
    const addresses = page ? [...askedAddresses(isObject(call.arguments) ? call.arguments.url : null), ...[page.finalUrl].flatMap((url) => normalizeFetchUrl(url) ?? [])] : [];
    return { ...BROWSER_COMMAND.test(JSON.stringify(call.arguments ?? {})) ? { browser: true as const } : {}, ...read, toolName: call.toolName,
      url: addresses.find((url) => links.has(url)) ?? addresses[0] ?? null };
  }

  async function read(calls: readonly ResearchAgentCall[], links: ReadonlySet<string>, signal: AbortSignal): Promise<ResearchAgentRead> {
    const sources: ResearchOpenedSource[] = [];
    const callIds: string[] = [];
    let characters = 0;
    for (const call of calls) {
      signal.throwIfAborted();
      const source = await sourceOf(call, links, signal);
      if (!source) continue;
      characters += source.text.length;
      if (characters > limits.characters && sources.length > 0) return { callIds, moreUnread: true, sources };
      callIds.push(call.id);
      sources.push(source);
    }
    return { callIds, moreUnread: false, sources };
  }

  return {
    /** The agent's own reads of these links, the newest of each. */
    async cited(agent: ResearchAgentScope, links: ReadonlySet<string>, signal: AbortSignal): Promise<ResearchAgentRead> {
      const listed = await input.calls.fetchCalls(agent, limits.fetchCalls);
      const counts = new Map<string, number>();
      const ids = listed.flatMap((call) => {
        const link = askedAddresses(isObject(call.arguments) ? call.arguments.url : null).find((address) => links.has(address));
        if (!link || (counts.get(link) ?? 0) >= limits.citedResults) return [];
        counts.set(link, (counts.get(link) ?? 0) + 1);
        return [call.id];
      });
      const found = ids.length > 0 ? await read(await input.calls.calls(agent, ids), links, signal) : { callIds: [], moreUnread: false, sources: [] };
      return { ...found, moreUnread: found.moreUnread || listed.length >= limits.fetchCalls };
    },

    /**
     * The hosts the agent's own command calls show the browser tried (`attemptedHosts`), from its call rows and never from its word.
     * Bounded to its newest command calls; null when the calls cannot be listed.
     */
    async browsedHosts(agent: ResearchAgentScope, signal: AbortSignal): Promise<ReadonlySet<string> | null> {
      if (!input.calls.attempts) return null;
      const calls = await input.calls.attempts(agent, { limit: limits.browserCalls, toolNames: COMMAND_TOOLS });
      const hosts = new Set<string>();
      for (const call of calls) {
        signal.throwIfAborted();
        for (const host of attemptedHosts(call)) hosts.add(host);
      }
      return hosts;
    },

    /** The agent's latest results, those a first read took left out. */
    async recent(agent: ResearchAgentScope, links: ReadonlySet<string>, skip: readonly string[], signal: AbortSignal): Promise<ResearchAgentRead> {
      const calls = await input.calls.recentCalls(agent, { excludedTools: [...AGENT_WRITTEN], limit: limits.recentResults });
      const found = await read(calls.filter((call) => !skip.includes(call.id)), links, signal);
      return { ...found, moreUnread: found.moreUnread || calls.length >= limits.recentResults };
    }
  };
}
