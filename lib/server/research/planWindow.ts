import type { Prisma, PrismaClient } from "@prisma/client";
import {
  decodeResearchPlanAnswer,
  decodeResearchPlanProposal,
  RESEARCH_TIME_MS,
  researchFrameFromPlan,
  researchPlanAnswerDocument,
  researchPlanProposalDocument,
  researchPlanWithEdit,
  type ResearchFrame,
  type ResearchPlanAction,
  type ResearchPlanAnswer,
  type ResearchPlanProposal,
  type ResearchPlanWindowView
} from "../../contracts/research";
import { logEvent } from "../observability";
import type { ResearchPlanWindowPort, ResearchRunScope } from "./ports";

/**
 * The plan window on the server (`agent_docs/RUN_CONTRACTS.md`, Research): `propose_research_plan` waits here while a person
 * may change the plan. The waiting window lives in this process, like the run it belongs to (one application replica), so a
 * route reaches it by the research run's id; its durable record is the run's `ResearchFrame` row, which answers a reload once the
 * window closed. All times are the server's. Nothing here needs a browser: a closed tab changes nothing and the timer releases the plan.
 *
 * A second `open` on a window already answered is how a plan the person changed gets its questions rebuilt: no window opens, the
 * proposal replaces the answer's plan and the call resolves at once. The frame follows only while nobody has changed it.
 */
export const RESEARCH_PLAN_WINDOW_LIMITS = Object.freeze({
  /** How often a waiting window reads what the user wrote: a message in the chat is an edit, and it has no event of its own here. */
  followupPollMs: 2_000,
  /** A lease renews while a person edits, up to this many leases: a tab left renewing cannot spend the turn in the window. */
  holdLeases: 3,
  /**
   * How long before the turn's end a window must have closed. Only the release extends the turn, so past this the deadline would end
   * the run with no plan and no answer. It covers the close's write and the plan's row before the extension; a rebuild of the
   * questions comes after it, on the extended turn.
   */
  releaseReserveMs: 60_000,
  /** The least `cancel_hold` gives back, so a person sees the countdown again before research starts. */
  resumeMinimumMs: 10_000
});

export type ResearchPlanWindowKey = Readonly<{ chatId: string; runId: string; userId: string }>;

export type ResearchPlanWindowRow = Readonly<{ answer: unknown; heldUntil: Date | null; proposal: unknown; windowEndsAt: Date | null }>;

/** The row of `ResearchFrame` a window keeps, always under the owner and chat of its key, and the check a route makes of the chat. */
export type ResearchPlanStore = Readonly<{
  chatOpen(input: Readonly<{ chatId: string; userId: string }>): Promise<boolean>;
  closed(key: ResearchPlanWindowKey, write: Readonly<{ answer: ResearchPlanAnswer; frame: ResearchFrame; releasedAt: Date }>): Promise<void>;
  held(key: ResearchPlanWindowKey, write: Readonly<{ heldUntil: Date | null; windowEndsAt: Date }>): Promise<void>;
  /** Writes the proposal and the window's end; a row already released keeps them and returns its answer in stored form. */
  opened(key: ResearchPlanWindowKey, write: Readonly<{ goal: string; proposal: ResearchPlanProposal; windowEndsAt: Date }>): Promise<unknown>;
  read(key: ResearchPlanWindowKey): Promise<ResearchPlanWindowRow | null>;
  rebuilt(key: ResearchPlanWindowKey, write: Readonly<{ answer: ResearchPlanAnswer; frame: ResearchFrame }>): Promise<void>;
}>;

/** A frame's `version` while nobody changed it (`ResearchCoveragePort`): only then may a rebuilt plan replace it. */
const UNCHANGED_FRAME_VERSION = 1;

const json = (value: unknown) => value as Prisma.InputJsonValue;

