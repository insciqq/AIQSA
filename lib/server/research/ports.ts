import type {
  DecodedResearch,
  ResearchAgentRef,
  ResearchEvidenceRecord,
  ResearchFrame,
  ResearchFrameChangeRequest,
  ResearchMatrixCoverage,
  ResearchPhase,
  ResearchPlanAnswer,
  ResearchPlanProposal,
  ResearchRecordInput,
  ResearchStoredPage
} from "../../contracts/research";
import type { SubagentMessaging } from "../subagents/ports";
import type { ResearchGate, ResearchGateContext } from "./gates";

/**
 * The seams of the research system (`agent_docs/RUN_CONTRACTS.md`, Research): one narrow port per part, so each part fills
 * its own without touching another's. `run.ts` makes one set for each run from the factories in `ResearchEngineDeps.ports`,
 * and a factory left out is its no-op here: a true identity, with no row, no model call and nothing awaited on today's path.
 * A real one reaches production only from `research` in `defaultNativeEngineDeps` (`lib/server/engine/defaultEngine.ts`).
 */

/**
 * What a run hands every port, and all of a port's run-bound state comes from here. It names only what the parts need, never the run's
 * provider adapter, secrets or stores, so a part cannot reach what it has no business with.
 */
export type ResearchRunScope = Readonly<{
  /** The branch's earlier runs: a run id read from a stored result counts only when it is one of these. */
  branchRunIds: readonly string[];
  chatId: string;
  /** Moves the turn's deadline, once and for this run only. */
  extendTurn(endsAt: number): void;
  /** How running researchers are found and told to finish; absent where the run has no messaging. */
  mailbox?: Pick<SubagentMessaging, "agents" | "send">;
  now(): number;
  /**
   * The run whose frame, records and pages this run works on, and what every port keys its rows by: its own id, or on an approval
   * continuation, which is a new run, the run that started the research (`researchRunOf`).
   */
  researchRunId: string;
  /** The current run. Its rows of research are keyed by `researchRunId`, so an approval continuation reads what its turn wrote. */
  runId: string;
  /** What agents of this research really opened. */
  sources: ResearchGateContext["sources"];
  /** What the user wrote into this answer, delivered yet or not: during the plan window that counts as an edit. */
  userFollowups(): Promise<readonly Readonly<{ id: string; text: string }>[]>;
  userId: string;
  userMessage: string;
}>;

export type ResearchEvidenceWrite = Readonly<{ author: ResearchAgentRef; record: ResearchRecordInput }>;

export type ResearchEvidenceWritten =
  | Readonly<{ kind: "recorded"; record: ResearchEvidenceRecord }>
  /** A limit or a bad reference: the agent reads `message`, so nothing is lost silently. */
  | Readonly<{ code: string; kind: "refused"; message: string }>;

/**
 * The evidence store, filled by `research-evidence-store`. Records and pages are keyed by `researchRunId`: `record` appends under it
 * whichever run or agent writes, so neither an approval continuation nor a background child's own run id splits them. Nothing here
 * changes or deletes a row; a correction is a record that supersedes. Page text can hold NUL characters, which PostgreSQL refuses, so
 * the store drops them.
 */
export type ResearchEvidencePort = Readonly<{
  /** A stored page under `researchRunId` or a run it continues; null for any other id, the same as for one that does not exist. */
  page(pageId: string, signal: AbortSignal): Promise<ResearchStoredPage | null>;
  record(write: ResearchEvidenceWrite, signal: AbortSignal): Promise<ResearchEvidenceWritten>;
  /**
   * The live records in order: those under `researchRunId` and, walking `ResearchFrame.continuedFromRunId` under
   * `RESEARCH_EVIDENCE_LIMITS.continuationChain`, of the runs it continues. With no frame row it reads its own alone.
   */
  records(signal: AbortSignal): Promise<readonly ResearchEvidenceRecord[]>;
}>;

