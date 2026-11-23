// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { browserSignInSaveFiles, completedSignInFile, serverWrittenBrowserTurn } from "./browserSignInAuthority";

const turn = (message: Readonly<{ scheduledTaskPrompt?: boolean; systemTurnKind?: string }> = {}, scheduledTaskId: string | null = null) => ({
  scheduledTaskId, userMessage: { scheduledTaskPrompt: message.scheduledTaskPrompt ?? false, systemTurnKind: message.systemTurnKind ?? null }
});

function handoff(reason: string, value: Readonly<Record<string, unknown>>, state = "complete") {
  return { arguments: { message: "Please sign in, then press Done.", reason }, state,
    result: { callId: "call-1", content: [{ type: "json", value }], name: "browser_handoff", status: "complete" } };
}

const done = { next: "Look at the page.", outcome: "completed", page: { title: "Mail", url: "https://mail.example.com/" },
  signInSavedAfterAnswer: "example.com" };

describe("whose turn may save a browser sign-in", () => {
  it("leaves the user's own turn as it was, a Telegram or Discord message included", () => {
    expect(serverWrittenBrowserTurn(turn())).toBe(false);
  });

  // Operator decision 2026-11-23: every turn the server wrote, the continuation after the user's MCP Allow included.
  it.each([
    ["a sub-agent wake-up", turn({ systemTurnKind: "subagent_callback" })],
    ["a Sign in again request", turn({ systemTurnKind: "browser_sign_in_request" })],
    ["the continuation after an MCP Allow", turn({ systemTurnKind: "mcp_approval_continuation" })],
    ["a continued chat's summary prompt", turn({ systemTurnKind: "conversation_summary" })],
    ["a scheduled task's prompt, a branch copy's included", turn({ scheduledTaskPrompt: true })],
    ["a scheduled occurrence", turn({}, "task-1")]
  ])("counts %s as the server's", (_name, value) => {
    expect(serverWrittenBrowserTurn(value)).toBe(true);
  });
});

describe("the sign-in a stored handoff shows the user finishing", () => {
  it("names the file a sign-in handoff's Done saved", () => {
    expect(completedSignInFile(handoff("sign_in", done))).toBe("example.com.json");
  });

  it.each([
    ["another reason, whose Done may follow a sign-in the agent made", handoff("captcha", done)],
    ["a consent", handoff("consent", done)],
    ["Cancel", handoff("sign_in", { ...done, outcome: "cancelled" })],
    ["nobody came", handoff("sign_in", { ...done, outcome: "not_answered" })],
    ["a reply in the chat", handoff("sign_in", { ...done, outcome: "replied" })],
    ["a Done that saved nothing", handoff("sign_in", { ...done, signInSavedAfterAnswer: undefined })],
    ["an empty name", handoff("sign_in", { ...done, signInSavedAfterAnswer: "" })],
    ["a refused call", handoff("sign_in", { error: "browser_handoff_unavailable", signInSavedAfterAnswer: "example.com" }, "error")],
    ["a call still running", { ...handoff("sign_in", done), state: "running" }],
    ["no result", { arguments: { reason: "sign_in" }, result: null, state: "complete" }],
    ["malformed arguments", { ...handoff("sign_in", done), arguments: "sign_in" }]
  ])("names none for %s", (_name, call) => {
    expect(completedSignInFile(call)).toBeNull();
  });

  it("reads only the run's own finished sign-in handoffs from its stored calls", async () => {
    const findMany = vi.fn(async (_query: unknown) => [handoff("sign_in", done),
      handoff("sign_in", { ...done, signInSavedAfterAnswer: "shop.example" }), handoff("sign_in", { ...done, outcome: "cancelled" })]);
    expect(await browserSignInSaveFiles({ modelRunToolCall: { findMany } } as never, "run-1"))
      .toEqual(new Set(["example.com.json", "shop.example.json"]));
    expect(findMany).toHaveBeenCalledWith({ select: { arguments: true, result: true, state: true }, where: {
      arguments: { equals: "sign_in", path: ["reason"] }, modelRunId: "run-1", state: "complete", toolName: "browser_handoff" } });
  });
});
