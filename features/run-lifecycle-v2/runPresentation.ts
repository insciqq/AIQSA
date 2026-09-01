import type {
  ModelRunStatus,
  RunEventView
} from "@/lib/contracts/runs";
import type { ThreadToolActivity } from "@/lib/contracts/chats";

export type RunLifecycleStatusV2 = ModelRunStatus | "preparing";

export type RunFailureV2 = Readonly<{
  code?: string | null;
  message?: string | null;
  recovery?: "change_parameters" | "retry";
}>;

export type RunLifecycleStateV2 = Readonly<{
  authoritativeMessageStatus?: "cancelled" | "complete" | "error" | null;
  connectionLost?: boolean;
  content: string;
  events: readonly RunEventView[];
  failure?: RunFailureV2 | null;
  runId: string | null;
  status?: RunLifecycleStatusV2 | null;
}>;

export type RunActivityKindV2 =
  | "compute"
  | "preparing"
  | "preview"
  | "provider"
  | "queued"
  | "search"
  | "tool";

export type RunPresentationV2 = Readonly<{
  activity?: Readonly<{
    kind: RunActivityKindV2;
    label: string;
    serverName?: string;
    toolName?: string;
  }>;
  failure?: Readonly<{
    code: string | null;
    message: string;
    recovery: "change_parameters" | "retry";
  }>;
  kind:
    | "activity"
    | "cancelled"
    | "complete"
    | "connection_lost"
    | "idle"
    | "recoverable_error"
    | "streaming"
    | "terminal_error";
  runId: string | null;
}>;

type TerminalSignal = "cancelled" | "complete" | "error";

type ActivitySignal = Readonly<{
  index: number;
  kind: Exclude<RunActivityKindV2, "preparing" | "queued">;
  serverName?: string;
  toolName?: string;
}>;

const safeToolNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/u;
const safeErrorCodePattern = /^[a-z0-9][a-z0-9_.:-]{0,79}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized ? normalized.slice(0, limit) : null;
}

function safeToolName(value: unknown): string | null {
  const name = boundedText(value, 80);
  return name && !name.startsWith("mcp_") && safeToolNamePattern.test(name) ? name : null;
}