/**
 * The plan window, filled by `research-plan-window-server`, whose route acts on the same window. `open` keeps the `ResearchFrame`
 * row of `researchRunId`: it writes the proposal and the window's end, and at the close the answer, the release time and the frame
 * the plan opens with.
 */
export type ResearchPlanWindowPort = Readonly<{
  /**
   * Resolves when the window closes. Stop rejects it through `signal`; a closed tab changes nothing. On a window already answered no
   * window opens: the proposal is the plan rebuilt from what the person changed, and it replaces the answer's plan at once.
   */
  open(input: Readonly<{ goal: string; proposal: ResearchPlanProposal; signal: AbortSignal }>): Promise<ResearchPlanAnswer>;
}>;

/**
 * The clock of a run's phases, filled by `research-time-budget`. Each call is synchronous and reads no store: gates and tools ask it
 * often. There is one instance per run, unlike the rows of `researchRunId`: an approval continuation gets a new one and starts a fresh
 * clock at `planReleased` from `resume`, because a long wait for a person is not charged to research.
 */
export type ResearchTimePort = Readonly<{
  /** When the gates must have ended, given when the turn alone would have them end. */
  gatesEndAt(turnGatesEndAt: number): number;
  phase(): ResearchPhase;
  /** The plan stands, so the phases count from now and the turn is extended. Within one instance only the first call counts: a model may start twice. */
  planReleased(): void;
  /**
   * Why no researcher may start now, for the model to read; null while one may. Null before `planReleased` too: the time phases have
   * not started then, and `run.ts` refuses a researcher before the plan on its own.
   */
  researcherRefusal(): string | null;
  /** The signal a researcher's turn runs under: its own limit on top of the run's. */
  researcherSignal(signal: AbortSignal): AbortSignal;
}>;

/**
 * The matrix, filled by `research-frame-and-gaps`, which alone changes `ResearchFrame.frame` of `researchRunId` once the plan released
 * it: compare and swap on `version`. A cell's state comes from `ResearchEvidencePort.records`, and each round is planned from the empty cells.
 */
export type ResearchCoveragePort = Readonly<{
  /** Adds to the frame with its reason; the refusal names what to correct. */
  change(request: ResearchFrameChangeRequest, by: ResearchAgentRef, signal: AbortSignal): Promise<DecodedResearch<ResearchFrame>>;
  /** The matrix against the live records; null for a run with no frame. */
  coverage(signal: AbortSignal): Promise<ResearchMatrixCoverage | null>;
  /** The frame as it stands; null for a run with no frame. */
  frame(signal: AbortSignal): Promise<ResearchFrame | null>;
}>;

/** Why no report stands when the turn ended. */
export type ResearchReportEnding = "failed" | "no_report" | "timed_out";

/** Report assembly, filled by `research-report-from-records`. */
export type ResearchReportPort = Readonly<{
  /**
   * The answer the server builds from the records, in the report's language, with its note. Null when there is nothing to build
   * from. It runs as the run ends, at most once: `signal` ends with Stop and `RESEARCH_TIME_MS.composeReport`, and the run stops waiting then.
   * `goal` is there when the user's last words are the Continue button's, which say nothing of their language, so the goal's language stands for it.
   */
  compose(input: Readonly<{ ended: ResearchReportEnding; goal?: string; signal: AbortSignal }>): Promise<string | null>;
  /** Checks of a draft against the records and the matrix: ordinary gates, run before the others, under the same send-back cap. */
  gates: readonly ResearchGate[];
}>;

/** What an interrupted run left for the Continue that picks it up. */
export type ResearchResumeState = Readonly<{
  answer: ResearchPlanAnswer;
  frame: ResearchFrame;
  /** The run it continues, as the server verified it. */
  fromRunId: string;
  goal: string;
}>;

