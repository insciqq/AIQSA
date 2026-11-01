import { RESEARCH_TIME_MS, researchPhaseAt } from "../../contracts/research";
import { isActiveSubagentState, MAIN_AGENT_NAME } from "../../contracts/subagents";
import { SubagentTimeEnded } from "../engine/subagents/runner";
import { logEvent } from "../observability";
import type { ResearchRunScope, ResearchTimePort } from "./ports";

/** Why no researcher may start from `stopStartingResearchers` on, for the model to read. */
export const RESEARCHERS_CLOSED = "Research has no time left for new researchers, so none started. Hand in the report with what the researchers found.";

const LEFT_MINUTES = (RESEARCH_TIME_MS.stopRunningResearchers - RESEARCH_TIME_MS.stopStartingResearchers) / 60_000;

/** What a running researcher is told at `stopStartingResearchers`: untrusted data like any message, and it authorizes nothing. */
export const RESEARCHERS_FINISH = `Research is ending: you will be stopped in ${LEFT_MINUTES} minutes. Finish what you are doing, record what you found and report now.`;

const unref = (timer: ReturnType<typeof setTimeout>) => (timer as { unref?: () => void }).unref?.();

/**
 * The clock of one run's research: its phases count from the plan's release, which also moves the turn's end to the
 * hard end (`extendTurn`). Before the release a research run is an ordinary turn, and nothing here applies to it but a
 * researcher's own limit.
 *
 * What each phase does happens elsewhere, and this only answers when. Minute 60 closes researchers (`researcherRefusal`)
 * and tells the running ones to finish. Minute 70 ends those still running through the signal they run under, and `run.ts`
 * turns that into a result the main agent can use. The main agent's tools close at the same moment (`researchToolTimes`), so
 * its next round offers only the reserved draft. Minute 85 ends the gates (`gatesEndAt`): what did not pass goes out with a
 * note, and the turn's end at minute 90 leaves publication its reserve.
 *
 * The port has no end, so a timer still pending when the run ended fires into nothing: no researcher runs then, and `run.ts`
 * lists only the ones that do. It holds the run's closures until then.
 */
export function createResearchClock(run: ResearchRunScope): ResearchTimePort {
  let releasedAt: number | null = null;
  /** Ends every researcher at `stopRunningResearchers`, those that started before the release in its batch too. */
  const stopRunning = new AbortController();

  const sinceRelease = () => releasedAt === null ? null : run.now() - releasedAt;

  /** A message that cannot be delivered costs that researcher its warning, never the run: minute 70 still ends it. */
  async function tellResearchersToFinish(): Promise<void> {
    const { mailbox } = run;
    if (!mailbox) return;
    const scope = { chatId: run.chatId, parentRunId: run.runId, userId: run.userId };
    try {
      const listing = await mailbox.agents(scope);
      await Promise.all((listing?.agents ?? []).filter((agent) => isActiveSubagentState(agent.state)).map((agent) =>
        mailbox.send({ ...scope, from: MAIN_AGENT_NAME, nonce: `research-finish:${agent.name}`, text: RESEARCHERS_FINISH, to: agent.name })));
    } catch (error) {
      logEvent("run_execution", { code: "research_finish_undelivered", error, outcome: "failed", run_id: run.runId, stage: "execution" });
    }
  }

  return {
    gatesEndAt: (turnGatesEndAt) => releasedAt === null ? turnGatesEndAt : releasedAt + RESEARCH_TIME_MS.notes,

    /** Before the release, `scoping`: the plan window is the window port's, and this clock does not see it open. */
    phase() {
      const since = sinceRelease();
      return since === null ? "scoping" : researchPhaseAt(since);
    },

    planReleased() {
      if (releasedAt !== null) return;
      releasedAt = run.now();
      run.extendTurn(releasedAt + RESEARCH_TIME_MS.hardEnd);
      unref(setTimeout(() => void tellResearchersToFinish(), RESEARCH_TIME_MS.stopStartingResearchers));
      unref(setTimeout(() => stopRunning.abort(new SubagentTimeEnded()), RESEARCH_TIME_MS.stopRunningResearchers));
    },

    researcherRefusal() {
      const since = sinceRelease();
      return since !== null && since >= RESEARCH_TIME_MS.stopStartingResearchers ? RESEARCHERS_CLOSED : null;
    },

    researcherSignal(signal) {
      const own = new AbortController();
      const timer = setTimeout(() => own.abort(new SubagentTimeEnded()), RESEARCH_TIME_MS.researcherTurn);
      unref(timer);
      signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      return AbortSignal.any([signal, own.signal, stopRunning.signal]);
    }
  };
}
