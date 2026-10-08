import { isRecord } from "@/components/app-shell/shellValues";
import { textFromPersistedContent } from "@/components/app-shell/threadContent";
import type {
  ChatDetail,
  WorkspaceChatSummary,
  RunEventView,
  ThreadMessage
} from "@/components/app-shell/types";
import type {
  ChatDetailWire,
  ChatMessageWire,
  WorkspaceChatSummaryWire
} from "@/lib/contracts/chats";
import { safeInternalPath } from "@/lib/auth/internalPath";
import {
  CLIENT_SESSION_EXPIRED_CODE,
  clientSessionErrorFromStatus,
  type ClientSessionErrorCode
} from "@/lib/contracts/http";

type SessionExpiredListener = (code: ClientSessionErrorCode) => void;

const sessionExpiredListeners = new Set<SessionExpiredListener>();
let sessionExpiredSignaled = false;
let signOutInProgress = false;
let signOutSuppression = 0;
/** A sign-out normally leaves the page well within this; one that stays (a canceled navigation) gets its 401s back. */
const SIGN_OUT_SUPPRESSION_MS = 10_000;

if (typeof window !== "undefined") {
  // A page restored from the back-forward cache after its sign-out reacts to session expiry again.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      signOutSuppression += 1;
      signOutInProgress = false;
    }
  });
}

/**
 * A sign-out revokes the session before its response names the identity provider's logout
 * page, so other requests answer 401 meanwhile; they must not send the browser to the
 * session-expired login ahead of that logout. Returns the function a failed sign-out calls to
 * end the suppression early. It also ends on its own after a few seconds, when the page did not
 * leave (a canceled navigation), and only for the sign-out that started it.
 */
export function suppressSessionExpiredDuringSignOut(timeoutMs = SIGN_OUT_SUPPRESSION_MS): () => void {
  const suppression = ++signOutSuppression;
  signOutInProgress = true;
  const release = () => {
    if (suppression === signOutSuppression) signOutInProgress = false;
  };
  const timer = setTimeout(release, timeoutMs);
  return () => {
    clearTimeout(timer);
    release();
  };
}

function signalSessionExpired(code: ClientSessionErrorCode): void {
  if (sessionExpiredSignaled || signOutInProgress) {
    return;
  }

  sessionExpiredSignaled = true;
  for (const listener of sessionExpiredListeners) {
    listener(code);
  }
}

export function subscribeToSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  if (sessionExpiredSignaled) {
    listener(CLIENT_SESSION_EXPIRED_CODE);
  }

  return () => {
    sessionExpiredListeners.delete(listener);
    if (sessionExpiredListeners.size === 0) {
      sessionExpiredSignaled = false;
    }
  };
}

export async function shellFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = init === undefined
    ? await fetch(input)
    : await fetch(input, init);
  const sessionError = clientSessionErrorFromStatus(response.status);
  if (sessionError) {
    signalSessionExpired(sessionError);
  }
  return response;
}

/** Bound status/detail reads, including the body, so a suspended connection cannot hold recovery forever. */
export async function shellReadJson(input: string, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new DOMException("Status request interrupted", "AbortError"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const timeout = setTimeout(abort, 15_000);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await Promise.race([aborted, (async () => {
      controller.signal.throwIfAborted();
      const response = await shellFetch(input, { cache: "no-store", signal: controller.signal });
      const body: unknown = response.ok ? await response.json() : null;
      controller.signal.throwIfAborted();
      return { response, body };
    })()]);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", rejectAbort);
    signal?.removeEventListener("abort", abort);
  }
}

export function sessionExpiredLoginHref(destination: string): string {
  const query = new URLSearchParams({
    next: safeInternalPath(destination),
    reason: CLIENT_SESSION_EXPIRED_CODE
  });
  return `/login?${query.toString()}`;
}

export function parseSseBlock(block: string): RunEventView | null {
  const lines = block.split("\n");
  const fieldValue = (line: string, field: string): string | null => {
    if (!line.startsWith(`${field}:`)) {
      return null;
    }

    const value = line.slice(field.length + 1);
    return value.startsWith(" ") ? value.slice(1) : value;
  };
  const type = lines
    .map((line) => fieldValue(line, "event"))
    .find((value): value is string => value !== null);
  const dataLines = lines
    .map((line) => fieldValue(line, "data"))
    .filter((value): value is string => value !== null);

  if (!type) {
    return null;
  }

  if (dataLines.length === 0) {
    return {
      data: null,
      type
    };
  }

  const data = dataLines.join("\n");
  try {
    return {
      data: JSON.parse(data) as unknown,
      type
    };
  } catch {
    return {
      data: {
        eventType: type,
        message: "Skipped malformed stream frame",
        raw: data.slice(0, 240)
      },
      type: "parse_error"
    };
  }
}

export function isSseParseError(event: RunEventView): boolean {
  return event.type === "parse_error";
}

