import type { Prisma } from "@prisma/client";
import { storedUserRequest } from "../../runs/turnProvenance";
import { BROWSER_HANDOFF_TOOL_NAME } from "../../tools/browserHandoff";

/** The skip code of a session a turn the server wrote may not save (`browserSignInSaveFiles`). */
export const BROWSER_SESSION_SERVER_TURN = "browser_session_server_turn";

/** The handoff reason Sign in again asks for (`lib/contracts/browserSignIn.ts`), the only one whose Done may save here. */
const SIGN_IN_REASON = "sign_in";

/** The stored facts of a run that say whose turn it is. */
export type BrowserSaveTurn = Readonly<{ scheduledTaskId: string | null; userId: string; userMessageId: string }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a run's turn is one the server wrote, as its stored message shows: a scheduled occurrence, or a turn that is
 * not the user's own request by the stored chain the self-service fences read (`storedUserRequest`): any kind
 * (`Message.systemTurnKind`: a sub-agent wake-up, a Sign in again request, a continued chat's summary prompt) and a
 * scheduled task's prompt. The continuation after an MCP Allow has exactly the authority of the turn whose call the user
 * allowed: after the user's own turn it is theirs, after a turn the server wrote it is the server's, and a missing link
 * fails closed.
 */
export async function serverWrittenBrowserTurn(tx: Pick<Prisma.TransactionClient, "$queryRaw">, turn: BrowserSaveTurn):
  Promise<boolean> {
  return turn.scheduledTaskId !== null || !(await storedUserRequest(tx, { messageId: turn.userMessageId, userId: turn.userId }));
}

/**
 * The session file a stored `browser_handoff` call shows the user finishing a sign-in into: a handoff that asked them to
 * sign in, as Sign in again does, ended with their Done (`completed`, which only the user's press in the live view
 * gives), and named the file its save wrote (`signInSavedAfterAnswer`, the guest's file name without `.json`). Null for
 * any other call: another reason (a code, a check or a consent may follow a sign-in the agent made), Cancel, a wait that
 * ran out, a reply in the chat or a Done that saved nothing.
 */
export function completedSignInFile(call: Readonly<{ arguments: unknown; result: unknown; state: string }>): string | null {
  if (call.state !== "complete" || !isRecord(call.arguments) || call.arguments.reason !== SIGN_IN_REASON) return null;
  const content = isRecord(call.result) && Array.isArray(call.result.content) ? call.result.content as unknown[] : [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "json" || !isRecord(part.value) || part.value.outcome !== "completed") continue;
    const saved = part.value.signInSavedAfterAnswer;
    return typeof saved === "string" && saved.length > 0 ? `${saved}.json` : null;
  }
  return null;
}

/**
 * The session files a run whose turn the server wrote may save or replace (operator decision 2026-11-23): only those of
 * the sign-in handoffs the user finished with Done in that run, by any of its agents, read from the run's stored calls,
 * which only the server writes, never from anything the model or the guest says now. A wake-up, an automation or any
 * other turn the user did not write authorizes nothing (`agent_docs/RUN_CONTRACTS.md`), so a site whose session its agent
 * changed (page text may have steered it) keeps the sign-in the user saved for later chats.
 */
export async function browserSignInSaveFiles(tx: Pick<Prisma.TransactionClient, "modelRunToolCall">, runId: string):
  Promise<ReadonlySet<string>> {
  const calls = await tx.modelRunToolCall.findMany({
    select: { arguments: true, result: true, state: true },
    where: { arguments: { equals: SIGN_IN_REASON, path: ["reason"] }, modelRunId: runId, state: "complete",
      toolName: BROWSER_HANDOFF_TOOL_NAME }
  });
  return new Set(calls.flatMap((call) => completedSignInFile(call) ?? []));
}
