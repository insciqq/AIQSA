import { RESEARCH_PAGE_LIMITS, type ResearchRecordInput, type ResearchQuoteCheckStatus } from "../../contracts/research";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { SavedToolResultReader } from "../engine/toolResults";
import { logEvent } from "../observability";
import { FETCH_URL_TOOL_NAME } from "../tools/fetchUrlPlan";
import { normalizeFetchUrl } from "../webFetch/urls";
import type { ResearchEvidenceRepository, ResearchPageWrite, ResearchRecordedCheck } from "./evidenceRepository";
import type { ResearchOpenedSource } from "./gates";
import type { ResearchEvidencePort, ResearchEvidenceWrite, ResearchRunScope } from "./ports";
import { checkQuotes, quoteIsIn, type QuoteCheck, type QuoteSource } from "./quoteCheck";
import { createResearchAgentSources, researchEvidenceKind, researchRunsOnBranch, type ResearchAgentScope } from "./sources";
import { prepareResearchSourceQuality } from "./sourceQuality";

/**
 * The evidence store (`ResearchEvidencePort`): a finding is a durable record the moment it is made, under the research run whichever
 * run or agent writes, so no send back, rewrite or approval can lose it. The quote is checked here, against what the writing agent
 * itself read, so it hears at once while it still has the page, and that text is kept with the record, so a check later reads what
 * the agent saw. An agent never writes page text. A wrong quote is kept with its word: refusing it would lose a finding, and a
 * correction supersedes it. A page the run's bounds have no room for leaves the record standing without it, marked not checked, for
 * the same reason: a refusal here would refuse every later finding once they are reached. The record bound is what refuses.
 */
export type ResearchEvidenceStoreDeps = Readonly<{
  repository: ResearchEvidenceRepository;
  savedResults: SavedToolResultReader;
  /** Where a background child's own results are: a run of its own. */
  threads: Pick<SubagentThreadStore, "backgroundRunIds">;
}>;

/** What a check adds to the quote check's reasons: the quote is on a page other than the one cited, or the store could not keep it. */
export const RESEARCH_CHECK_REASONS = Object.freeze({ otherPage: "other_page", pageNotStored: "page_not_stored", pageTruncated: "page_truncated" });

type Quoted = Readonly<{ quote: string; url: string }>;

/** A record's quotes: a finding's, and a dataset's examples. */
const quotesOf = (record: ResearchRecordInput): readonly Quoted[] =>
  record.kind === "finding" ? [{ quote: record.quote, url: record.url }] : record.kind === "dataset" ? record.dataset.examples : [];

/** Text as a stored page may hold it: no NUL, which PostgreSQL refuses, well formed, and cut at a whole character at the bound. */
export function storedPageText(text: string): Readonly<{ cut: boolean; text: string }> {
  const bytes = Buffer.from(text.replaceAll("\u0000", ""), "utf8");
  if (bytes.length <= RESEARCH_PAGE_LIMITS.bytesPerPage) return { cut: false, text: bytes.toString("utf8") };
  let end = RESEARCH_PAGE_LIMITS.bytesPerPage;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { cut: true, text: bytes.subarray(0, end).toString("utf8") };
}

function recordedCheck(check: QuoteCheck): ResearchRecordedCheck {
  if (check.status === "found") return { reason: check.excerpt.source.kind === "other" ? RESEARCH_CHECK_REASONS.otherPage : null, status: "found" };
  return { reason: check.status === "not_verbatim" ? null : check.reason, status: check.status };
}

/** A record has one word for its quotes: the one that most needs the agent. */
const CHECK_ORDER: readonly ResearchQuoteCheckStatus[] = ["unsupported", "not_verbatim", "not_checked", "found"];

const firstInNeed = (checks: readonly QuoteCheck[]) => [...checks].sort((one, other) => CHECK_ORDER.indexOf(one.status) - CHECK_ORDER.indexOf(other.status))[0]!;

function pageWrite(source: ResearchOpenedSource, url: string): ResearchPageWrite | null {
  const { cut, text } = storedPageText(source.text);
  return text ? { obtainedBy: source.toolName === FETCH_URL_TOOL_NAME ? "tool" : "browser", text, truncated: source.partial || cut, url } : null;
}

/** Where a passage was: the cited link, or for another page its own, which for a browser is only the host its step lines show. */
const pageAddress = (source: QuoteSource, cited: string) => source.kind !== "other" ? cited : /^https?:\/\//iu.test(source.url) ? source.url : `https://${source.url}`;

/**
 * What a record keeps of what the check read: the page its quote is on, or else the page it cites, where a verifier can read what that
 * says instead. A page cut before the quote cannot show it, which is no failure of the quote.
 */