export function sseParseWarningEvent(event: RunEventView): RunEventView {
  return {
    data: {
      eventType:
        isRecord(event.data) && typeof event.data.eventType === "string"
          ? event.data.eventType
          : undefined,
      message: "Skipped malformed stream frame"
    },
    type: "warning"
  };
}

export function runIdFromEvent(event: RunEventView): string | null {
  return isRecord(event.data) && typeof event.data.runId === "string"
    ? event.data.runId
    : null;
}

export function messageIdsFromEvent(
  event: RunEventView
): { assistantMessageId?: string; userMessageId?: string } | null {
  if (event.type !== "message_start" || !isRecord(event.data)) {
    return null;
  }

  return {
    assistantMessageId:
      typeof event.data.assistantMessageId === "string"
        ? event.data.assistantMessageId
        : undefined,
    userMessageId:
      typeof event.data.userMessageId === "string"
        ? event.data.userMessageId
        : undefined
  };
}

export function tokenDeltaFromEvent(event: RunEventView): string | null {
  return event.type === "token" &&
    isRecord(event.data) &&
    typeof event.data.delta === "string"
    ? event.data.delta
    : null;
}

export function normalizeThreadStatus(status: string): ThreadMessage["status"] {
  return status === "queued" || status === "streaming"
    ? "streaming"
    : status === "error" || status === "cancelled"
    ? status
    : "complete";
}

export function messageFromApi(message: ChatMessageWire): ThreadMessage {
  const persistedText = textFromPersistedContent(message.content);
  const artifactSummary = message.artifactSummary
    ? {
        ...message.artifactSummary,
        citations: message.artifactSummary.citations ?? [],
        knowledgeCitations: message.artifactSummary.knowledgeCitations ?? [],
        sources: message.artifactSummary.sources ?? []
      }
    : null;

  return {
    ...(message.answerReview ? { answerReview: message.answerReview } : {}),
    artifactSummary,
    assistantIdentity: message.assistantIdentity ?? null,
    author: message.author ?? null,
    citationMessageId: message.citationMessageId ?? null,
    ...(message.status === "error" && message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    content:
      message.status === "error"
        ? persistedText
        : message.status === "cancelled"
          ? persistedText || "Stopped."
          : message.content,
    id: message.id,
    modelId: message.modelId ?? undefined,
    parentMessageId: message.parentMessageId,
    provider: message.provider ?? undefined,
    role: message.role === "assistant" ? "assistant" : "user",
    runId: message.modelRunId ?? null,
    ...(message.scheduledTask ? { scheduledTask: message.scheduledTask } : {}),
    ...(message.scheduledOutcome ? { scheduledOutcome: message.scheduledOutcome } : {}),
    ...(message.systemTurnKind ? { systemTurnKind: message.systemTurnKind } : {}),
    status: normalizeThreadStatus(message.status),
    ...(message.pdfPreparation ? { pdfPreparation: message.pdfPreparation } : {}),
    ...(message.workspacePreparation ? { workspacePreparation: true as const } : {}),
    ...(message.workspaceSettling ? { workspaceSettling: true as const } : {}),
    ...(message.followups ? { followups: message.followups } : {}),
    toolActivity: message.toolActivity ?? null,
    workspaceActivity: message.workspaceActivity ?? null
  };
}

export function chatSummaryFromApi(chat: WorkspaceChatSummaryWire): WorkspaceChatSummary {
  return {
    ...(chat.hasContinuationSource ? { hasContinuationSource: true } : {}),
    ...(chat.importSource ? { importSource: chat.importSource } : {}),
    ...(chat.importSourceModel ? { importSourceModel: chat.importSourceModel } : {}),
    ...(chat.titlePending ? { titlePending: true } : {}),
    activeLeafMessageId: chat.activeLeafMessageId,
    // Always present, so a merged summary never keeps a stale choice.
    answerReview: chat.answerReview,
    ...(chat.assistantId !== undefined ? { assistantId: chat.assistantId } : {}),
    createdAt: chat.createdAt,
    defaultKnowledgePlan: chat.defaultKnowledgePlan ?? null,
    ...(chat.defaultSearchPlan ? { defaultSearchPlan: chat.defaultSearchPlan } : {}),
    defaultModelId: chat.defaultModelId ?? "",
    defaultProvider: chat.defaultProvider ?? "",
    folderId: chat.folderId,
    id: chat.id,
    messageCount: chat.messageCount,
    pinned: chat.pinned,
    projectId: chat.projectId ?? null,
    title: chat.title,
    updatedAt: chat.updatedAt,
    workspace: chat.workspace
  };
}

export function chatDetailFromApi(chat: ChatDetailWire): ChatDetail {
  return {
    ...chatSummaryFromApi(chat),
    contextStats: chat.contextStats,
    messages: chat.messages.map(messageFromApi),
    pageInfo: chat.pageInfo,
    usageStats: chat.usageStats
  };
}
