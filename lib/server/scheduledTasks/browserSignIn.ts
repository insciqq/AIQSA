import type { Prisma } from "@prisma/client";
import { normalizeBrowserSignInHost } from "../../contracts/browserSignIn";
import { browserHosts } from "../research/quoteCheck";
import { BROWSER_HANDOFF_SIGN_IN_REASONS, BROWSER_HANDOFF_TOOL_NAME, browserHandoffNeededSignIn } from "../tools/browserHandoff";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";

/** The Workspace tools that run a command or read its output, whose results carry the browser's step lines. */
const COMMAND_TOOLS: readonly string[] = (["sandbox_exec", "sandbox_exec_poll", "sandbox_exec_start", "sandbox_shell"] as const)
  .map(namespacedWorkspaceToolName);
/** The newest command calls before the handoff read for the site; an agent opens the page it hands over just before. */
const SCANNED_COMMANDS = 20;

type ToolCallReader = Pick<Prisma.TransactionClient, "modelRunToolCall">;

/**
 * Whether the run's agent needed its owner to sign in to a site and nobody could take over (`browserHandoffNeededSignIn`),
 * and on which host: the site the asking agent's browser last showed before it asked, read from the step lines its own
 * Workspace commands printed (`[browser #3] open @ mail.example.com/…`, `browserHosts`), never from the model's words;
 * null when they show none. Every handoff call asking for a sign-in, a code or a check is read, however many other calls
 * the run made; the first one names the site.
 */
export async function runBrowserSignIn(tx: ToolCallReader, runId: string): Promise<Readonly<{ host: string | null }> | null> {
  const calls = await tx.modelRunToolCall.findMany({
    orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }],
    select: { arguments: true, result: true, startedAt: true, subagentThreadId: true },
    where: {
      modelRunId: runId, state: "error", toolName: BROWSER_HANDOFF_TOOL_NAME,
      OR: BROWSER_HANDOFF_SIGN_IN_REASONS.map((reason) => ({ arguments: { equals: reason, path: ["reason"] } }))
    }
  });
  const asked = calls.find(browserHandoffNeededSignIn);
  if (!asked) return null;
  const commands = await tx.modelRunToolCall.findMany({
    orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
    select: { result: true },
    take: SCANNED_COMMANDS,
    where: {
      modelRunId: runId, subagentThreadId: asked.subagentThreadId, toolName: { in: [...COMMAND_TOOLS] },
      ...(asked.startedAt ? { startedAt: { lte: asked.startedAt } } : {})
    }
  });
  for (const command of commands) {
    if (command.result === null) continue;
    const host = [...browserHosts(JSON.stringify(command.result))].reverse()
      .map((shown) => normalizeBrowserSignInHost(shown)).find(Boolean);
    if (host) return { host };
  }
  return { host: null };
}