/**
 * Picking research up after a restart, filled by `research-continue-from-store`. This alone writes `continuedFromRunId`. `run.ts` finds
 * the interrupted turn's research run as an approval continuation does, from its start call's stored result (`researchOfTurn`), and
 * hands it here. It is a stored value, so it counts only in `branchRunIds`: another branch or another user's run reads as null. A run that
 * counts has its frame, answer, proposal and `windowEndsAt` copied into this run's row beside the link, since
 * `ResearchFrame_release_check` needs the last two with `releasedAt`, and `ResearchEvidencePort.records` then reaches the earlier records.
 */
export type ResearchResumePort = Readonly<{
  load(researchRunId: string, signal: AbortSignal): Promise<ResearchResumeState | null>;
}>;

export type ResearchPorts = Readonly<{
  coverage: ResearchCoveragePort;
  evidence: ResearchEvidencePort;
  planWindow: ResearchPlanWindowPort;
  report: ResearchReportPort;
  resume: ResearchResumePort;
  time: ResearchTimePort;
}>;

/** How the engine supplies the ports: one factory per port, called once per run and handed the ports it reads, so no part reaches into another's store. */
export type ResearchPortFactories = Readonly<{
  coverage?: (run: ResearchRunScope, parts: Pick<ResearchPorts, "evidence">) => ResearchCoveragePort;
  evidence?: (run: ResearchRunScope) => ResearchEvidencePort;
  planWindow?: (run: ResearchRunScope) => ResearchPlanWindowPort;
  report?: (run: ResearchRunScope, parts: Pick<ResearchPorts, "coverage" | "evidence">) => ResearchReportPort;
  resume?: (run: ResearchRunScope, parts: Pick<ResearchPorts, "coverage" | "evidence">) => ResearchResumePort;
  time?: (run: ResearchRunScope) => ResearchTimePort;
}>;

const NO_FRAME = "This run has no research frame.";

export const NOOP_RESEARCH_PORTS: ResearchPorts = {
  coverage: {
    change: async () => ({ message: NO_FRAME, ok: false }),
    coverage: async () => null,
    frame: async () => null
  },
  evidence: {
    page: async () => null,
    record: async () => ({ code: "research_evidence_unavailable", kind: "refused", message: "This run keeps no evidence records." }),
    records: async () => []
  },
  planWindow: {
    open: async ({ proposal }) => ({ changed: false, plan: proposal, releasedBy: "timer" })
  },
  report: {
    compose: async () => null,
    gates: []
  },
  resume: {
    load: async () => null
  },
  time: {
    gatesEndAt: (turnGatesEndAt) => turnGatesEndAt,
    phase: () => "researching",
    planReleased: () => undefined,
    researcherRefusal: () => null,
    researcherSignal: (signal) => signal
  }
};

/** The set one run holds. */
export function researchPorts(factories: ResearchPortFactories | undefined, run: ResearchRunScope): ResearchPorts {
  const evidence = factories?.evidence?.(run) ?? NOOP_RESEARCH_PORTS.evidence;
  const coverage = factories?.coverage?.(run, { evidence }) ?? NOOP_RESEARCH_PORTS.coverage;
  return {
    coverage,
    evidence,
    planWindow: factories?.planWindow?.(run) ?? NOOP_RESEARCH_PORTS.planWindow,
    report: factories?.report?.(run, { coverage, evidence }) ?? NOOP_RESEARCH_PORTS.report,
    resume: factories?.resume?.(run, { coverage, evidence }) ?? NOOP_RESEARCH_PORTS.resume,
    time: factories?.time?.(run) ?? NOOP_RESEARCH_PORTS.time
  };
}

/** What a gate reads besides its context's own fields. */
export type ResearchGatePorts = Pick<ResearchPorts, "coverage" | "evidence">;

/** A gate's way to the ports: a context built without them, as a gate's own test builds one, reads the no-ops. */
export function researchGatePorts(context: Pick<ResearchGateContext, "coverage" | "evidence">): ResearchGatePorts {
  return { coverage: context.coverage ?? NOOP_RESEARCH_PORTS.coverage, evidence: context.evidence ?? NOOP_RESEARCH_PORTS.evidence };
}
