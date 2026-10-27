// @vitest-environment node
import { describe, expect, it } from "vitest";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { BROWSER_HANDOFF_TOOL_NAME, executeBrowserHandoff } from "../tools/browserHandoff";
import { runNeededBrowserSignIn } from "./runnerStore";

type Row = Readonly<{ arguments: Record<string, unknown>; result: unknown }>;
type Query = Readonly<{ take?: number; where: Readonly<{ OR?: readonly Readonly<{ arguments: Readonly<{ equals: string }> }>[] }> }>;

/** An unattended run's stored `browser_handoff` row, as the tool batch writes it. */
async function stored(args: Record<string, unknown>): Promise<Row> {
  const result = await executeBrowserHandoff({ arguments: args, id: "call", name: BROWSER_HANDOFF_TOOL_NAME }, { kind: "unattended" },
    new AbortController().signal);
  return { arguments: args, result: snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes) };
}

/** The run's rows in order, filtered by the query's reasons and cut at its `take`, as PostgreSQL would answer it. */
function transaction(rows: readonly Row[]) {
  const queries: Query[] = [];
  const tx = { modelRunToolCall: { findMany: async (query: Query) => {
    queries.push(query);
    const reasons = query.where.OR?.map((clause) => clause.arguments.equals);
    const matching = rows.filter((row) => !reasons || reasons.includes(String(row.arguments.reason)));
    return query.take === undefined ? matching : matching.slice(0, query.take);
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
    expect(queries.every((query) => query.take === undefined)).toBe(true);
  });

  it("is not a run whose handoff calls were only malformed, or about a consent or a choice", async () => {
    const { tx } = transaction([await stored({ message: "", reason: "sign_in" }), await stored({ message: "Accept?", reason: "consent" }),
      await stored({ message: "Pick one.", reason: "user_choice" })]);
    expect(await runNeededBrowserSignIn(tx, "run-1")).toBe(false);
  });
});
