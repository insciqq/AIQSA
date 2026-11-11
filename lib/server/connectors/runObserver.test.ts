import { describe, expect, it, vi } from "vitest";
import type { ConnectorRunStreamEvent } from "./runEvents";
import { followConnectorRunEvents } from "./runObserver";

async function* events(list: readonly ConnectorRunStreamEvent[]): AsyncGenerator<ConnectorRunStreamEvent> {
  yield* list;
}

describe("following a connector's run events", () => {
  it("publishes each event first, grows the answer text, restarts it on a reset and stops at the terminal event", async () => {
    const order: string[] = [];
    const settled = await followConnectorRunEvents(events([
      { delta: "Hel", type: "answerDelta" }, { delta: "lo", type: "answerDelta" }, { type: "answerReset" }, { delta: "Hi", type: "answerDelta" },
      { status: "complete", type: "done" }, { delta: "never read", type: "answerDelta" }
    ]), {
      onReset: () => { order.push("reset"); },
      onText: (text) => { order.push(`text:${text}`); },
      publish: async (event) => { order.push(event.type); }
    });
    expect(settled).toBe(true);
    expect(order).toEqual(["answerDelta", "text:Hel", "answerDelta", "text:Hello", "answerReset", "reset", "answerDelta", "text:Hi", "done"]);
  });

  it("reports a run whose events ended before it settled, so the connector's recovery delivers it", async () => {
    const publish = vi.fn(async () => undefined);
    await expect(followConnectorRunEvents(events([{ status: "queued", type: "preparing" }]), { publish })).resolves.toBe(false);
    expect(publish).toHaveBeenCalledOnce();
  });
});
