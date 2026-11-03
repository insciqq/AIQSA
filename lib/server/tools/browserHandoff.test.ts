// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import type { BrowserLiveRunHandle } from "../workspace/browserLive";
import { BROWSER_HANDOFF_TOOL_NAME, BROWSER_HANDOFF_WAIT_MS, browserHandoffNeededSignIn, executeBrowserHandoff, type BrowserHandoffMode } from "./browserHandoff";
import type { ToolExecutionResult } from "./types";

afterEach(() => vi.useRealTimers());

function valueOf(result: ToolExecutionResult) {
  const content = result.content[0];
  if (content?.type !== "json" || typeof content.value !== "object" || content.value === null ||
    !("next" in content.value) || !("outcome" in content.value)) throw new Error("Expected a JSON handoff result.");
  return content.value;
}

describe("a handoff's wait", () => {
  const call = { arguments: { message: "Please sign in to the shop.", reason: "sign_in" }, id: "call-1", name: BROWSER_HANDOFF_TOOL_NAME };
  const page = { title: "Sign in", url: "https://shop.example/login" };

  it("waits until the ordinary limit", async () => {
    vi.useFakeTimers();
    const handoff = vi.fn<BrowserLiveRunHandle["handoff"]>(({ waitMs }) => new Promise((resolve) => {
      setTimeout(() => resolve({ kind: "ended", outcome: "timed_out", page, saved: null }), waitMs);
    }));
    const live = { end: async () => undefined, handoff } satisfies BrowserLiveRunHandle;
    const completed = vi.fn();
    const waiting = executeBrowserHandoff(call, { kind: "interactive", live, toolTimeLeftMs: () => BROWSER_HANDOFF_WAIT_MS,
      researching: () => false }, new AbortController().signal).then((result) => { completed(); return result; });
    const wait = BROWSER_HANDOFF_WAIT_MS;
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = valueOf(await waiting);
    expect(result).toMatchObject({ outcome: "timed_out", page });
    expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ waitMs: wait }));
    expect(result.next).toBe("The user did not finish in time. Look at the page; if the step is still needed, tell the user what is waiting for them and finish with what you have.");
  });

  it("reads whether research started at each call and caps ordinary waits at the remaining time", async () => {
    let researching = false;
    let timeLeft = BROWSER_HANDOFF_WAIT_MS;
    const handoff = vi.fn<BrowserLiveRunHandle["handoff"]>(async () => ({ kind: "ended", outcome: "timed_out", page, saved: null }));
    const mode: BrowserHandoffMode = { kind: "interactive", live: { end: async () => undefined, handoff },
      toolTimeLeftMs: () => timeLeft, researching: () => researching };
    const signal = new AbortController().signal;
    await executeBrowserHandoff(call, mode, signal);
    expect(handoff).toHaveBeenLastCalledWith(expect.objectContaining({ waitMs: BROWSER_HANDOFF_WAIT_MS }));
    researching = true;
    expect(valueOf(await executeBrowserHandoff(call, mode, signal))).toMatchObject({ outcome: "unreachable" });
    expect(handoff).toHaveBeenCalledTimes(1);
    researching = false;
    timeLeft = BROWSER_HANDOFF_WAIT_MS / 2;
    await executeBrowserHandoff(call, mode, signal);
    expect(handoff).toHaveBeenLastCalledWith(expect.objectContaining({ waitMs: timeLeft }));
  });

  it.each([true, false])("returns immediately in research, with no handoff or timer, live browser available: %s", async (available) => {
    vi.useFakeTimers();
    const handoff = vi.fn<BrowserLiveRunHandle["handoff"]>();
    const toolTimeLeftMs = vi.fn(() => 0);
    const result = await executeBrowserHandoff(call, { kind: "interactive", researching: () => true,
      live: available ? { end: async () => undefined, handoff } : null, toolTimeLeftMs }, new AbortController().signal);
    expect(valueOf(result)).toMatchObject({ outcome: "unreachable", next: expect.stringContaining('record_evidence with kind "unreachable"') });
    expect(valueOf(result).next).toContain("Do not open this site again or wait for a person");
    expect(handoff).not.toHaveBeenCalled();
    expect(toolTimeLeftMs).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** A handoff call as an unattended run stores it: its arguments and the result row the tool batch writes. */
async function stored(args: Record<string, unknown>, mode: BrowserHandoffMode = { kind: "unattended" }) {
  const call = { arguments: args, id: "call-1", name: BROWSER_HANDOFF_TOOL_NAME };
  const result = await executeBrowserHandoff(call, mode, new AbortController().signal);
  return { arguments: args, result: snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes) };
}

describe("a handoff's result", () => {
  it("names a site to be saved only when the guest saved one", async () => {
    const call = { arguments: { message: "Pick the delivery slot you want.", reason: "user_choice" }, id: "call-1",
      name: BROWSER_HANDOFF_TOOL_NAME };
    const page = { title: "Delivery", url: "https://shop.example/slots" };
    for (const saved of [null, "shop.example"]) {
      const live = { end: async () => undefined, handoff: async () => ({ kind: "ended" as const, outcome: "completed" as const, page, saved }) };
      const result = await executeBrowserHandoff(call, { kind: "interactive", live, toolTimeLeftMs: () => 3_600_000 },
        new AbortController().signal);
      const value = (result.content[0] as unknown as { value: Record<string, unknown> }).value;
      expect("signInSavedAfterAnswer" in value).toBe(saved !== null);
    }
  });
});

describe("a handoff of one agent", () => {
  const call = { arguments: { message: "Please sign in to the shop.", reason: "sign_in" }, id: "call-1", name: BROWSER_HANDOFF_TOOL_NAME };

  it("asks the live browser for that agent's tab, and the main agent's when none is named", async () => {
    const asked: unknown[] = [];
    const live = { end: async () => undefined, handoff: async (input: { agent?: unknown }) => {
      asked.push(input.agent);
      return { kind: "busy" as const };
    } };
    const shopper = { id: "thread_1", name: "shopper" };
    const busy = await executeBrowserHandoff(call, { agent: shopper, kind: "interactive", live, toolTimeLeftMs: () => 3_600_000 },
      new AbortController().signal);
    await executeBrowserHandoff(call, { kind: "interactive", live, toolTimeLeftMs: () => 3_600_000 }, new AbortController().signal);
    expect(asked).toEqual([shopper, undefined]);
    expect((busy.content[0] as unknown as { value: { error: string } }).value.error).toBe("browser_handoff_busy");
  });

  it("is unavailable for every agent of a Telegram turn or an unattended run", async () => {
    for (const mode of [{ chatUrl: "https://aiqsa.test/c/1", kind: "telegram" as const }, { kind: "unattended" as const }]) {
      const result = await executeBrowserHandoff(call, mode, new AbortController().signal);
      expect((result.content[0] as unknown as { value: { error: string } }).value.error).toBe("browser_handoff_unavailable");
    }
  });
});

describe("a scheduled run's handoff calls", () => {
  it("count as a needed sign-in only for a sign-in, a code or a check nobody could take over", async () => {
    for (const reason of ["sign_in", "verification_code", "captcha"]) {
      expect(browserHandoffNeededSignIn(await stored({ message: "Please sign in.", reason }))).toBe(true);
    }
    for (const reason of ["consent", "user_choice", "other"]) {
      expect(browserHandoffNeededSignIn(await stored({ message: "Please choose.", reason }))).toBe(false);
    }
  });

  it("never count a malformed call, a refused one or one the model corrected", async () => {
    expect(browserHandoffNeededSignIn(await stored({ message: "", reason: "sign_in" }))).toBe(false);
    expect(browserHandoffNeededSignIn(await stored({ message: "Please sign in.", reason: "login" }))).toBe(false);
    // Refused before it ran (a tool this round did not offer): the engine's own refusal.
    expect(browserHandoffNeededSignIn({ arguments: { message: "Please sign in.", reason: "sign_in" },
      result: { callId: "call-1", content: [{ type: "text", text: "tool_not_declared" }], name: BROWSER_HANDOFF_TOOL_NAME,
        status: "error" } })).toBe(false);
    expect(browserHandoffNeededSignIn({ arguments: null, result: null })).toBe(false);
  });
});
