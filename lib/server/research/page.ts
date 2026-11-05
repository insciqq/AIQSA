import { randomUUID } from "node:crypto";
import { RESEARCH_TIME_MS } from "../../contracts/research";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { TranscriptItem, TranscriptToolResultItem } from "../engine/transcript";
import { logEvent } from "../observability";
import type { ProviderHistoryItem } from "../providers/history";
import type { ProviderRunRequest } from "../providers/types";
import { ARTIFACT_TOOL_NAME } from "../tools/artifact";
import type { ModelToolCall, RunTool } from "../tools/types";
import { untilAborted } from "./gates";
import { researchPageInstruction, researchPageSendBack } from "./pageGuide";
import type { ResearchPageArtifact, ResearchPagePort } from "./ports";

/**
 * The page of a finished research (operator decisions 2026-11-05): once its checks ended and its draft is final, the main agent gets one step with the
 * built-in guide (`pageGuide.ts`) and `create_artifact` alone, and writes a private artifact from the final report while the server holds the answer.
 *
 * The step is extra to the answer, never in its way. It starts only when the hard end leaves `RESEARCH_TIME_MS.page` before the turn's handoff reserve,
 * and it ends at that bound; it never moves the hard end. Before it starts, the answer it holds is saved to the answer message (`save`), so a restart
 * during the step leaves recovery that text, as it leaves any answer's saved text; a save that fails skips the page, and the answer goes out at once.
 *
 * Its conversation is its own: the run's system prompt, the guide, the report and the answer's caveats, with nothing of the research's context and no
 * Search of any kind (`researchPageRequest`), so the page can only draw on what the checks read. Nothing of it enters the run's transcript, which would
 * carry the page's whole markup into every later turn: those reach the page as one of the chat's artifacts, as any artifact is reached for an edit.
 * Its call goes through the run's ordinary tool path and viewer sandbox, outside the call budget as the reserved draft is, and the card it makes is held
 * until the page's check passes. No call, a failed call, a second mismatch, a check that throws or the bound reached ends the step with no page, an
 * artifact the step made is archived (`discard`), and the answer goes out as it would have. Only Stop and the turn's deadline end it otherwise: they end
 * the run, whose ending keeps the answer.
 */
export type ResearchPage = Readonly<{ artifact: ResearchPageArtifact; card: ModelRunSseEvent }>;

/** One response of the step: its calls, and its items for the step's own conversation should the check send the page back. */
export type ResearchPageResponse = Readonly<{ calls: readonly ModelToolCall[]; items: readonly TranscriptItem[] }>;

/** The page call's result for the step's conversation, and the card it made, which nothing has shown yet. */
export type ResearchPageCallResult = Readonly<{ cards: readonly ModelRunSseEvent[]; result: TranscriptToolResultItem }>;

export type ResearchPageStepInput = Readonly<{
  /** The answer's notes about its content (`researchContentNotes`), which the page places beside what they name. */
  caveats: readonly string[];
  /** The page's check (`ResearchPagePort`), before the page reaches the answer. */
  check: ResearchPagePort["check"];
  /** Archives an artifact this step made that the answer will not show, so no later turn reads it as one of the chat's; absent, it stays. */
  discard?(artifactId: string): Promise<void>;
  /** What was researched, for the page's title and its first lines. */
  goal: string;
  /** When the turn must hand over its answer: the hard end less its handoff reserve, read as the step starts. */
  latestEnd: number;
  now(): number;
  /** The report the answer goes out with, the page's only source. */
  report: string;
  /** One response of the run's model to the step's conversation, offering `create_artifact` alone. */
  respond(items: readonly TranscriptItem[], signal: AbortSignal): Promise<ResearchPageResponse>;
  /** Runs the page call through the run's tool path, holding the card it makes. `attempt` counts from 1. */
  runCall(call: ModelToolCall, attempt: number, signal: AbortSignal): Promise<ResearchPageCallResult>;
  runId: string;
  /** Saves the answer the step holds to the answer message, as it would go out; it throws when it could not. */
  save(signal: AbortSignal): Promise<void>;
  /** Stop and the turn's deadline: they end the run, never the step alone. */
  signal: AbortSignal;
}>;

/** The first page and the one the check's send back makes. */
const PAGE_ATTEMPTS = 2;

/** What a call the step did not run reads, so a send back's conversation has no call without its result. */
const NOT_RUN = `Not run: this step runs one ${ARTIFACT_TOOL_NAME} call and nothing else.`;

const unref = (timer: ReturnType<typeof setTimeout>) => (timer as { unref?: () => void }).unref?.();

/**
 * The step's request: the run's own, so its frozen model, credential, route and parameters, with the step's conversation, `create_artifact` alone and no
 * Search source: a provider's hosted Search rides on the request's sources rather than its tools, and would bring the page what no check read.
 */