function keptWithRecord(quotes: readonly Quoted[], checks: readonly QuoteCheck[], opened: readonly ResearchOpenedSource[], links: ReadonlySet<string>):
  Readonly<{ check: ResearchRecordedCheck; page: ResearchPageWrite | null }> {
  const check = recordedCheck(firstInNeed(checks));
  const at = checks.findIndex((entry) => entry.status === "found");
  const found = checks[at];
  if (found?.status === "found") {
    const page = pageWrite(opened[found.opened]!, pageAddress(found.excerpt.source, quotes[at]!.url));
    const lost = page?.truncated === true && !quoteIsIn(quotes[at]!.quote, page.text);
    return { check: lost && check.status === "found" ? { reason: RESEARCH_CHECK_REASONS.pageTruncated, status: "not_checked" } : check, page };
  }
  const cited = opened.find((source) => source.url !== null && links.has(source.url) && researchEvidenceKind(source) === "page");
  return { check, page: cited ? pageWrite(cited, cited.url!) : null };
}

/** One port per run (`ResearchPortFactories.evidence`). */
export function createResearchEvidenceStore(deps: ResearchEvidenceStoreDeps) {
  return (run: ResearchRunScope): ResearchEvidencePort => {
    const scope = { chatId: run.chatId, researchRunId: run.researchRunId, userId: run.userId };
    const sources = createResearchAgentSources({ calls: deps.repository.agentCalls(scope), chatId: run.chatId, savedResults: deps.savedResults, userId: run.userId });

    /** The runs that hold an agent's own results: the runs this research went through, an approval's included, and its background runs. */
    async function agentScope(threadId: string | null, chain: readonly string[]): Promise<ResearchAgentScope> {
      const runs = [...new Set([...chain, ...researchRunsOnBranch(run)])];
      const background = threadId === null ? [] : await deps.threads.backgroundRunIds({ chatId: run.chatId, parentRunIds: runs, userId: run.userId });
      return { runIds: [...runs, ...background], threadId };
    }

    /** Reads what the write needs before anything is locked: first the pages it cites, and past them only what its quote was not on. */
    async function checked(write: ResearchEvidenceWrite, chain: readonly string[], quotes: readonly Quoted[], signal: AbortSignal) {
      const agent = await agentScope(write.author.threadId, chain);
      const links = new Set(quotes.flatMap((entry) => normalizeFetchUrl(entry.url) ?? []));
      const first = await sources.cited(agent, links, signal);
      const onCited = checkQuotes(quotes, first.sources, { moreUnread: first.moreUnread });
      if (onCited.every((check) => check.status === "found" && check.excerpt.source.kind === "cited")) return keptWithRecord(quotes, onCited, first.sources, links);
      const more = await sources.recent(agent, links, first.callIds, signal);
      const opened = [...first.sources, ...more.sources];
      return keptWithRecord(quotes, checkQuotes(quotes, opened, { moreUnread: first.moreUnread || more.moreUnread }), opened, links);
    }

    return {
      async page(pageId, signal) {
        signal.throwIfAborted();
        return deps.repository.page(scope, await deps.repository.chain(scope), pageId);
      },

      async record(write, signal) {
        signal.throwIfAborted();
        const chain = await deps.repository.chain(scope);
        const quotes = quotesOf(write.record);
        const held = quotes.length === 0 ? { check: null, page: null } : await checked(write, chain, quotes, signal).catch((error: unknown) => {
          if (signal.aborted) throw error;
          // Its own results could not be read: the finding still stands, marked so.
          logEvent("service_operation", { action: "degrade", code: "research_sources_unreadable", error, outcome: "degraded", run_id: run.runId, stage: "read", subsystem: "database" });
          return { check: { reason: "sources_unreadable", status: "not_checked" as const }, page: null };
        });
        signal.throwIfAborted();
        // Read only when a page was to be kept and found no room: a wrong quote keeps its word, which the agent must hear, and any other word rested on that page.
        const notKept = held.check?.status === "not_verbatim" ? held.check : { reason: RESEARCH_CHECK_REASONS.pageNotStored, status: "not_checked" as const };
        const written = await deps.repository.append(scope, { author: write.author, chain, page: held.page, quoteCheck: { kept: held.check, notKept }, record: write.record,
          sourceQuality: prepareResearchSourceQuality(write.record, held.page) });
        const bound = written.kind === "refused" ? written.code : written.record.quoteCheck?.reason;
        if (bound === "research_records_full" || bound === RESEARCH_CHECK_REASONS.pageNotStored) {
          logEvent("service_operation", { action: "degrade", code: bound, outcome: "degraded", run_id: run.runId, stage: "write", subsystem: "database" });
        }
        return written;
      },

      async records(signal) {
        signal.throwIfAborted();
        return deps.repository.records(scope, await deps.repository.chain(scope));
      }
    };
  };
}