export function createResearchPlanStore(client: Pick<PrismaClient, "chat" | "researchFrame">): ResearchPlanStore {
  const row = ({ chatId, runId, userId }: ResearchPlanWindowKey) => ({ chatId, modelRunId: runId, userId });
  return {
    async chatOpen({ chatId, userId }) {
      return await client.chat.findFirst({ select: { id: true }, where: { id: chatId, permanentDeletionAt: null, userId } }) !== null;
    },
    async closed(key, { answer, frame, releasedAt }) {
      await client.researchFrame.updateMany({ data: { answer: json(researchPlanAnswerDocument(answer)), frame: json(frame), heldUntil: null, releasedAt },
        where: { ...row(key), releasedAt: null } });
    },
    async held(key, { heldUntil, windowEndsAt }) {
      await client.researchFrame.updateMany({ data: { heldUntil, windowEndsAt }, where: { ...row(key), releasedAt: null } });
    },
    async opened(key, { goal, proposal, windowEndsAt }) {
      const earlier = await client.researchFrame.findFirst({ select: { answer: true, releasedAt: true }, where: row(key) });
      if (earlier?.releasedAt) return earlier.answer;
      const written = { heldUntil: null, proposal: json(researchPlanProposalDocument(proposal)), windowEndsAt };
      await client.researchFrame.upsert({ create: { ...row(key), goal, ...written }, update: written,
        where: { userId_chatId_modelRunId: { chatId: key.chatId, modelRunId: key.runId, userId: key.userId } } });
      return null;
    },
    read: (key) => client.researchFrame.findFirst({ select: { answer: true, heldUntil: true, proposal: true, windowEndsAt: true }, where: row(key) }),
    async rebuilt(key, { answer, frame }) {
      const document = json(researchPlanAnswerDocument(answer));
      const framed = await client.researchFrame.updateMany({ data: { answer: document, frame: json(frame) },
        where: { ...row(key), releasedAt: { not: null }, version: UNCHANGED_FRAME_VERSION } });
      if (framed.count === 0) await client.researchFrame.updateMany({ data: { answer: document }, where: { ...row(key), releasedAt: { not: null } } });
    }
  };
}

/** One waiting window, as a route reaches it. */
export type ResearchPlanLiveWindow = Readonly<{
  /** `closed`: the window had closed before this action reached it, and nothing changed. */
  act(action: ResearchPlanAction): Promise<"applied" | "closed">;
  key: ResearchPlanWindowKey;
  view(): ResearchPlanWindowView;
}>;

/** The windows waiting in this process, by research run. The key's owner and chat must match, so anyone else finds what a missing one finds. */
export class ResearchPlanWindows {
  readonly #waiting = new Map<string, ResearchPlanLiveWindow>();

  add(window: ResearchPlanLiveWindow): void {
    this.#waiting.set(window.key.runId, window);
  }

  find({ chatId, runId, userId }: ResearchPlanWindowKey): ResearchPlanLiveWindow | null {
    const window = this.#waiting.get(runId);
    return window && window.key.chatId === chatId && window.key.userId === userId ? window : null;
  }

