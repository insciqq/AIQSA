// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_REFUSED_REVISIONS_LIMIT, browserSessionHoldsOnlySite, browserSignInSaveAllowed, browserSignInSaveFiles, completedSignInFile,
  nextRefusedBrowserRevisions, refusedBrowserRevisions, serverWrittenBrowserTurn
} from "./browserSignInAuthority";

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

const state = (cookies: readonly string[], origins: readonly string[] = []) => new TextEncoder().encode(JSON.stringify({
  cookies: cookies.map((domain) => ({ domain, expires: -1, httpOnly: true, name: "session", path: "/", sameSite: "Lax", secure: true,
    value: "synthetic" })),
  origins: origins.map((origin) => ({ localStorage: [], origin }))
}));

describe("a sign-in file of one site", () => {
  it("holds the site alone with its own names and their origins", () => {
    expect(browserSessionHoldsOnlySite(state(["example.com", ".example.com", "mail.example.com", "WWW.Example.com."],
      ["https://example.com", "https://accounts.example.com:8443"]), "example.com")).toBe(true);
    expect(browserSessionHoldsOnlySite(state([]), "example.com")).toBe(true);
  });

  // The guest names a file after the host a sign-in began on, while the site keeps its sign-in cookies on the parent.
  it("holds the site's whole registrable domain, a file named after a subdomain included", () => {
    expect(browserSessionHoldsOnlySite(state([".google.com", "accounts.google.com"], ["https://accounts.google.com"]),
      "accounts.google.com")).toBe(true);
    expect(browserSessionHoldsOnlySite(state([".news.bbc.co.uk", ".bbc.co.uk"]), "news.bbc.co.uk")).toBe(true);
    // A private suffix keeps one tenant apart from another.
    expect(browserSessionHoldsOnlySite(state(["alice.github.io"]), "alice.github.io")).toBe(true);
    // An address has no registrable domain: only its own name.
    expect(browserSessionHoldsOnlySite(state(["192.168.1.10"]), "192.168.1.10")).toBe(true);
  });

  it.each([
    ["another site's cookie", state(["example.com", "bank.example"]), "example.com"],
    ["another site's origin", state(["example.com"], ["https://bank.example"]), "example.com"],
    ["a name that only ends like the site", state(["notexample.com"]), "example.com"],
    ["another registrable domain beside the parent's cookie", state([".google.com", ".bank.example"]), "accounts.google.com"],
    ["a public suffix", state(["example.com", ".com"]), "example.com"],
    ["another tenant of a private suffix", state(["alice.github.io", "mallory.github.io"]), "alice.github.io"],
    ["another address", state(["192.168.1.10", "192.168.1.11"]), "192.168.1.10"]
  ])("holds more than the site with %s", (_name, bytes, site) => {
    expect(browserSessionHoldsOnlySite(bytes, site)).toBe(false);
  });

  it("reads nothing alone from a file that is no storage state", () => {
    expect(browserSessionHoldsOnlySite(new TextEncoder().encode("not JSON"), "example.com")).toBe(false);
    expect(browserSessionHoldsOnlySite(new TextEncoder().encode(JSON.stringify({ cookies: [] })), "example.com")).toBe(false);
  });

  it("lets a finished sign-in save its own file of its site alone, nothing else", () => {
    const finished = new Set(["example.com.json"]);
    expect(browserSignInSaveAllowed(finished, { bytes: state(["example.com"]), fileName: "example.com.json" })).toBe(true);
    expect(browserSignInSaveAllowed(finished, { bytes: state(["example.com", "bank.example"]), fileName: "example.com.json" })).toBe(false);
    expect(browserSignInSaveAllowed(finished, { bytes: state(["bank.example"]), fileName: "bank.example.json" })).toBe(false);
    expect(browserSignInSaveAllowed(new Set(), { bytes: state(["example.com"]), fileName: "example.com.json" })).toBe(false);
  });
});

describe("the revisions a Workspace session keeps refused", () => {
  const digest = (value: string) => value.repeat(64);

  it("reads the stored list, and anything malformed as none", () => {
    expect(refusedBrowserRevisions([["a.json", digest("a")], ["b.json", digest("b")]]))
      .toEqual(new Map([["a.json", digest("a")], ["b.json", digest("b")]]));
    for (const value of [null, {}, "a", [["a.json"]], [["a.json", "not-a-digest"]], [[1, digest("a")]]]) {
      expect(refusedBrowserRevisions(value)).toEqual(new Map());
    }
  });

  it("keeps one revision per file, the newest last, within its bound, and drops a file that saved", () => {
    const current = refusedBrowserRevisions([["a.json", digest("a")], ["b.json", digest("b")]]);
    expect(nextRefusedBrowserRevisions(current, "a.json", digest("c"))).toEqual([["b.json", digest("b")], ["a.json", digest("c")]]);
    expect(nextRefusedBrowserRevisions(current, "a.json", null)).toEqual([["b.json", digest("b")]]);
    expect(nextRefusedBrowserRevisions(refusedBrowserRevisions([["a.json", digest("a")]]), "a.json", null)).toBeNull();
    const full = new Map(Array.from({ length: BROWSER_REFUSED_REVISIONS_LIMIT }, (_, index) => [`s${index}.json`, digest("a")] as const));
    const next = nextRefusedBrowserRevisions(full, "new.json", digest("b"))!;
    expect(next).toHaveLength(BROWSER_REFUSED_REVISIONS_LIMIT);
    expect(next[0]![0]).toBe("s1.json");
    expect(next.at(-1)).toEqual(["new.json", digest("b")]);
  });

  // A file still on the disk is collected and refused again by each later run: it must not age out under the bound.
  it("moves a revision refused again to the newest place, so newer refusals drop only revisions nobody collects", () => {
    const full = new Map(Array.from({ length: BROWSER_REFUSED_REVISIONS_LIMIT }, (_, index) => [`s${index}.json`, digest("a")] as const));
    const refreshed = nextRefusedBrowserRevisions(full, "s0.json", digest("a"))!;
    expect(refreshed).toHaveLength(BROWSER_REFUSED_REVISIONS_LIMIT);
    expect(refreshed[0]![0]).toBe("s1.json");
    expect(refreshed.at(-1)).toEqual(["s0.json", digest("a")]);
    const after = nextRefusedBrowserRevisions(refusedBrowserRevisions(refreshed), "new.json", digest("b"))!;
    expect(after.map(([name]) => name)).toContain("s0.json");
    expect(after.map(([name]) => name)).not.toContain("s1.json");
  });
});
