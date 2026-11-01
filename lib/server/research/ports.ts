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
import type { PrepareRunSubagentsInput } from "../engine/subagents/runSubagents";
import type { ResearchGate, ResearchGateContext } from "./gates";

/**
 * The seams of the research system (`agent_docs/RUN_CONTRACTS.md`, Research): one narrow port per part, so each part fills
 * its own without touching another's. `run.ts` makes one set for each run from the factories in `ResearchEngineDeps.ports`,
 * and a factory left out is its no-op here: a true identity, with no row, no model call and nothing awaited on today's path.
 * A real one reaches production only from `research` in `defaultNativeEngineDeps` (`lib/server/engine/defaultEngine.ts`).
 */

/** What a run hands every port: all of a port's run-bound state comes from here. */
export type ResearchRunScope = Readonly<{
  chatId: string;
  /** Moves the turn's deadline, once and for this run only; does nothing until the engine passes `extendTurn` to `run.ts`. */
  extendTurn(endsAt: number): void;
  now(): number;
  runId: string;
  /** What agents of this run really opened. */
  sources: ResearchGateContext["sources"];
  /**
   * What the run gave its own sub-agents: the user's message and what they wrote into this answer (during the plan window that counts
   * as an edit), the branch's runs a Continue is checked against, and the mailbox that tells running researchers to finish.
   */
  subagents: PrepareRunSubagentsInput;
  userId: string;
}>;

export type ResearchEvidenceWrite = Readonly<{ author: ResearchAgentRef; record: ResearchRecordInput }>;

export type ResearchEvidenceWritten =
  | Readonly<{ kind: "recorded"; record: ResearchEvidenceRecord }>
  /** A limit or a bad reference: the agent reads `message`, so nothing is lost silently. */
  | Readonly<{ code: string; kind: "refused"; message: string }>;

/**
 * The evidence store, filled by `research-evidence-store`. Bound to one run: `record` appends under it whichever agent writes,
 * so a background child's own run id never splits the records. Nothing here changes or deletes a row; a correction is a record
 * that supersedes. Page text can hold NUL characters, which PostgreSQL refuses, so the store drops them.
 */
export type ResearchEvidencePort = Readonly<{
  /** A stored page of this run or of a run it continues; null for any other id, the same as for one that does not exist. */
  page(pageId: string, signal: AbortSignal): Promise<ResearchStoredPage | null>;
  record(write: ResearchEvidenceWrite, signal: AbortSignal): Promise<ResearchEvidenceWritten>;
  /**
   * The live records in order: those of this run and, walking `ResearchFrame.continuedFromRunId` under
   * `RESEARCH_EVIDENCE_LIMITS.continuationChain`, of the runs it continues. A run with no frame row reads its own alone.
   */
  records(signal: AbortSignal): Promise<readonly ResearchEvidenceRecord[]>;
}>;

/**
 * The plan window, filled by `research-plan-window-server`, whose route acts on the same window. `open` keeps the `ResearchFrame`
 * row: it writes the proposal and the window's end, and at the close the answer, the release time and the frame the plan opens with.
 */
export type ResearchPlanWindowPort = Readonly<{
  /** Resolves when the window closes. Stop rejects it through `signal`; a closed tab changes nothing. */
  open(input: Readonly<{ goal: string; proposal: ResearchPlanProposal; signal: AbortSignal }>): Promise<ResearchPlanAnswer>;
}>;

/** The clock of a run's phases, filled by `research-time-budget`. Each call is synchronous and reads no store: gates and tools ask it often. */
export type ResearchTimePort = Readonly<{
  /** When the gates must have ended, given when the turn alone would have them end. */
  gatesEndAt(turnGatesEndAt: number): number;
  phase(): ResearchPhase;
  /** The plan stands, so the phases count from now and the turn is extended. Only the first call counts: a model may start twice. */
  planReleased(): void;
  /** Why no researcher may start now, for the model to read; null while one may. */
  researcherRefusal(): string | null;
  /** The signal a researcher's turn runs under: its own limit on top of the run's. */
  researcherSignal(signal: AbortSignal): AbortSignal;
}>;

/**
 * The matrix, filled by `research-frame-and-gaps`, which alone changes `ResearchFrame.frame` once the plan released it: compare and
 * swap on `version`. A cell's state comes from `ResearchEvidencePort.records`, and each round is planned from the empty cells.
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
   * from. It runs when the run is ending, so it brings its own time bound.
   */
  compose(input: Readonly<{ ended: ResearchReportEnding }>): Promise<string | null>;
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
 * Picking research up after a restart, filled by `research-continue-from-store`. This alone writes `continuedFromRunId`: it finds the
 * interrupted run this turn continues on its own branch, and copies the frame and the answer into this run's row beside that link, so
 * `ResearchEvidencePort.records` then reaches the earlier records. Anything else, another branch or another user's run, reads as null.
 */
export type ResearchResumePort = Readonly<{
  load(signal: AbortSignal): Promise<ResearchResumeState | null>;
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

/**
 * A gate's way to the ports: `run.ts` passes them beside the context's own fields, and a context built without them, as a gate's
 * own test builds one, reads the no-ops.
 */
export function researchGatePorts(context: object): ResearchGatePorts {
  const { coverage, evidence } = context as Partial<ResearchGatePorts>;
  return { coverage: coverage ?? NOOP_RESEARCH_PORTS.coverage, evidence: evidence ?? NOOP_RESEARCH_PORTS.evidence };
}
