import type { Prisma } from "@prisma/client";
import { WORKSPACE_BROWSER_SESSION_MAX_COUNT } from "@/lib/contracts/workspaceSecrets";
import { storedUserRequest } from "../../runs/turnProvenance";
import { BROWSER_HANDOFF_TOOL_NAME } from "../../tools/browserHandoff";

/** The skip code of a session a turn the server wrote may not save (`browserSignInSaveFiles`). */
export const BROWSER_SESSION_SERVER_TURN = "browser_session_server_turn";

/** The handoff reason Sign in again asks for (`lib/contracts/browserSignIn.ts`), the only one whose Done may save here. */
const SIGN_IN_REASON = "sign_in";

/** Refused revisions one Workspace session keeps, the newest last (`WorkspaceSession.browserRefusedRevisions`). */
export const BROWSER_REFUSED_REVISIONS_LIMIT = 2 * WORKSPACE_BROWSER_SESSION_MAX_COUNT;
const SHA256 = /^[0-9a-f]{64}$/u;

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

/**
 * Whether a session file holds the named site alone: every cookie's domain and every origin's host is that site or a
 * name under it. A file kept for several sites (Settings accepts such a storage state) carries cookies of the others,
 * which a sign-in to one site never authorizes. Conservative: a cookie a site sets on a parent name also counts as
 * another site's, and an unreadable file holds nothing alone.
 */
export function browserSessionHoldsOnlySite(bytes: Uint8Array, site: string): boolean {
  const own = site.toLowerCase();
  const isOwn = (host: unknown) => {
    if (typeof host !== "string") return false;
    const name = host.trim().toLowerCase().replace(/^\./u, "").replace(/\.$/u, "");
    return name === own || name.endsWith(`.${own}`);
  };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) return false;
    return value.cookies.every((cookie) => isRecord(cookie) && isOwn(cookie.domain)) &&
      value.origins.every((origin) => isRecord(origin) && typeof origin.origin === "string" && isOwn(new URL(origin.origin).hostname));
  } catch {
    return false;
  }
}

/**
 * Whether a run may save or replace a session file it collected where only a finished sign-in may (a turn the server
 * wrote, or bytes such a turn left refused on the disk): a sign-in handoff the user finished with Done in this run saved
 * that file (`browserSignInSaveFiles`), and the file holds that site alone.
 */
export function browserSignInSaveAllowed(finished: ReadonlySet<string>, file: Readonly<{ fileName: string; bytes: Uint8Array }>):
  boolean {
  return finished.has(file.fileName) && browserSessionHoldsOnlySite(file.bytes, file.fileName.slice(0, -".json".length));
}

/**
 * The refused revisions a Workspace session keeps (`WorkspaceSession.browserRefusedRevisions`): the files whose save a
 * turn the server wrote was refused while the disk still holds them, by name, with the refused bytes' SHA-256. Anything
 * malformed reads as none.
 */
export function refusedBrowserRevisions(value: unknown): ReadonlyMap<string, string> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.flatMap((entry): Array<[string, string]> => Array.isArray(entry) && entry.length === 2 &&
    typeof entry[0] === "string" && typeof entry[1] === "string" && SHA256.test(entry[1]) ? [[entry[0], entry[1]]] : []));
}

/**
 * The refused revisions with one file's set to `checksum`, or removed with null, the newest last and within
 * `BROWSER_REFUSED_REVISIONS_LIMIT`; null when none remain. A list, because a JSON object's key order does not survive
 * the database.
 */
export function nextRefusedBrowserRevisions(current: ReadonlyMap<string, string>, fileName: string, checksum: string | null):
  Array<[string, string]> | null {
  const kept: Array<[string, string]> = [...current].filter(([name]) => name !== fileName);
  if (checksum !== null) kept.push([fileName, checksum]);
  return kept.length > 0 ? kept.slice(-BROWSER_REFUSED_REVISIONS_LIMIT) : null;
}
