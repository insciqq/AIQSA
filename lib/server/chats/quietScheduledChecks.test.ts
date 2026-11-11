import { describe, expect, it, vi } from "vitest";
import { loadQuietCheckTurnIds, quietCheckStandIn, quietPathStandIn, type QuietCheckMessage } from "./quietScheduledChecks";

type Run = Readonly<{ createdAt: number; id: string; scheduledOccurrenceId: string | null; scheduledOutcome: string | null;
  userMessageId: string }>;

/** The run reads the rule makes, over `runs` of chat `chat-1`. */
function fakeRuns(runs: readonly Run[]) {
  const findMany = vi.fn(async (args: { where: { id?: { in: string[] }; scheduledOutcome?: string; userMessageId?: { in: string[] } } }) => {
    const { where } = args;
    return [...runs].sort((left, right) => left.createdAt - right.createdAt).filter((run) => run.scheduledOccurrenceId !== null &&
      (!where.userMessageId || where.userMessageId.in.includes(run.userMessageId)) && (!where.id || where.id.in.includes(run.id)) &&
      (where.scheduledOutcome === undefined || run.scheduledOutcome === where.scheduledOutcome));
  });
  return { modelRun: { findMany } };
}

const message = (id: string, parentMessageId: string | null, role: "assistant" | "user", extra: Partial<QuietCheckMessage> = {}):
  QuietCheckMessage => ({ branchSourceModelRunId: null, id, parentMessageId, role, scheduledTaskPrompt: false, ...extra });
const turn = (id: string, parentMessageId: string | null) => message(id, parentMessageId, "user", { scheduledTaskPrompt: true });
const run = (userMessageId: string, scheduledOutcome: string | null, createdAt = 0, id = `run-${userMessageId}`): Run =>
  ({ createdAt, id, scheduledOccurrenceId: `occ-${id}`, scheduledOutcome, userMessageId });

describe("loadQuietCheckTurnIds", () => {
  it("reads nothing for messages without a scheduled turn", async () => {
    const db = fakeRuns([]);
    expect(await loadQuietCheckTurnIds(db as never, "chat-1", [message("m", null, "user"), message("a", "m", "assistant")])).toEqual(new Set());
    expect(db.modelRun.findMany).not.toHaveBeenCalled();
  });

  it("marks a turn whose first scheduled run settled no_update, whatever its occurrence history keeps", async () => {
    const db = fakeRuns([run("q1", "no_update"), run("u", "update"), run("p", null), run("r", "update", 1, "late"),
      run("r", "no_update", 0, "first")]);
    const messages = [turn("q1", null), message("q1-a", "q1", "assistant"), turn("u", "q1-a"), message("u-a", "u", "assistant"),
      turn("p", "u-a"), turn("r", "p"), message("plain", "r", "user", { scheduledTaskPrompt: false })];
    expect(await loadQuietCheckTurnIds(db as never, "chat-1", messages)).toEqual(new Set(["q1", "r"]));
    expect(db.modelRun.findMany).toHaveBeenCalledTimes(1);
  });

  it("reads a branch copy's turn through its answer's source run", async () => {
    const db = fakeRuns([run("source-q", "no_update", 0, "source-run"), run("source-u", "update", 0, "source-update")]);
    const messages = [turn("copy-q", null), message("copy-a", "copy-q", "assistant", { branchSourceModelRunId: "source-run" }),
      turn("copy-u", "copy-a"), message("copy-u-a", "copy-u", "assistant", { branchSourceModelRunId: "source-update" })];
    expect(await loadQuietCheckTurnIds(db as never, "chat-1", messages)).toEqual(new Set(["copy-q"]));
    expect(db.modelRun.findMany).toHaveBeenCalledTimes(2);
  });
});

describe("quietPathStandIn", () => {
  const path = [message("m", null, "user"), message("m-a", "m", "assistant"), turn("q1", "m-a"), message("q1-a", "q1", "assistant"),
    turn("q2", "q1-a"), message("q2-a", "q2", "assistant")];

  it("reads nothing for a path that ends outside a scheduled turn", async () => {
    const db = fakeRuns([]);
    expect(await quietPathStandIn(db as never, "chat-1", path.slice(0, 2))).toBe("m-a");
    expect(await quietPathStandIn(db as never, "chat-1", [])).toBeNull();
    expect(db.modelRun.findMany).not.toHaveBeenCalled();
  });

  it("stands a quiet tail in for the message before it, and a shown check for itself", async () => {
    expect(await quietPathStandIn(fakeRuns([run("q1", "no_update"), run("q2", "no_update")]) as never, "chat-1", path)).toBe("m-a");
    expect(await quietPathStandIn(fakeRuns([run("q1", "update"), run("q2", "no_update")]) as never, "chat-1", path)).toBe("q1-a");
    expect(await quietPathStandIn(fakeRuns([run("q1", "no_update"), run("q2", null)]) as never, "chat-1", path)).toBe("q2-a");
    // Only quiet checks lead to the root: nothing stands in.
    const rootless = [turn("q1", null), ...path.slice(3)];
    expect(await quietPathStandIn(fakeRuns([run("q1", "no_update"), run("q2", "no_update")]) as never, "chat-1", rootless)).toBeNull();
  });
});

describe("quietCheckStandIn", () => {
  it("costs one read for a message outside any scheduled turn", async () => {
    const queryRaw = vi.fn();
    const findFirst = vi.fn(async () => ({ parent: { role: "user", scheduledTaskPrompt: false }, role: "assistant",
      scheduledTaskPrompt: false }));
    const db = { ...fakeRuns([]), $queryRaw: queryRaw, message: { findFirst } };
    expect(await quietCheckStandIn(db as never, "chat-1", "answer")).toBe("answer");
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("walks the stored path of a check's answer to what a reader sees", async () => {
    const stored = [message("m", null, "user"), message("m-a", "m", "assistant"), turn("q1", "m-a"), message("q1-a", "q1", "assistant")];
    const db = { ...fakeRuns([run("q1", "no_update")]), $queryRaw: vi.fn(async () => stored),
      message: { findFirst: vi.fn(async () => ({ parent: { role: "user", scheduledTaskPrompt: true }, role: "assistant",
        scheduledTaskPrompt: false })) } };
    expect(await quietCheckStandIn(db as never, "chat-1", "q1-a")).toBe("m-a");
  });
});
