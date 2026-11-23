// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { browserSignInSaveFiles, completedSignInFile, serverWrittenBrowserTurn } from "./browserSignInAuthority";

/** A run's stored turn whose chain, current turn first, the fake database reads (`storedUserRequest`). */
function stored(chain: readonly Readonly<{ scheduledTaskPrompt: boolean; systemTurnKind: string | null }>[],
  scheduledTaskId: string | null = null) {
  const $queryRaw = vi.fn(async (..._query: unknown[]) => chain);
  return { $queryRaw, tx: { $queryRaw } as never, turn: { scheduledTaskId, userId: "user-1", userMessageId: "message-1" } };
}

const own = { scheduledTaskPrompt: false, systemTurnKind: null };
const allow = { scheduledTaskPrompt: false, systemTurnKind: "mcp_approval_continuation" };
const kind = (systemTurnKind: string) => ({ scheduledTaskPrompt: false, systemTurnKind });

function handoff(reason: string, value: Readonly<Record<string, unknown>>, state = "complete") {
  return { arguments: { message: "Please sign in, then press Done.", reason }, state,
    result: { callId: "call-1", content: [{ type: "json", value }], name: "browser_handoff", status: "complete" } };
}

const done = { next: "Look at the page.", outcome: "completed", page: { title: "Mail", url: "https://mail.example.com/" },
  signInSavedAfterAnswer: "example.com" };

describe("whose turn may save a browser sign-in", () => {
  // The user's own turn saves as before, a Telegram or Discord message included, and so does the turn after an MCP Allow
  // of it: that continuation has exactly the authority of the turn whose call the user allowed.
  it.each([
    ["the user's own message", [own]],
    ["the turn after an Allow of the user's own turn", [allow, own]],
    ["a continuation of a continuation of the user's own turn", [allow, allow, own]]
  ])("leaves %s the user's", async (_name, chain) => {
    const { $queryRaw, tx, turn } = stored(chain);
    expect(await serverWrittenBrowserTurn(tx, turn)).toBe(false);
    // The chain of the run's own message, read as the run's user.
    expect(($queryRaw.mock.calls[0] as unknown[]).slice(1, 4)).toEqual(["message-1", "user-1", "user-1"]);
  });

  // Operator decision 2026-11-23: every turn the server wrote, and an Allow's continuation of one.
  it.each([
    ["a sub-agent wake-up", [kind("subagent_callback")]],
    ["a Sign in again request", [kind("browser_sign_in_request")]],
    ["a continued chat's summary prompt", [kind("conversation_summary")]],
    ["a scheduled task's prompt, a branch copy's included", [{ scheduledTaskPrompt: true, systemTurnKind: null }]],
    ["the turn after an Allow of a wake-up's call", [allow, kind("subagent_callback")]],
    ["the turn after an Allow of a sign-in request's call", [allow, kind("browser_sign_in_request")]],
    ["a continuation whose link is missing, as in a branch copy", [allow]],
    ["a missing message", []]
  ])("counts %s as the server's", async (_name, chain) => {
    const { tx, turn } = stored(chain);
    expect(await serverWrittenBrowserTurn(tx, turn)).toBe(true);
  });

  it("counts a scheduled occurrence as the server's without reading its chain", async () => {
    const { $queryRaw, tx, turn } = stored([own], "task-1");
    expect(await serverWrittenBrowserTurn(tx, turn)).toBe(true);
    expect($queryRaw).not.toHaveBeenCalled();
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
