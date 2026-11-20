// @vitest-environment node
import { describe, expect, it } from "vitest";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { BROWSER_HANDOFF_TOOL_NAME, executeBrowserHandoff } from "../tools/browserHandoff";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { runBrowserSignIn } from "./browserSignIn";
import { runNeededBrowserSignIn } from "./runnerStore";

type Row = Readonly<{ arguments: Record<string, unknown>; result: unknown; startedAt: Date; subagentThreadId: string | null; toolName: string }>;
type Query = Readonly<{
  orderBy?: readonly Readonly<{ startedAt?: "asc" | "desc" }>[];
  take?: number;
  where: Readonly<{
    OR?: readonly Readonly<{ arguments: Readonly<{ equals: string }> }>[];
    startedAt?: Readonly<{ lte: Date }>;
    subagentThreadId?: string | null;
    toolName: string | Readonly<{ in: readonly string[] }>;
  }>;
}>;

const SHELL = namespacedWorkspaceToolName("sandbox_exec");
let clock = Date.parse("2026-11-20T08:00:00.000Z");
const next = () => new Date(clock += 1_000);

/** An unattended run's stored `browser_handoff` row, as the tool batch writes it. */
async function stored(args: Record<string, unknown>, subagentThreadId: string | null = null): Promise<Row> {
  const result = await executeBrowserHandoff({ arguments: args, id: "call", name: BROWSER_HANDOFF_TOOL_NAME }, { kind: "unattended" },
    new AbortController().signal);
  return { arguments: args, result: snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes), startedAt: next(),
    subagentThreadId, toolName: BROWSER_HANDOFF_TOOL_NAME };
}

/** A Workspace command whose output carries the browser's step lines, as the guest prints them. */
function command(stdout: string, subagentThreadId: string | null = null): Row {
  return { arguments: { command: "aiqsa-browser open https://example.com" }, startedAt: next(), subagentThreadId, toolName: SHELL,
    result: { callId: "c", content: [{ text: JSON.stringify({ exitCode: 0, stdout }), type: "text" }], name: SHELL, status: "complete" } };
}

/** The run's rows filtered and ordered as PostgreSQL would answer the query, cut at its `take`. */
function transaction(rows: readonly Row[]) {
  const queries: Query[] = [];
  const tx = { modelRunToolCall: { findMany: async (query: Query) => {
    queries.push(query);
    const { where } = query;
    const reasons = where.OR?.map((clause) => clause.arguments.equals);
    const names = typeof where.toolName === "string" ? [where.toolName] : where.toolName.in;
    const matching = rows.filter((row) => names.includes(row.toolName) && (!reasons || reasons.includes(String(row.arguments.reason))) &&
      (where.subagentThreadId === undefined || row.subagentThreadId === where.subagentThreadId) &&
      (!where.startedAt || row.startedAt <= where.startedAt.lte));
    const ordered = query.orderBy?.[0]?.startedAt === "desc" ? [...matching].reverse() : matching;
    return query.take === undefined ? ordered : ordered.slice(0, query.take);
  } } };
  return { queries, tx: tx as unknown as Parameters<typeof runNeededBrowserSignIn>[0] };
}

describe("a scheduled run that needed a sign-in", () => {
  it("is found behind any number of other handoff calls", async () => {
    const rows: Row[] = [];
    for (let index = 0; index < 25; index += 1) rows.push(await stored({ message: "", reason: "sign_in" }));
    for (let index = 0; index < 5; index += 1) rows.push(await stored({ message: "Accept the cookies?", reason: "consent" }));
    const { queries, tx } = transaction([...rows, await stored({ message: "Enter the code we sent.", reason: "verification_code" })]);
    expect(await runNeededBrowserSignIn(tx, "run-1")).toBe(true);
    // The handoff calls are read without a bound; only the commands before the one that asked are bounded.
    expect(queries[0]?.take).toBeUndefined();
  });

  it("is not a run whose handoff calls were only malformed, or about a consent or a choice", async () => {
    const { tx } = transaction([await stored({ message: "", reason: "sign_in" }), await stored({ message: "Accept?", reason: "consent" }),
      await stored({ message: "Pick one.", reason: "user_choice" })]);
    expect(await runNeededBrowserSignIn(tx, "run-1")).toBe(false);
    expect(await runBrowserSignIn(tx, "run-1")).toBeNull();
  });

  it("records the site the asking agent's browser last showed before it asked, read from the steps its commands printed", async () => {
    const { tx } = transaction([
      command("[browser #1] open @ www.news.example/today\nThe news."),
      command("[browser #2] open @ mail.example.com/u/0\n[browser #3] click: link \"Sign in\" @ Accounts.Example.com:443/signin\nSign in"),
      command("Wrote report.md"),
      await stored({ message: "Please sign in to your mail.", reason: "sign_in" }),
      // After it asked: never the site it names.
      command("[browser #4] open @ later.example/after")
    ]);
    expect(await runBrowserSignIn(tx, "run-1")).toEqual({ host: "accounts.example.com" });
  });

  it("reads only the agent that asked, and records no site when its commands showed none", async () => {
    const sub = "thread-1";
    const { tx } = transaction([
      command("[browser #1] open @ main.example/page"),
      command("[browser #2] open @ portal.example.org/login", sub),
      await stored({ message: "Please sign in to the portal.", reason: "sign_in" }, sub)
    ]);
    expect(await runBrowserSignIn(tx, "run-1")).toEqual({ host: "portal.example.org" });

    const { tx: blind } = transaction([command("echo done"), await stored({ message: "Please sign in.", reason: "sign_in" })]);
    expect(await runBrowserSignIn(blind, "run-1")).toEqual({ host: null });
    // A step line that names no usable host is no site either.
    const { tx: local } = transaction([command("[browser #1] open @ localhost:3000/login"), await stored({ message: "Sign in.", reason: "sign_in" })]);
    expect(await runBrowserSignIn(local, "run-1")).toEqual({ host: null });
  });
});
