import { describe, expect, it } from "vitest";
import {
  directMcpCallSourceFailures, discoveryUnavailableSources, occurrenceCheckSourcesMissing, occurrenceSourcesIncomplete,
  withCodeCallUnavailableSources
} from "./sourceHealth";

describe("code-call source health", () => {
  it("turns a source the run's code could not use into a relied-on missing source", () => {
    const admitted = [{ name: "Tracker", reason: "mcp_server_unavailable", relied: false, serverId: "server-tracker" }];
    const merged = withCodeCallUnavailableSources(admitted, [
      { authorization: true, serverId: "server-gitlab", serverName: "GitLab" },
      // Already recorded by admission: kept as recorded.
      { authorization: false, serverId: "server-tracker", serverName: "Tracker" },
      { authorization: false, serverId: "not an id", serverName: "Broken" },
      { authorization: false, serverId: "server-wiki", serverName: null }
    ]);
    expect(merged).toEqual([
      ...admitted,
      { name: "GitLab", reason: "mcp_reauthorization_required", relied: true, serverId: "server-gitlab" },
      { name: "MCP server", reason: "mcp_server_unavailable", relied: true, serverId: "server-wiki" }
    ]);
    // A check that reached its source only through code could not check.
    expect(occurrenceCheckSourcesMissing(merged)).toBe(true);
    expect(occurrenceCheckSourcesMissing(withCodeCallUnavailableSources(null, []))).toBe(false);
  });
});

describe("tool-search source health", () => {
  const epoch = (unavailable: unknown) => ({ epoch: 1, goal: "query", modelRunToolCallId: "call", roundIndex: 1, toolIds: [],
    unavailable });

  it("counts a server the run's tool search could not load, unless a later search loaded it", () => {
    const epochs = [
      epoch([{ reason: "mcp_server_unavailable", serverId: "server-tracker" },
        { reason: "mcp_reauthorization_required", serverId: "server-gitlab" }]),
      // Loaded by a later call of the same run: no missing source.
      epoch([{ reason: "mcp_server_unavailable", serverId: "server-wiki" }]),
      epoch([{ reason: "mcp_personal_credential_rejected", serverId: "server-tracker" },
        { reason: "PRIVATE_UPSTREAM_TEXT", serverId: "server-broken" }, { reason: "mcp_plan_too_large", serverId: "not an id" }]),
      { epoch: 4, toolIds: [] }
    ];
    expect(discoveryUnavailableSources(epochs, [{ serverId: "server-wiki" }])).toEqual([
      // A rejected credential on any call asks the owner to sign in.
      { authorization: true, serverId: "server-tracker" },
      { authorization: true, serverId: "server-gitlab" }
    ]);
    const merged = withCodeCallUnavailableSources(null,
      discoveryUnavailableSources(epochs, [{ serverId: "server-wiki" }]).map((source) => ({ ...source, serverName: null })));
    expect(occurrenceCheckSourcesMissing(merged)).toBe(true);
    for (const [value, loaded] of [[null, null], [[], []], ["x", {}], [[epoch("x")], []]] as const) {
      expect(discoveryUnavailableSources(value, loaded)).toEqual([]);
    }
  });
});

describe("direct MCP call source health", () => {
  const call = (serverId: string, state: string, failureReason: string | null = null, serverName: string | null = "GitLab") =>
    ({ failureReason, serverId, serverName, state });

  it("counts a server the model's own calls could not reach, never one it reached or got wrong", () => {
    const failures = directMcpCallSourceFailures([
      // Source failures after the batch's retries: the source itself could not be used.
      call("server-gitlab", "error", "timeout"),
      call("server-gitlab", "error", "authorization"),
      call("server-tracker", "error", "unavailable", "Tracker"),
      call("server-wiki", "error", "server_error", null),
      call("server-drive", "error", "tool_disabled", "Drive"),
      // The check's own mistakes and the tool's own errors (no engine reason): never the source's.
      call("server-mail", "error", "arguments_invalid", "Mail"),
      call("server-mail", "error", "result_too_large", "Mail"),
      call("server-mail", "error", "configuration_changed", "Mail"),
      call("server-mail", "error", "rate_limited", "Mail"),
      call("server-mail", "error", null, "Mail"),
      // A failure beside a successful call of the same server in the same run.
      call("server-calendar", "error", "timeout", "Calendar"),
      call("server-calendar", "complete", null, "Calendar"),
      // Still running or cancelled, and a malformed server id.
      call("server-chat", "running", "timeout", "Chat"),
      call("server-chat", "cancelled", "timeout", "Chat"),
      call("not an id", "error", "timeout", "Broken")
    ]);
    expect(failures).toEqual([
      // A sign-in on any call asks the owner to sign in.
      { authorization: true, serverId: "server-gitlab", serverName: "GitLab" },
      { authorization: false, serverId: "server-tracker", serverName: "Tracker" },
      { authorization: false, serverId: "server-wiki", serverName: null },
      { authorization: false, serverId: "server-drive", serverName: "Drive" }
    ]);
    // A server the run's Workspace code reached is no missing source either.
    expect(directMcpCallSourceFailures([call("server-gitlab", "error", "timeout")], new Set(["server-gitlab"]))).toEqual([]);
    expect(directMcpCallSourceFailures([])).toEqual([]);

    // A relied-on missing source: a check that reported no update could not check.
    const merged = withCodeCallUnavailableSources(null, failures);
    expect(merged[0]).toEqual({ name: "GitLab", reason: "mcp_reauthorization_required", relied: true, serverId: "server-gitlab" });
    expect(merged[2]).toEqual({ name: "MCP server", reason: "mcp_server_unavailable", relied: true, serverId: "server-wiki" });
    expect([occurrenceSourcesIncomplete(merged), occurrenceCheckSourcesMissing(merged)]).toEqual([true, true]);
  });
});

describe("scheduled run source health", () => {
  const source = { name: "Tracker", reason: "mcp_server_unavailable", relied: true, serverId: "server-tracker" };

  it("makes a monitoring check unable to check only when it missed a source a previous result relied on", () => {
    // A relied-on source: the run is incomplete and the check could not check.
    expect([occurrenceSourcesIncomplete([source]), occurrenceCheckSourcesMissing([source])]).toEqual([true, true]);
    // Recorded only because nothing judged relevance yet: incomplete, but the check still counts.
    const unjudged = [{ ...source, relied: false }];
    expect([occurrenceSourcesIncomplete(unjudged), occurrenceCheckSourcesMissing(unjudged)]).toEqual([true, false]);
    // Nothing missing, or a stored value that is not a recorded gap.
    for (const value of [null, [], "[]", [{ ...source, serverId: "not an id" }], [{ ...source, relied: "yes" }]]) {
      expect([occurrenceSourcesIncomplete(value), occurrenceCheckSourcesMissing(value)]).toEqual([false, false]);
    }
  });
});