export function researchPageRequest(base: ProviderRunRequest, input: Readonly<{ history: ProviderHistoryItem[]; params: ProviderRunRequest["params"]; tool: RunTool }>):
  ProviderRunRequest {
  return { ...base, attachments: [], history: input.history, params: input.params, parallelToolCalls: true, previousProviderResponseId: undefined,
    providerToolMessages: undefined, searchPlan: { ...base.searchPlan, options: [] }, toolChoice: "auto", tools: [input.tool] };
}

/** The version a page call made, from its card: the receipt the conversation card keeps (`artifactToolResult`). */
export function researchPageArtifact(card: ModelRunSseEvent): ResearchPageArtifact | null {
  if (card.type !== "artifact" || card.data.artifactType !== "generated_artifact") return null;
  const payload = card.data.payload as Record<string, unknown> | null;
  if (typeof payload !== "object" || payload === null) return null;
  const { artifact_id: artifactId, entrypoint, title, version_id: versionId } = payload;
  if (typeof artifactId !== "string" || typeof versionId !== "string" || typeof title !== "string") return null;
  return { artifactId, entrypoint: typeof entrypoint === "string" ? entrypoint : null, title, versionId };
}

/** A card of an artifact's first version: one the step's own call created, never an earlier artifact it may have updated. */
const createdBy = (card: ModelRunSseEvent) => card.type === "artifact" && (card.data.payload as { version_number?: unknown } | null)?.version_number === 1;

/** Writes the page, or gives null when the step could not; throws only when the run itself stopped (`signal`). */
export async function writeResearchPage(input: ResearchPageStepInput): Promise<ResearchPage | null> {
  const failed = (code: string, error?: unknown) => {
    logEvent("run_execution", { code, ...(error === undefined ? {} : { error }), outcome: "failed", run_id: input.runId, stage: "execution" });
    return null;
  };
  input.signal.throwIfAborted();
  if (input.now() + RESEARCH_TIME_MS.page > input.latestEnd) return failed("research_page_no_time");
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(new Error("research_page_timed_out")), RESEARCH_TIME_MS.page);
  unref(timer);
  const signal = AbortSignal.any([input.signal, own.signal]);
  /** The artifact this step created, which the answer shows only as its page. */
  let created: string | null = null;
  const items: TranscriptItem[] = [{ id: randomUUID(), kind: "user",
    text: researchPageInstruction({ caveats: input.caveats, goal: input.goal, report: input.report }) }];
  const step = async (): Promise<ResearchPage | null> => {
    try {
      await untilAborted(Promise.resolve().then(() => input.save(signal)), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return failed("research_page_unsaved", error);
    }
    for (let attempt = 1; ; attempt += 1) {
      const response = await untilAborted(input.respond(items, signal), signal);
      const call = response.calls.find((made) => made.name === ARTIFACT_TOOL_NAME);
      if (!call) return failed("research_page_not_written");
      const { cards, result } = await untilAborted(input.runCall(call, attempt, signal), signal);
      const card = result.outcome === "complete" ? cards.find((made) => researchPageArtifact(made) !== null) : undefined;
      const artifact = card && researchPageArtifact(card);
      if (!card || !artifact) return failed("research_page_not_written");
      if (created === null && createdBy(card)) created = artifact.artifactId;
      const verdict = await untilAborted(Promise.resolve().then(() => input.check({ page: artifact, report: input.report, signal })), signal);
      if (verdict.kind === "pass") return { artifact, card };
      if (attempt >= PAGE_ATTEMPTS) return failed("research_page_mismatch");
      const others = response.calls.filter((made) => made !== call).map((made): TranscriptToolResultItem => ({ callId: made.id, id: randomUUID(),
        kind: "tool_result", name: made.name, outcome: "error", output: NOT_RUN }));
      items.push(...response.items, result, ...others, { id: randomUUID(), kind: "user", text: researchPageSendBack(verdict.message, artifact.versionId) });
    }
  };
  let page: ResearchPage | null;
  try {
    page = await step();
  } catch (error) {
    if (input.signal.aborted) throw error;
    page = failed(own.signal.aborted ? "research_page_timed_out" : "research_page_failed", error);
  } finally {
    clearTimeout(timer);
    // What the step started and still runs stops with it.
    own.abort();
  }
  // A page the answer will not show leaves the chat's artifacts. A version still being written when the bound ended it has no card to name it, so it stays.
  if (page === null && created !== null && input.discard) {
    const artifactId = created;
    await untilAborted(Promise.resolve().then(() => input.discard!(artifactId)), input.signal).catch((error: unknown) => {
      if (input.signal.aborted) throw error;
      failed("research_page_not_discarded", error);
    });
  }
  return page;
}
