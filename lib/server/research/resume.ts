import type { Prisma, PrismaClient } from "@prisma/client";
import { decodeResearchFrame, decodeResearchPlanAnswer, RESEARCH_EVIDENCE_LIMITS } from "../../contracts/research";
import { continuableRunFailure } from "../../contracts/runs";
import { logEvent } from "../observability";
import type { ResearchEvidenceRepository } from "./evidenceRepository";
import type { ResearchResumePort, ResearchResumeState, ResearchRunScope } from "./ports";

/**
 * Picking research up on the user's Continue (`ResearchResumePort`, operator decision 2026-11-01: nothing restarts by itself).
 *
 * A Continue is a new run with its own frame row, its own records and its own bindings. `load` only says whether there is research to pick up. `link` writes that row once, at the
 * start that picks it up, with the plan and the frame of the run it continues and `continuedFromRunId`, and from then on `ResearchEvidencePort` reaches the earlier records and
 * pages through the link. Nothing of the earlier run changes, so a Continue on another branch starts from the same rows.
 *
 * Null is every answer that picks nothing up, and it is one answer: the run was not interrupted, it is another branch's or another
 * user's, it does not exist, its plan never stood, or it recorded nothing. `run.ts` then starts over with the plan step, which is also what
 * a person gets past the chain's bound: `RESEARCH_EVIDENCE_LIMITS.continuationChain` is how far a reader walks, and a further link would
 * put the oldest records out of its reach unseen, so the research is not continued past the point where every record can still be read.
 */

/** A run's key, always with its owner and chat. */
export type ResearchResumeKey = Readonly<{ chatId: string; runId: string; userId: string }>;

/** A frame row as a Continue reads it. */
export type ResearchResumeSource = Readonly<{ answer: unknown; frame: unknown; goal: string; proposal: unknown; releasedAt: Date | null; version: number; windowEndsAt: Date | null }>;

export type ResearchResumeStore = Readonly<{
  /** The runs of this research, earliest first (`ResearchEvidenceRepository.chain`). */
  chain(key: ResearchResumeKey): Promise<readonly string[]>;
  /** The run stopped with its work kept and offered Continue, and its answer was never published. */
  interrupted(key: ResearchResumeKey): Promise<boolean>;
  /** Creates this run's row, which `continuedFromRunId` is written with once. */
  link(key: ResearchResumeKey, write: Readonly<{ answer: unknown; frame: unknown; fromRunId: string; goal: string; proposal: unknown; releasedAt: Date; version: number; windowEndsAt: Date }>): Promise<void>;
  /** Any record under these runs, a correction of one included. */
  recorded(key: ResearchResumeKey, runIds: readonly string[]): Promise<boolean>;
  /** One of these main-agent runs was admitted with Deep research (`NormalizedRunRequest.deepResearch`). */
  sentWithDeepResearch(key: ResearchResumeKey, runIds: readonly string[]): Promise<boolean>;
  source(key: ResearchResumeKey): Promise<ResearchResumeSource | null>;
}>;

const json = (value: unknown) => value as Prisma.InputJsonValue;

const isFailure = (value: unknown): value is Readonly<{ code?: unknown; message?: unknown }> => typeof value === "object" && value !== null;

