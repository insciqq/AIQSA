import type { ResearchDraft, ResearchGateResult, ResearchPlan } from "../../contracts/research";
import type { EndedSubagentCallResult, SubagentToolGroup } from "../../contracts/subagents";
import { logEvent } from "../observability";
import { gapCheckGate } from "./gapCheck";
import { researchNote } from "./notes";
import type { ResearchCoveragePort, ResearchEvidencePort } from "./ports";
import { verifierGate } from "./verifier";

/**
 * The gate seam: the named checks a research draft goes through before it is
 * accepted, all the engine knows of them. The server runs them when the main
 * agent hands in a draft (`submit_research_draft`, or a final message; see
 * `run.ts`), so no prompt can skip them. Each gate gets the draft and the plan
 * and answers pass or send back. A gate fills its own file and never touches
 * the engine.
 *
 * What a gate can rely on:
 * - It runs inside the run: `signal` ends with Stop, the turn's deadline and the
 *   gate's own time, and its usage is the run's. Once Stop ended the run nothing
 *   here keeps it alive.
 * - Answer first: a gate that throws or outlasts `time.remainingMs` costs its
 *   check and adds a visible note, never the answer. A send back with no time
 *   left to act on it turns into its `unresolvedNote`.
 * - `subagents.run` starts a sub-agent turn the gate waits for. It counts toward
 *   the chat's running sub-agents (`SUBAGENT_LIMITS.runningPerChat`) and a full
 *   chat refuses it (`kind: "refused"`); `model: "verifier"` runs on the
 *   administrator's verifier model as this run froze it (`verifierModel`).
 * - `sources.opened` reads what agents of this run really opened. A browser page
 *   read but not stored is not in it: that is "not checked", not a failure.
 */
export type ResearchVerifierModel =
  /** The administrator's model, or the main model when the role is not set: the answer must say so (operator decision 2026-11-01). */
  | Readonly<{ kind: "role" | "main_model"; label: string }>
  /** The administrator chose a model this run cannot use: it never runs on another one in its place. */
  | Readonly<{ kind: "unavailable" }>;

export type ResearchSubagentRequest = Readonly<{
  brief: string;
  /** The turn's role instructions. */
  instructions: string;
  model: "main" | "verifier";
  /** Unique within the attempt, across gates: the server adds what makes the thread its own to this run and attempt. */
  name: string;
  /** Narrows the turn's tools; a gate's turn starts no children, and a list is required so it is never handed every tool. */
  tools: readonly SubagentToolGroup[];
}>;

export type ResearchSubagentOutcome =
  | Readonly<{ kind: "ended"; result: EndedSubagentCallResult }>
  /** It never started: a full chat (`subagent_limit_reached`) or a model it cannot run on. */
  | Readonly<{ code: string; kind: "refused" }>;

/** One tool result an agent of this run really got: `url` for a page `fetch_url` read. */
export type ResearchOpenedSource = Readonly<{
  /** The call drove the Workspace browser: what it printed is a page's text, step lines or not. */
  browser?: true;
  /** The stored whole result could not be read, so `text` is only its excerpt: a miss here is not a failure. */
  partial: boolean;
  text: string;
  toolName: string;
  url: string | null;
}>;

/** One earlier draft of this run and what the gates said of it: what "a round added nothing new" compares against. */
export type ResearchAttempt = Readonly<{ draft: ResearchDraft; message: string | null }>;

export type ResearchGateContext = Readonly<{
  /** 1 for the run's first draft. */
  attempt: number;
  /** The run's matrix. A gate reads this and `evidence` through `researchGatePorts`, so a context built without them reads the no-ops. */
  coverage?: ResearchCoveragePort;
  earlier: readonly ResearchAttempt[];
  evidence?: ResearchEvidencePort;
  plan: ResearchPlan;
  signal: AbortSignal;
  sources: Readonly<{ opened(signal: AbortSignal): Promise<readonly ResearchOpenedSource[]> }>;
  subagents: Readonly<{ run(request: ResearchSubagentRequest, signal: AbortSignal): Promise<ResearchSubagentOutcome> }>;
  time: Readonly<{
    /** How long the gates may still take; past it the answer goes out. */
    remainingMs(): number;
    /** Whether a send back can still be acted on: the turn still has time for tools (`turnSoftDeadlineMs`). */
    sendBackAllowed(): boolean;
  }>;
  /** Resolves the role once for the run, from what the run froze when it started. */
  verifierModel(signal: AbortSignal): Promise<ResearchVerifierModel>;
}>;

