import type { ThreadArtifactSummary } from "../../contracts/chats";

/**
 * The AIQSA run operations a chat connector performs as its user, all through
 * the product's own in-process handlers and repositories (the same admission,
 * follow-up, Stop and reads the web uses), behind one seam so a connector's
 * bridge stays free of the run stack and testable with fakes. Every operation
 * re-resolves the user through the connector's request resolver
 * (`connectorRequestAuth`). The in-process implementation is
 * `createDefaultConnectorRunGateway`.
 */

/** A chat of the user's as admission reads it; null when it is not the user's or no longer exists. */
export type ConnectorChatRecord = Readonly<{
  id: string;
  title: string;
  activeLeafMessageId: string | null;
  assistantId: string | null;
  memoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  /** The chat's model, empty for a chat that has none yet. */
  model: Readonly<{ modelId: string; provider: string }>;
}>;

/** A run's state as `GET /api/model-runs/[runId]` answers it. */
export type ConnectorRunState = Readonly<{ status: string }>;

/** A settled run's answer as the chat shows it. */
export type ConnectorRunAnswer = Readonly<{
  chatId: string;
  assistantMessageId: string;
  status: "complete" | "cancelled" | "error" | "streaming";
  text: string;
  errorMessage: string | null;
  artifactSummary: ThreadArtifactSummary | null;
}>;

/** What every connector does with runs. */
export type ConnectorRunOperations = Readonly<{
  /** `POST /api/chats/[chatId]/messages` in process, as the user, as the connector's turn. */
  send(input: Readonly<{ userId: string; chatId: string; body: Record<string, unknown> }>): Promise<Response>;
  /** `POST /api/model-runs/[runId]/followups` in process, as the user. */
  followup(input: Readonly<{
    userId: string; runId: string; chatId: string; assistantMessageId: string; nonce: string; text: string;
  }>): Promise<Response>;
  /** The ordinary Stop of an active run. */
  stop(input: Readonly<{ userId: string; runId: string }>): Promise<"stopped" | "not_cancelable" | "not_found">;
  /** Null when the run is gone or no longer the user's; a run still being prepared reads as `preparing`. */
  runState(input: Readonly<{ userId: string; runId: string }>): Promise<ConnectorRunState | null>;
  /** The run's persisted answer, citations and sources; null when it can no longer be read. */
  answer(input: Readonly<{ userId: string; runId: string }>): Promise<ConnectorRunAnswer | null>;
  /** The active run of a chat, whoever started it. */
  activeRun(input: Readonly<{ userId: string; chatId: string }>): Promise<Readonly<{ runId: string }> | null>;
}>;

export type ConnectorRunGateway = ConnectorRunOperations & Readonly<{
  /** The user's own chat, any mode; the connector decides which it may continue. */
  chat(userId: string, chatId: string): Promise<ConnectorChatRecord | null>;
}>;

export const CONNECTOR_TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["complete", "error", "cancelled"]);

/**
 * A loader that runs once and is shared by every caller; a failed load is forgotten, so the next call tries again.
 * Connectors load their run stack on first use this way, so starting one never loads it.
 */
export function lazyConnectorLoader<Value>(load: () => Promise<Value>): () => Promise<Value> {
  let loading: Promise<Value> | null = null;
  return () => loading ??= load().catch((error: unknown) => {
    loading = null;
    throw error;
  });
}

/** The run operations of a gateway that loads on first use (`lazyConnectorLoader`). */
export function lazyConnectorRunOperations(gateway: () => Promise<ConnectorRunOperations>): ConnectorRunOperations {
  return Object.freeze({
    activeRun: async (input) => (await gateway()).activeRun(input),
    answer: async (input) => (await gateway()).answer(input),
    followup: async (input) => (await gateway()).followup(input),
    runState: async (input) => (await gateway()).runState(input),
    send: async (input) => (await gateway()).send(input),
    stop: async (input) => (await gateway()).stop(input)
  } satisfies ConnectorRunOperations);
}

/** A whole gateway that loads on first use. */
export function lazyConnectorRunGateway(load: () => Promise<ConnectorRunGateway>): ConnectorRunGateway {
  const gateway = lazyConnectorLoader(load);
  return Object.freeze({
    ...lazyConnectorRunOperations(gateway),
    chat: async (userId: string, chatId: string) => (await gateway()).chat(userId, chatId)
  });
}