export function createResearchResumeStore(client: Pick<PrismaClient, "modelRun" | "researchEvidence" | "researchFrame">,
  evidence: Pick<ResearchEvidenceRepository, "chain">): ResearchResumeStore {
  return {
    chain: ({ chatId, runId, userId }) => evidence.chain({ chatId, researchRunId: runId, userId }),
    async interrupted({ chatId, runId, userId }) {
      const run = await client.modelRun.findFirst({ select: { errorPayload: true }, where: { answerCompletedAt: null, chatId, engine: "native", id: runId, status: "error", userId } });
      const failure: unknown = run?.errorPayload;
      if (!isFailure(failure)) return false;
      const { code, message } = failure;
      return continuableRunFailure(typeof code === "string" ? code : null, typeof message === "string" ? message : null) !== null;
    },
    async link({ chatId, runId, userId }, { answer, fromRunId, frame, goal, proposal, releasedAt, version, windowEndsAt }) {
      await client.researchFrame.create({ data: { answer: json(answer), chatId, continuedFromRunId: fromRunId, frame: json(frame), goal, modelRunId: runId, proposal: json(proposal),
        releasedAt, userId, version, windowEndsAt } });
    },
    async recorded({ chatId, userId }, runIds) {
      return await client.researchEvidence.findFirst({ select: { id: true }, where: { chatId, modelRunId: { in: [...runIds] }, userId } }) !== null;
    },
    // The frozen field alone, read in the database: a request holds the whole branch's context, which this never loads.
    async sentWithDeepResearch({ chatId, userId }, runIds) {
      return await client.modelRun.findFirst({ select: { id: true }, where: { chatId, id: { in: [...runIds] },
        normalizedRequest: { equals: true, path: ["deepResearch"] }, subagentTurnId: null, userId } }) !== null;
    },
    source: ({ chatId, runId, userId }) => client.researchFrame.findFirst({ select: { answer: true, frame: true, goal: true, proposal: true, releasedAt: true, version: true, windowEndsAt: true },
      where: { chatId, modelRunId: runId, userId } })
  };
}

/** One port per run (`ResearchPortFactories.resume`). */
export function createResearchResume(deps: Readonly<{ store: ResearchResumeStore }>) {
  return (run: ResearchRunScope): ResearchResumePort => {
    const keyOf = (runId: string): ResearchResumeKey => ({ chatId: run.chatId, runId, userId: run.userId });
    const degraded = (code: string) => logEvent("service_operation", { action: "degrade", code, outcome: "degraded", run_id: run.runId, stage: "read", subsystem: "database" });

    /** The plan and frame a row keeps. A row no writer here could have made picks nothing up: the run starts over rather than on a broken matrix. */
    function decoded(source: ResearchResumeSource): Pick<ResearchResumeState, "answer" | "frame"> | null {
      const answer = decodeResearchPlanAnswer(source.answer);
      const frame = decodeResearchFrame(source.frame);
      if (answer.ok && frame.ok) return { answer: answer.value, frame: frame.value };
      degraded("research_resume_row_invalid");
      return null;
    }

    return {
      async interrupted(signal) {
        signal.throwIfAborted();
        // A Continue answers the branch's last run, as in `load`; an approval continuation is no Continue.
        const last = run.branchRunIds.at(-1);
        return last !== undefined && run.researchRunId === run.runId && await deps.store.interrupted(keyOf(last));
      },

      async sentWithDeepResearch(runIds, signal) {
        signal.throwIfAborted();
        // A stored value: only this branch's runs count, as in `load`.
        const own = runIds.filter((runId) => run.branchRunIds.includes(runId));
        return own.length > 0 && await deps.store.sentWithDeepResearch(keyOf(run.runId), own);
      },

      async load(fromRunId, signal) {
        signal.throwIfAborted();
        // The last run of the branch is the interrupted one; on an approval it is not the run that started the research, which is what `fromRunId` names.
        const interruptedRun = run.branchRunIds.at(-1);
        if (interruptedRun === undefined || !run.branchRunIds.includes(fromRunId) || run.researchRunId !== run.runId) return null;
        if (!await deps.store.interrupted(keyOf(interruptedRun))) return null;
        const source = await deps.store.source(keyOf(fromRunId));
        if (!source || source.releasedAt === null || source.windowEndsAt === null || source.proposal === null) return null;
        const stands = decoded(source);
        if (!stands) return null;
        signal.throwIfAborted();
        const chain = await deps.store.chain(keyOf(fromRunId));
        if (chain.length > RESEARCH_EVIDENCE_LIMITS.continuationChain) {
          degraded("research_continuations_spent");
          return null;
        }
        if (!await deps.store.recorded(keyOf(fromRunId), chain)) return null;
        return { ...stands, fromRunId, goal: source.goal, row: { answer: source.answer, frame: source.frame, proposal: source.proposal, version: source.version, windowEndsAt: source.windowEndsAt } };
      },

      async link({ fromRunId, goal, row }, signal) {
        signal.throwIfAborted();
        // Its phases count from this run.
        await deps.store.link(keyOf(run.runId), { ...row, fromRunId, goal, releasedAt: new Date(run.now()) });
      }
    };
  };
}