export type ResearchGate = Readonly<{
  /**
   * What the gate has already said that holds for any later draft of the run: added whenever it did not finish on one (an
   * earlier gate sent the draft back, it failed, time or Stop came first), so a claim it rejected stays named.
   */
  carriedNotes?(draft: ResearchDraft, earlier: readonly ResearchAttempt[]): readonly string[];
  name: string;
  run(draft: ResearchDraft, context: ResearchGateContext): Promise<ResearchGateResult>;
}>;

export const RESEARCH_GATES: readonly ResearchGate[] = [gapCheckGate, verifierGate];

/** What the gates carry for a draft they have not finished on. */
export function researchCarriedNotes(gates: readonly ResearchGate[], draft: ResearchDraft, earlier: readonly ResearchAttempt[]): readonly string[] {
  return gates.flatMap((gate) => gate.carriedNotes?.(draft, earlier) ?? []);
}

export type ResearchGatesOutcome =
  | Readonly<{ kind: "accepted"; notes: readonly string[] }>
  | Readonly<{ kind: "sent_back"; message: string; notes?: readonly string[] }>;

class GateTimedOut extends Error {
  override name = "GateTimedOut";
}

/** Work under its own signal: what ignores the signal still lets the answer go. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason as Error);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Runs the gates in order, each under what is left of their time, until one sends the draft back. Throws only when the
 * run itself stopped.
 */
export async function runResearchGates(input: Readonly<{ context: ResearchGateContext; draft: ResearchDraft;
  gates: readonly ResearchGate[]; runId: string }>): Promise<ResearchGatesOutcome> {
  const { context, draft } = input;
  const notes: string[] = [];
  const finished = new Set<ResearchGate>();
  const withCarried = () => [...notes, ...researchCarriedNotes(input.gates.filter((gate) => !finished.has(gate)), draft, context.earlier)];
  for (const gate of input.gates) {
    context.signal.throwIfAborted();
    const remaining = context.time.remainingMs();
    if (remaining <= 0) {
      notes.push(researchNote("time_out", draft.report));
      break;
    }
    const own = new AbortController();
    const timer = setTimeout(() => own.abort(new GateTimedOut()), remaining);
    (timer as { unref?: () => void }).unref?.();
    const signal = AbortSignal.any([context.signal, own.signal]);
    try {
      const result = await untilAborted(Promise.resolve().then(() => gate.run(draft, { ...context, signal })), signal);
      finished.add(gate);
      notes.push(...result.notes ?? []);
      if (result.kind === "send_back") {
        if (context.time.sendBackAllowed()) {
          if (result.unresolvedNote) notes.push(result.unresolvedNote);
          const sentBackNotes = withCarried();
          return { kind: "sent_back", message: result.message, ...sentBackNotes.length > 0 ? { notes: sentBackNotes } : {} };
        }
        notes.push(result.unresolvedNote ?? researchNote("time_out", draft.report));
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      const timedOut = own.signal.aborted;
      notes.push(researchNote(timedOut ? "time_out" : "gate_failed", draft.report));
      if (!timedOut) logEvent("run_execution", { code: "research_gate_failed", error, outcome: "failed", run_id: input.runId, stage: "execution" });
    } finally {
      clearTimeout(timer);
      // A gate that was given up on stops what it started; one that finished has nothing left to stop.
      own.abort(new GateTimedOut());
    }
  }
  return { kind: "accepted", notes: withCarried() };
}
