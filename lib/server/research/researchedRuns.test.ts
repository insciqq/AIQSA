import { describe, expect, it, vi } from "vitest";
import { CONTINUE_TURN_TEXT } from "../../contracts/runs";
import { isContinueContent, prismaResearchedRunsReader, RESEARCHED_RUN_TURNS, researchedRuns } from "./researchedRuns";
import { researchDatabase, type StoredTurn } from "./researchedRuns.testFixtures";

/** Which of `asked` researched, over a database of `turns`, and what it cost. */
async function researchedOf(turns: Readonly<Record<string, StoredTurn>>, asked: readonly string[] = Object.keys(turns)) {
  const { client, reads } = researchDatabase(turns);
  const found = await researchedRuns(prismaResearchedRunsReader(client as never, { chatId: "chat", userId: "user" }), asked);
  return { found: [...found].sort(), reads };
}

describe("which runs researched", () => {
  it("counts a run sent with Deep research or with its own frame, and no message of the user's that is no Continue", async () => {
    const { found, reads } = await researchedOf({ chosen: { chosen: true, status: "complete" }, framed: { frame: true, status: "error" },
      after: { previous: "framed", status: "error" } });
    expect(found).toEqual(["chosen", "framed"]);
    // The message after the failed research had to be read once, since only its words tell a Continue.
    expect(reads).toEqual({ continues: 1, rows: 1 });
  });

  it("counts the server's turn after an Allow in a research, whatever its run's own facts, and not one in an ordinary chat", async () => {
    // The research paused for the Allow and its run completed; the approval's run failed on a provider.
    const { found } = await researchedOf({ research: { chosen: true, status: "complete" }, approved: { message: "approval", previous: "research", status: "error" },
      ordinary: { status: "complete" }, ordinaryApproval: { message: "approval", previous: "ordinary", status: "error" } });
    expect(found).toEqual(["approved", "research"]);
  });

  it("counts a Continue of an unfinished research that failed before its own start, through every such Continue", async () => {
    const { found } = await researchedOf({ research: { chosen: true, status: "error" }, first: { message: "continue", previous: "research", status: "error" },
      second: { message: "continue", previous: "first", status: "error" } });
    expect(found).toEqual(["first", "research", "second"]);
  });

  it("never counts a Continue after a research that finished or that the user stopped, nor one after an ordinary failed answer", async () => {
    for (const status of ["complete", "cancelled"] as const) {
      const { found } = await researchedOf({ research: { chosen: true, status }, typed: { message: "continue", previous: "research", status: "error" } });
      expect(found).toEqual(["research"]);
    }
    const published = await researchedOf({ research: { chosen: true, published: true, status: "error" }, typed: { message: "continue", previous: "research", status: "error" } });
    expect(published.found).toEqual(["research"]);
    const ordinary = await researchedOf({ ordinary: { status: "error" }, typed: { message: "continue", previous: "ordinary", status: "error" } });
    expect(ordinary.found).toEqual([]);
    // A wake-up turn is the server's, and goes on from nothing.
    const woken = await researchedOf({ research: { chosen: true, status: "error" }, woken: { message: "callback", previous: "research", status: "error" } });
    expect(woken.found).toEqual(["research"]);
  });

  it("walks back from the runs asked of only as far as a research's turns go, one read a turn", async () => {
    const turns: Record<string, StoredTurn> = { research: { chosen: true, status: "error" }, first: { message: "continue", previous: "research", status: "error" },
      second: { message: "continue", previous: "first", status: "error" } };
    const { found, reads } = await researchedOf(turns, ["second"]);
    expect(found).toEqual(["second"]);
    expect(reads).toEqual({ continues: 1, rows: 3 });
    // An ordinary chat: the turn before finished, so nothing further is read and no words are.
    expect((await researchedOf({ earlier: { status: "complete" }, failed: { previous: "earlier", status: "error" } }, ["failed"])).reads).toEqual({ continues: 0, rows: 2 });
  });

  it("stops at its bound, where a further turn would count for nothing", async () => {
    const turns: Record<string, StoredTurn> = { "run-0": { chosen: true, status: "error" } };
    for (let link = 1; link <= RESEARCHED_RUN_TURNS + 2; link += 1) turns[`run-${link}`] = { message: "continue", previous: `run-${link - 1}`, status: "error" };
    const near = await researchedOf(turns, [`run-${RESEARCHED_RUN_TURNS}`]);
    expect(near.found).toEqual([`run-${RESEARCHED_RUN_TURNS}`]);
    const far = await researchedOf(turns, [`run-${RESEARCHED_RUN_TURNS + 2}`]);
    expect(far.found).toEqual([]);
    expect(far.reads.rows).toBeLessThanOrEqual(RESEARCHED_RUN_TURNS + 1);
  });

  it("asks the database of no message whose words the caller holds", async () => {
    const turns: Record<string, StoredTurn> = { research: { chosen: true, status: "error" }, first: { message: "continue", previous: "research", status: "error" } };
    const { client, reads } = researchDatabase(turns);
    const reader = prismaResearchedRunsReader(client as never, { chatId: "chat", userId: "user" });
    await expect(researchedRuns(reader, ["first"], (id) => id === "q-first")).resolves.toEqual(new Set(["first"]));
    await expect(researchedRuns(reader, ["first"], () => false)).resolves.toEqual(new Set());
    expect(reads.continues).toBe(0);
  });

  it("reads only the main agent's runs of its owner and chat, and another's as none", async () => {
    const { client } = researchDatabase({ research: { chosen: true, status: "error" } });
    const findMany = vi.spyOn(client.modelRun, "findMany");
    await expect(researchedRuns(prismaResearchedRunsReader(client as never, { chatId: "chat", userId: "user" }), ["research"])).resolves.toEqual(new Set(["research"]));
    for (const [args] of findMany.mock.calls) expect(args.where).toMatchObject({ chatId: "chat", id: { in: ["research"] }, subagentTurnId: null, userId: "user" });
    await expect(researchedRuns(prismaResearchedRunsReader(client as never, { chatId: "chat", userId: "stranger" }), ["research"])).resolves.toEqual(new Set());
  });

  it("tells the Continue button's word from any other message", () => {
    expect(isContinueContent({ blocks: [{ text: ` ${CONTINUE_TURN_TEXT} `, type: "text" }] })).toBe(true);
    for (const content of [{ blocks: [{ text: "Continue, but about pillows.", type: "text" }] }, { blocks: [] }, CONTINUE_TURN_TEXT, null]) {
      expect(isContinueContent(content)).toBe(false);
    }
  });
});
