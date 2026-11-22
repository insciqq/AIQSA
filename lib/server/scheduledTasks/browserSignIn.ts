import type { Prisma } from "@prisma/client";
import { normalizeBrowserSignInHost } from "../../contracts/browserSignIn";
import { parseBrowserStepLine } from "../../contracts/browserStepLine";
import { BROWSER_HANDOFF_SIGN_IN_REASONS, BROWSER_HANDOFF_TOOL_NAME, browserHandoffNeededSignIn } from "../tools/browserHandoff";
import { storedCommandStdout } from "../workspace/commandStdout";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";

/** The Workspace tools that run a command or read its output, whose results carry the browser's step lines. */
const COMMAND_TOOLS: readonly string[] = (["sandbox_exec", "sandbox_exec_poll", "sandbox_exec_start", "sandbox_shell"] as const)
  .map(namespacedWorkspaceToolName);
/** The newest command calls before the handoff read for the site; an agent opens the page it hands over just before. */
const SCANNED_COMMANDS = 20;
/**
 * A call that runs the browser helper as a command (`aiqsa-browser …`, alone or in a shell line) or imports it in inline
 * Python, read from each of its arguments. Only such a call's output may name the site: a file another command prints, a
 * saved browser log under `cat` included, starts with whatever line it holds (review 2026-11-21).
 */
const BROWSER_COMMAND = /(?:^|[\s;&|(])(?:\/usr\/local\/bin\/)?aiqsa-browser(?=$|[\s;&|)])|from\s+aiqsa\s+import\s+browser\b|\baiqsa\.browser\b/u;

const argumentStrings = (value: unknown): string[] => typeof value === "string" ? [value]
  : Array.isArray(value) ? value.flatMap(argumentStrings) : isRecord(value) ? Object.values(value).flatMap(argumentStrings) : [];
type ToolCallReader = Pick<Prisma.TransactionClient, "modelRunToolCall">;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The host of the step line a command's output opens with. An action prints its step line first, before any page text,
 * and the guest indents page text that would read as one; only that first line counts, so text a page or a file carries
 * further down can never name the site. The host is the where's, with its port left out; a ` @ ` inside a quoted name from
 * the page is no where (`lib/contracts/browserStepLine.ts`).
 */
function stepHost(stdout: string): string | null {
  const shown = parseBrowserStepLine(stdout)?.host;
  return shown ? normalizeBrowserSignInHost(shown.replace(/:\d{1,5}$/u, "")) : null;
}

/**
 * Whether the run's agent needed its owner to sign in to a site and nobody could take over (`browserHandoffNeededSignIn`),
 * and on which host: the site the asking agent's browser showed in its newest browser command before it asked, read from
 * the step line that command's output opens with, never from the model's words or a page's text; null when none shows one.
 * Every handoff call asking for a sign-in, a code or a check is read, however many other calls the run made; the first
 * one names the site. An unattended handoff never reaches the browser, so its result carries no page of its own.
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
    select: { arguments: true, result: true },
    take: SCANNED_COMMANDS,
    where: {
      modelRunId: runId, subagentThreadId: asked.subagentThreadId, toolName: { in: [...COMMAND_TOOLS] },
      ...(asked.startedAt ? { startedAt: { lte: asked.startedAt } } : {})
    }
  });
  for (const command of commands) {
    if (!argumentStrings(command.arguments).some((text) => BROWSER_COMMAND.test(text))) continue;
    const host = storedCommandStdout(command.result).map(stepHost).find(Boolean);
    if (host) return { host };
  }
  return { host: null };
}