function safeServerName(value: unknown): string | null {
  const name = boundedText(value, 160);
  return name && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

function safeErrorCode(value: unknown): string | null {
  const code = boundedText(value, 80);
  return code && safeErrorCodePattern.test(code) ? code : null;
}

function terminalStatus(value: unknown): TerminalSignal | null {
  return value === "cancelled" || value === "complete" || value === "error"
    ? value
    : null;
}

function eventPayload(event: RunEventView): Record<string, unknown> | null {
  if (event.type !== "artifact" || !isRecord(event.data)) return null;
  return isRecord(event.data.payload) ? event.data.payload : null;
}

function activityFromEvent(event: RunEventView, index: number): ActivitySignal | null {
  if (event.type !== "artifact" || !isRecord(event.data)) return null;
  const payload = eventPayload(event);
  const artifactType = event.data.artifactType;

  if (artifactType === "search" || artifactType === "citation") {
    return { index, kind: "search" };
  }

  if (!payload) return null;

  if (artifactType === "tool_call" && payload.status === "requested") {
    const toolName = safeToolName(payload.name ?? payload.toolName);
    const serverName = safeServerName(payload.serverName);
    return toolName
      ? { index, kind: "tool", ...(serverName ? { serverName } : {}), toolName }
      : { index, kind: "tool" };
  }

  if (artifactType !== "summary") return null;

  if (payload.stage === "search" && payload.status === "running") {
    return { index, kind: "search" };
  }

  if (payload.stage === "tools" && payload.status === "running") {
    const toolName = safeToolName(payload.name ?? payload.toolName);
    return toolName
      ? { index, kind: "tool", toolName }
      : { index, kind: "tool" };
  }

  if (payload.stage === "compute" && payload.status === "running") {
    return { index, kind: "compute" };
  }

  if (payload.stage === "preview" && payload.status === "running") {
    return { index, kind: "preview" };
  }

  if (payload.stage === "model" && payload.status === "waiting") {
    return { index, kind: "provider" };
  }

  return null;
}

const webSearchToolNames = new Set([
  "search",
  "search_web",
  "web_search",
  "websearch",
  "google_search",
  "brave_search"
]);

function humanizeToolName(toolName: string): string {
  return toolName.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * User-legible label for one tool call (FRONTEND contract: only user-legible
 * server/tool names). Built-in tools get a plain-language verb; MCP tools
 * keep their server name plus a de-snaked tool name. Raw identifiers such as
 * `search_knowledge` never reach the thread.
 */
export function describeToolCallV2(
  call: Readonly<{ serverName?: string; toolName?: string }>,
  phase: "running" | "settled"
): string {
  const running = phase === "running";
  const toolName = call.toolName ?? "";
  if (toolName === "find_tools") return running ? "Finding relevant tools" : "Found relevant tools";
  if (toolName === "search_knowledge") return running ? "Searching Knowledge" : "Searched Knowledge";
  if (webSearchToolNames.has(toolName.toLowerCase())) {
    return running ? "Searching the web" : "Searched the web";
  }
  const human = humanizeToolName(toolName);
  if (call.serverName && human) {
    return `${running ? "Using" : "Used"} ${call.serverName}: ${human}`;
  }
  if (human) return `${running ? "Running" : "Ran"} ${human}`;
  return running ? "Running tools" : "Used tools";
}

function activityLabel(signal: Omit<ActivitySignal, "index">): string {
  switch (signal.kind) {
    case "search":
      return "Searching the web…";
    case "tool":
      return `${describeToolCallV2(signal, "running")}…`;
    case "compute":
      return "Computing…";
    case "preview":
      return "Rendering preview…";
    case "provider":
      return "Thinking…";
  }
}

/** Merges safe live call facts into an existing persisted projection. */
export function presentToolActivityV2(
  events: readonly RunEventView[],
  persisted: ThreadToolActivity | null = null
): ThreadToolActivity | null {
  const calls = [...(persisted?.calls ?? [])];
  const matched = new Set<number>();
  for (const event of events) {
    const payload = eventPayload(event);
    if (event.type !== "artifact" || !isRecord(event.data) ||
      event.data.artifactType !== "tool_call" || payload?.status !== "requested") continue;
    const toolName = safeToolName(payload.name ?? payload.toolName);
    const serverName = safeServerName(payload.serverName);
    const round = Number.isSafeInteger(payload.round) && Number(payload.round) > 0
      ? Number(payload.round)
      : null;
    if (!toolName || round === null) continue;
    const existing = calls.findIndex((call, index) =>
      !matched.has(index) && call.round === round && call.toolName === toolName &&
      (call.serverName ?? null) === serverName);
    if (existing >= 0) {
      matched.add(existing);
      continue;
    }
    calls.push({
      round,
      ...(serverName ? { serverName } : {}),
      status: "running",
      toolName
    });
  }
  return calls.length > 0 || persisted?.warning
    ? { calls, ...(persisted?.warning ? { warning: persisted.warning } : {}) }
    : null;
}

function statusActivity(status: RunLifecycleStatusV2 | null | undefined) {
  if (status === "queued") {
    return { kind: "queued" as const, label: "Queued" };
  }
  if (status === "preparing") {
    return { kind: "preparing" as const, label: "Preparing request…" };
  }
  if (status === "in_progress" || status === "streaming") {
    return { kind: "provider" as const, label: "Thinking…" };
  }
  return null;
}

function failureFromState(
  state: RunLifecycleStateV2,
  eventFailure: RunFailureV2 | null
): NonNullable<RunPresentationV2["failure"]> {
  const failure = state.failure ?? eventFailure ?? {};
  const recovery = failure.recovery === "retry" ? "retry" : "change_parameters";
  const partial = state.content.trim().length > 0;
  const fallback = partial && recovery === "retry"
    ? "The answer was interrupted mid-run. The partial result is kept; you can retry with the same parameters."
    : "The run failed. Change the request parameters and try again.";

  return {
    code: safeErrorCode(failure.code),
    message: boundedText(failure.message, 600) ?? fallback,
    recovery
  };
}

/**
 * True only for authoritative terminal presentations. Settled-answer actions
 * and outputs render exclusively behind this predicate; live runs show the
 * status line and Stop instead.
 */
export function settledRunPresentationV2(presentation: RunPresentationV2): boolean {
  return presentation.kind === "cancelled" ||
    presentation.kind === "complete" ||
    presentation.kind === "recoverable_error" ||
    presentation.kind === "terminal_error";
}

/**
 * Projects only explicit server and client lifecycle state. It never infers a
 * phase from elapsed time, answer text, or a missing terminal frame.
 */
export function presentRunLifecycleV2(
  state: RunLifecycleStateV2
): RunPresentationV2 {
  let terminal: TerminalSignal | null = terminalStatus(
    state.authoritativeMessageStatus
  );
  const activitySignals: ActivitySignal[] = [];
  let latestTokenIndex = -1;
  let eventFailure: RunFailureV2 | null = null;

  for (const [index, event] of state.events.entries()) {
    if (event.type === "token") {
      latestTokenIndex = index;
      continue;
    }

    const activity = activityFromEvent(event, index);
    if (activity) activitySignals.push(activity);

    if (event.type === "error") {
      terminal = "error";
      if (isRecord(event.data)) {
        eventFailure = {
          code: safeErrorCode(event.data.code),
          message: boundedText(event.data.message, 600),
          recovery: event.data.recovery === "retry" || event.data.retryable === true
            ? "retry"
            : "change_parameters"
        };
      }
      continue;
    }

    if (event.type === "done" && isRecord(event.data)) {
      terminal = terminalStatus(event.data.status) ?? terminal;
    }
  }

  terminal = terminalStatus(state.status) ?? terminal;

  if (terminal === "complete") {
    return { kind: "complete", runId: state.runId };
  }
  if (terminal === "cancelled") {
    return { kind: "cancelled", runId: state.runId };
  }
  if (terminal === "error") {
    const failure = failureFromState(state, eventFailure);
    const recoverable = state.content.trim().length > 0 && failure.recovery === "retry";
    return {
      failure,
      kind: recoverable ? "recoverable_error" : "terminal_error",
      runId: state.runId
    };
  }

  if (state.connectionLost) {
    return { kind: "connection_lost", runId: state.runId };
  }

  const selectedActivity = activitySignals.at(-1) ?? null;
  if (latestTokenIndex >= 0 && latestTokenIndex >= (selectedActivity?.index ?? -1)) {
    return { kind: "streaming", runId: state.runId };
  }

  if (selectedActivity) {
    const { index: _index, ...signal } = selectedActivity;
    return {
      activity: {
        ...signal,
        label: activityLabel(signal)
      },
      kind: "activity",
      runId: state.runId
    };
  }

  const activity = statusActivity(state.status);
  return activity
    ? { activity, kind: "activity", runId: state.runId }
    : { kind: "idle", runId: state.runId };
}