  remove(window: ResearchPlanLiveWindow): void {
    if (this.#waiting.get(window.key.runId) === window) this.#waiting.delete(window.key.runId);
  }
}

const WINDOWS = Symbol.for("aiqsa.research.planWindows.v1");

/** Shared by every server bundle of the process, like the run controllers (`activeRunControllerRegistry.ts`). */
export function researchPlanWindows(): ResearchPlanWindows {
  const shared = globalThis as typeof globalThis & { [WINDOWS]?: ResearchPlanWindows };
  return shared[WINDOWS] ??= new ResearchPlanWindows();
}

const iso = (time: number) => new Date(time).toISOString();

/** A window as its row keeps it: what closed answers a reload, and one that lost its run (Stop, a restart) reads as ended, no time left and no answer. */
export function researchPlanRowView(row: ResearchPlanWindowRow, runId: string, now: number): ResearchPlanWindowView | null {
  const proposal = decodeResearchPlanProposal(row.proposal);
  if (!proposal.ok || row.windowEndsAt === null) return null;
  const answer = row.answer === null ? null : decodeResearchPlanAnswer(row.answer);
  if (answer && !answer.ok) return null;
  return { answer: answer?.value ?? null, heldUntil: null, proposal: proposal.value, runId, serverTime: iso(now), windowEndsAt: iso(Math.min(row.windowEndsAt.getTime(), now)) };
}

export type ResearchPlanWindowDeps = Readonly<{ store: ResearchPlanStore; windows: ResearchPlanWindows }>;

/** The plan port of one run. `run` holds the clock and what the user wrote; the row is the research run's. */
export function createResearchPlanWindow(run: ResearchRunScope, deps: ResearchPlanWindowDeps): ResearchPlanWindowPort {
  const key: ResearchPlanWindowKey = { chatId: run.chatId, runId: run.researchRunId, userId: run.userId };
  /** Bookkeeping never holds the answer: the window goes on in memory, and only a reload loses what a failed write held. */
  const saving = <T>(write: Promise<T>) => write.catch((error: unknown) => {
    logEvent("run_execution", { code: "research_plan_window_unsaved", error, outcome: "failed", run_id: run.runId, stage: "execution" });
    return null;
  });
  let answered: ResearchPlanAnswer | null = null;

  async function rebuild(earlier: ResearchPlanAnswer, proposal: ResearchPlanProposal): Promise<ResearchPlanAnswer> {
    const answer = { ...earlier, plan: proposal };
    answered = answer;
    await saving(deps.store.rebuilt(key, { answer, frame: researchFrameFromPlan(proposal) }));
    return answer;
  }

  return {
    async open({ goal, proposal, signal }) {
      signal.throwIfAborted();
      if (answered) return rebuild(answered, proposal);
      /** The latest this window may stay open, whatever holds it: it closes then as it would for nobody there. */
      const latest = () => run.turnEndsAt() - RESEARCH_PLAN_WINDOW_LIMITS.releaseReserveMs;
      let windowEndsAt = Math.min(run.now() + RESEARCH_TIME_MS.planWindow, latest());
      let heldUntil: number | null = null;
      let firstHoldAt: number | null = null;
      let remaining = 0;
      let closing: ResearchPlanAnswer | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setTimeout> | undefined;
      let settle: (answer: ResearchPlanAnswer) => void = () => undefined;
      let fail: (reason: unknown) => void = () => undefined;
      const waited = new Promise<ResearchPlanAnswer>((resolve, reject) => { settle = resolve; fail = reject; });

      const clear = () => {
        clearTimeout(timer);
        clearTimeout(poll);
        signal.removeEventListener("abort", stopped);
      };
      const stopped = () => {
        clear();
        deps.windows.remove(window);
        fail(signal.reason);
      };
      const close = async (answer: ResearchPlanAnswer): Promise<void> => {
        closing = answer;
        clear();
        await saving(deps.store.closed(key, { answer, frame: researchFrameFromPlan(answer.plan), releasedAt: new Date(run.now()) }));
        answered = answer;
        deps.windows.remove(window);
        settle(answer);
      };
      const unchanged = (releasedBy: ResearchPlanAnswer["releasedBy"]): ResearchPlanAnswer => ({ changed: false, plan: proposal, releasedBy });
      const arm = () => {
        clearTimeout(timer);
        const due = heldUntil ?? windowEndsAt;
        timer = setTimeout(() => {
          if (closing) return;
          if (run.now() < due) arm();
          else void close(unchanged(heldUntil === null ? "timer" : "abandoned_edit"));
        }, Math.max(0, due - run.now()));
        (timer as { unref?: () => void }).unref?.();
      };
      const window: ResearchPlanLiveWindow = {
        async act(action) {
          if (closing) return "closed";
          const now = run.now();
          switch (action.action) {
            case "start":
              await close(unchanged("start_button"));
              break;
            case "save":
              await close({ ...researchPlanWithEdit(proposal, action.edit), releasedBy: "saved_edit" });
              break;
            case "hold":
              if (heldUntil === null) remaining = Math.max(0, windowEndsAt - now);
              firstHoldAt ??= now;
              heldUntil = Math.min(now + RESEARCH_TIME_MS.abandonedEdit, firstHoldAt + RESEARCH_PLAN_WINDOW_LIMITS.holdLeases * RESEARCH_TIME_MS.abandonedEdit, latest());
              arm();
              await saving(deps.store.held(key, { heldUntil: new Date(heldUntil), windowEndsAt: new Date(windowEndsAt) }));
              break;
            case "cancel_hold":
              if (heldUntil === null) break;
              heldUntil = null;
              windowEndsAt = Math.min(now + Math.max(remaining, RESEARCH_PLAN_WINDOW_LIMITS.resumeMinimumMs), latest());
              arm();
              await saving(deps.store.held(key, { heldUntil: null, windowEndsAt: new Date(windowEndsAt) }));
              break;
          }
          return "applied";
        },
        key,
        view: () => ({ answer: closing, heldUntil: heldUntil === null || closing ? null : iso(heldUntil), proposal, runId: key.runId, serverTime: iso(run.now()),
          windowEndsAt: iso(windowEndsAt) })
      };

      // Before the first wait, so a route finds the window as soon as the answer's activity shows its card.
      deps.windows.add(window);
      signal.addEventListener("abort", stopped, { once: true });
      const earlier = await saving(deps.store.opened(key, { goal, proposal, windowEndsAt: new Date(windowEndsAt) }));
      const stored = earlier === null || earlier === undefined ? null : decodeResearchPlanAnswer(earlier);
      if (stored?.ok) {
        // An approval continuation's new port, on a window its turn already answered.
        closing = stored.value;
        clear();
        deps.windows.remove(window);
        return rebuild(stored.value, proposal);
      }
      if (!closing && !signal.aborted) arm();

      // What was there when the window opened reaches the model anyway; only what comes later is an edit of this plan.
      let known: ReadonlySet<string> | null = null;
      const read = async (): Promise<void> => {
        const written = await run.userFollowups().catch(() => null);
        if (closing || signal.aborted) return;
        if (written && known === null) known = new Set(written.map((entry) => entry.id));
        else if (written?.some((entry) => !known?.has(entry.id))) return close(unchanged("chat_message"));
        poll = setTimeout(() => void read(), RESEARCH_PLAN_WINDOW_LIMITS.followupPollMs);
        (poll as { unref?: () => void }).unref?.();
      };
      void read();
      return waited;
    }
  };
}
