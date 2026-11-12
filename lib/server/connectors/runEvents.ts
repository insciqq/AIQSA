import { logEvent, type Subsystem } from "../observability";
import type { RunStreamFrame } from "./sse";

/**
 * What a connector observes of a run it started, as typed events, and a
 * process-wide hub per connector that later features subscribe to (approvals,
 * Workspace status, generated files): they follow a run without parsing its
 * stream or touching the bridge.
 *
 * Stream events: `answerDelta` (answer text as it arrives), `answerReset`
 * (the text so far is replaced, e.g. after a follow-up), `approvalRequested`
 * (an MCP approval card), `workspaceActivity` (a projected Workspace activity
 * entry), `toolActivity` (a tool call the run started or settled, as its
 * live status names it: origin, server and tool display names, never
 * arguments or results), `searchActivity` (hosted Search at work),
 * `compaction` (the context is being compacted), `preparing` (a deferred
 * admission the run waits in), `done` (`complete` or `cancelled`) and `failed`.
 */
export type ConnectorRunStreamEvent =
  | Readonly<{ type: "answerDelta"; delta: string }>
  | Readonly<{ type: "answerReset" }>
  | Readonly<{ type: "approvalRequested"; card: unknown }>
  | Readonly<{ type: "workspaceActivity"; entry: unknown }>
  | Readonly<{
    type: "toolActivity"; origin: string | null; serverName: string | null; toolName: string | null; settled: boolean;
  }>
  | Readonly<{ type: "searchActivity" }>
  | Readonly<{ type: "compaction" }>
  | Readonly<{ type: "preparing"; status: string }>
  | Readonly<{ type: "done"; status: "complete" | "cancelled" }>
  | Readonly<{ type: "failed"; code: string | null; message: string | null }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
}

/** A live `tool_call` status as its display facts only (`lib/server/runs/liveToolStatus.ts`). */
function toolActivity(payload: unknown): ConnectorRunStreamEvent | null {
  if (!isRecord(payload)) return null;
  return {
    origin: boundedName(payload.origin), serverName: boundedName(payload.serverName), settled: payload.status === "complete" || payload.status === "error",
    toolName: boundedName(payload.name), type: "toolActivity"
  };
}

/** The stream frames a connector follows, as typed events; everything else stays with the web. */
export function connectorRunEvent(frame: RunStreamFrame): ConnectorRunStreamEvent | null {
  const data = isRecord(frame.data) ? frame.data : {};
  switch (frame.type) {
    case "token":
      return typeof data.delta === "string" && data.delta ? { delta: data.delta, type: "answerDelta" } : null;
    case "message_reset":
      return { type: "answerReset" };
    case "artifact":
      if (data.artifactType === "mcp_approval") return { card: data.payload, type: "approvalRequested" };
      if (data.artifactType === "workspace_activity") return { entry: data.payload, type: "workspaceActivity" };
      if (data.artifactType === "tool_call") return toolActivity(data.payload);
      if (data.artifactType === "search_activity") return { type: "searchActivity" };
      if (data.artifactType === "context_compaction") return { type: "compaction" };
      return null;
    case "done":
      return { status: data.status === "cancelled" ? "cancelled" : "complete", type: "done" };
    case "error":
      return {
        code: typeof data.code === "string" ? data.code : null, message: typeof data.message === "string" ? data.message : null,
        type: "failed"
      };
    default:
      return null;
  }
}

export type ConnectorRunListener<Event, Context> = (event: Event, context: Context) => Promise<void> | void;

export type ConnectorRunEventHub<Event, Context> = Readonly<{
  /** Follows every run of this connector in this process; returns the unsubscribe function. */
  on(listener: ConnectorRunListener<Event, Context>): () => void;
  /** Hands one event to every subscriber in order; a failing subscriber never stops the run's delivery. */
  publish(event: Event, context: Context): Promise<void>;
}>;

/**
 * One connector's hub. Its listeners live in a process-global slot (`slot`), so every route bundle shares them; a
 * failing listener is logged content-free with the connector's code.
 */
export function createConnectorRunEventHub<Event, Context extends Readonly<{ runId: string }>>(options: Readonly<{
  slot: string;
  /** The log code of a listener that threw (registered in `failureCodes.json`). */
  listenerFailedCode: string;
  subsystem: Subsystem;
}>): ConnectorRunEventHub<Event, Context> {
  const slots = globalThis as unknown as Record<string, Set<ConnectorRunListener<Event, Context>> | undefined>;
  const listeners = () => slots[options.slot] ??= new Set();
  return Object.freeze({
    on(listener: ConnectorRunListener<Event, Context>) {
      listeners().add(listener);
      return () => { listeners().delete(listener); };
    },
    async publish(event: Event, context: Context) {
      for (const listener of [...listeners()]) {
        try {
          await listener(event, context);
        } catch (error) {
          logEvent("service_operation", {
            code: options.listenerFailedCode, error, outcome: "failed", run_id: context.runId, stage: "dispatch", subsystem: options.subsystem
          });
        }
      }
    }
  });
}
