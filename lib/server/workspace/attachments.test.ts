import { describe, expect, it } from "vitest";
import { withWorkspaceSessionExclusive } from "./attachments";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

describe("exclusive Workspace lifecycle steps", () => {
  it("keeps a step exclusive when a queued waiter gives up meanwhile", async () => {
    const session = `session-${Math.random()}`;
    const entered: string[] = [];
    const held = gate();
    const first = withWorkspaceSessionExclusive(session, undefined, async () => { entered.push("first"); await held.opened; });
    const cancel = new AbortController();
    const second = withWorkspaceSessionExclusive(session, cancel.signal, async () => { entered.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The last waiter gives up while the first one holds the step; only then does a third caller come.
    cancel.abort(new Error("gave up"));
    await expect(second).rejects.toThrow("gave up");
    const third = withWorkspaceSessionExclusive(session, undefined, async () => { entered.push("third"); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The third caller still waits for the first one's step, though the second one left the queue.
    expect(entered).toEqual(["first"]);
    held.open();
    await Promise.all([first, third]);
    expect(entered).toEqual(["first", "third"]);
    // Afterwards the session's queue is free again.
    await withWorkspaceSessionExclusive(session, undefined, async () => { entered.push("fourth"); });
    expect(entered).toEqual(["first", "third", "fourth"]);
  });
});
