import type { Prisma } from "@prisma/client";
import { normalizeBrowserSignInHost } from "../../contracts/browserSignIn";
import { BROWSER_HANDOFF_SIGN_IN_REASONS, BROWSER_HANDOFF_TOOL_NAME, browserHandoffNeededSignIn } from "../tools/browserHandoff";
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
/**
 * One action's step line exactly as the guest prints it (`ops/workspace-guest/python/aiqsa/browser/_format.py`, parsed the
 * same way by `features/run-lifecycle-v2/workspaceActivityPresentation.ts`), optionally naming the agent:
 * `[browser #3 · lab] click: button "Add" @ shop.example/cart`. The host is the text after the last ` @ ` up to its path,
 * which the guest percent-encodes, so a quote in it means the ` @ ` stood inside a quoted name from the page.
 */
const STEP_LINE = /^\[browser #\d{1,5}(?: · [^\]\n]{1,64})?\] [a-z_]{1,20}(?:: [^\n]*)? @ ([^\s/@"]+)(?:\/[^\s"]*)?$/u;

type ToolCallReader = Pick<Prisma.TransactionClient, "modelRunToolCall">;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Workspace command result's `stdout`: the guest MCP server's envelope `{ ok, data: { stdout, … } }`, or a failed
 * command's `{ ok: false, error: { details: { stdout } } }` (both read the same way by `lib/server/workspace/operationFailure.ts`),
 * or a bare `{ stdout }`. Reading only the bare form left every production sign-in failure without its host.
 */
function stdoutOf(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  for (const holder of [value.data, isRecord(value.error) ? value.error.details : undefined, value]) {
    if (isRecord(holder) && typeof holder.stdout === "string") return [holder.stdout];
  }
  return [];
}

/**
 * What a stored command result printed to stdout: each text part's JSON `stdout`, or the part itself when it is no JSON;
 * decoded once, never unescaped further.
 */
function printedStdout(result: unknown): readonly string[] {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content as unknown[] : [];
  return content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (part.type === "json") return stdoutOf(part.value);
    if (part.type !== "text" || typeof part.text !== "string") return [];
    try {
      return stdoutOf(JSON.parse(part.text));
    } catch {
      return [part.text];
    }
  });
}

/**
 * The host of the step line a command's output opens with. An action prints its step line first, before any page text,
 * and the guest indents page text that would read as one; only that first line counts, so text a page or a file carries
 * further down can never name the site.
 */
function stepHost(stdout: string): string | null {
  const firstLine = stdout.split("\n", 1)[0]!.replace(/\r$/u, "");
  const shown = STEP_LINE.exec(firstLine)?.[1];
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
    const host = printedStdout(command.result).map(stepHost).find(Boolean);
    if (host) return { host };
  }
  return { host: null };
}
