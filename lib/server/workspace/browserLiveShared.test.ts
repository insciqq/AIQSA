// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BrowserLiveChannelRequest } from "./browserLive";
import { BrowserLiveRelay } from "./browserLive";
import { fakeLiveGuest, recordingWriter, until } from "./browserLive.testFixtures";

const owner = { authSessionId: "session-1", userId: "user-1" };

/** One guest, reached through each run's own channel, as the runtime serves a streamer only to its starting run. */
function sharedGuest() {
  const guest = fakeLiveGuest();
  const calls: Array<Readonly<{ action: string; runId: string }>> = [];
  const channel = (runId: string) => (request: BrowserLiveChannelRequest) => {
    calls.push({ action: request.action, runId });
    return guest.channel(request);
  };
  return { calls, channel, guest };
}

describe("browser live channel of a shared Workspace", () => {
  it("keeps the session's views across one run's end and closes them with the last run", async () => {
    const { calls, channel, guest } = sharedGuest();
    const relay = new BrowserLiveRelay();
    const registration = (runId: string) => ({ channel: channel(runId), chatId: "chat-1", runId,
      signInRemembered: async () => false, userId: "user-1" });
    const main = relay.register(registration("run-main"));
    const tab = recordingWriter();
    expect(await relay.find("chat-1", "user-1")!.watch(owner, tab.writer)).not.toBeNull();
    await until(() => tab.of("frame").length === 1);
    // A sub-agent run of the same chat joins the open channel instead of ending its views.
    const subagent = relay.register(registration("run-subagent"));
    expect(tab.closed()).toBeUndefined();

    await main.end("run_finished");
    // The streamer the main run started is replaced through the sub-agent run, then closed through its own run.
    expect(tab.closed()).toBeUndefined();
    expect(calls).toContainEqual({ action: "start", runId: "run-subagent" });
    expect(calls).toContainEqual({ action: "close", runId: "run-main" });
    const ended = calls.length;
    const before = tab.of("frame").length;
    guest.frame();
    await until(() => tab.of("frame").length > before);
    // Once the main run left, nothing reaches the guest through its channel any more.
    expect(calls.slice(ended).every((call) => call.runId === "run-subagent")).toBe(true);
    expect(relay.find("chat-1", "user-1")).not.toBeNull();

    await subagent.end("run_finished");
    expect(tab.closed()).toEqual({ data: { reason: "run_finished" }, event: "end" });
    expect(relay.find("chat-1", "user-1")).toBeNull();
    expect(guest.open()).toBe(0);
  });

  it("drops a member whose run is gone without ending, so the last live run still closes the channel", async () => {
    const { channel } = sharedGuest();
    const relay = new BrowserLiveRelay();
    let crashedHolds = true;
    relay.register({ attached: async () => crashedHolds, channel: channel("run-crashed"), chatId: "chat-1", runId: "run-crashed",
      signInRemembered: async () => false, userId: "user-1" });
    const live = relay.register({ attached: async () => true, channel: channel("run-live"), chatId: "chat-1", runId: "run-live",
      signInRemembered: async () => false, userId: "user-1" });
    const tab = recordingWriter();
    await relay.find("chat-1", "user-1")!.watch(owner, tab.writer);
    // The crashed run never calls `end`; it no longer holds the Workspace.
    crashedHolds = false;
    await live.end("run_finished");
    expect(tab.closed()).toEqual({ data: { reason: "run_finished" }, event: "end" });
    expect(relay.find("chat-1", "user-1")).toBeNull();
  });

  it("ends every run's view at once when the browser itself stopped", async () => {
    const { channel } = sharedGuest();
    const relay = new BrowserLiveRelay();
    const first = relay.register({ channel: channel("run-1"), chatId: "chat-1", runId: "run-1", signInRemembered: async () => false,
      userId: "user-1" });
    const second = relay.register({ channel: channel("run-2"), chatId: "chat-1", runId: "run-2", signInRemembered: async () => false,
      userId: "user-1" });
    const tab = recordingWriter();
    await relay.find("chat-1", "user-1")!.watch(owner, tab.writer);
    await first.end("browser_stopped");
    expect(tab.closed()).toEqual({ data: { reason: "browser_stopped" }, event: "end" });
    expect(relay.find("chat-1", "user-1")).toBeNull();
    await second.end("run_finished");
  });
});
