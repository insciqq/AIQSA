// @vitest-environment node
import { describe, expect, it } from "vitest";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { BROWSER_HANDOFF_TOOL_NAME, browserHandoffNeededSignIn, executeBrowserHandoff, type BrowserHandoffMode } from "./browserHandoff";

/** A handoff call as an unattended run stores it: its arguments and the result row the tool batch writes. */
async function stored(args: Record<string, unknown>, mode: BrowserHandoffMode = { kind: "unattended" }) {
  const call = { arguments: args, id: "call-1", name: BROWSER_HANDOFF_TOOL_NAME };
  const result = await executeBrowserHandoff(call, mode, new AbortController().signal);
  return { arguments: args, result: snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes) };
}

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
