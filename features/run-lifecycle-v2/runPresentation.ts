import type { ChatPdfPreparationWire } from "@/lib/contracts/chatPdfPreparation";
import {
  isToolSynthesisFailure,
  TOOL_SYNTHESIS_FAILURE,
  type ModelRunStatus,
  type RunEventView
} from "@/lib/contracts/runs";
import {
  isThreadToolActivityOrigin,
  decodeThreadToolBudgetWarning,
  type ThreadToolActivity,
  type ThreadToolActivityOrigin,
  type ThreadToolBudgetWarning
} from "@/lib/contracts/chats";
import { formatMemoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { decodeContextCompactionStatus, mergeContextCompactionStatus, terminalContextCompactionStatus, type ContextCompactionStatus } from "@/lib/contracts/contextCompaction";

export type RunLifecycleStatusV2 = ModelRunStatus | "preparing";

export type RunFailureV2 = Readonly<{
  code?: string | null;
  message?: string | null;
  recovery?: "change_parameters" | "regenerate" | "retry";
}>;

export type RunLifecycleStateV2 = Readonly<{
  workspacePreparation?: true;
  pdfPreparation?: readonly ChatPdfPreparationWire[];
  authoritativeMessageStatus?: "cancelled" | "complete" | "error" | null;
  connectionLost?: boolean;
  contextCompaction?: ContextCompactionStatus | null;
  content: string;
  events: readonly RunEventView[];
  failure?: RunFailureV2 | null;
  runId: string | null;
  status?: RunLifecycleStatusV2 | null;
}>;

export type RunActivityKindV2 =
  | "compute"
  | "compaction"
  | "preparing"
  | "preview"
  | "provider"
  | "queued"
  | "search"
  | "synthesis"
  | "tool";

export type RunPresentationV2 = Readonly<{
  activity?: Readonly<{
    kind: RunActivityKindV2;
    label: string;
    budget?: ThreadToolBudgetWarning;
    origin?: ThreadToolActivityOrigin;
    serverName?: string;
    toolName?: string;
  }>;
  compaction?: ContextCompactionStatus;
  failure?: Readonly<{
    code: string | null;
    message: string;
    recovery: "change_parameters" | "regenerate" | "retry";
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
  budget?: ThreadToolBudgetWarning;
  origin?: ThreadToolActivityOrigin;
  serverName?: string;
  toolName?: string;
}>;

const safeToolNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/u;
const privateActivityNamePattern = /[\u0000-\u001f\u007f]|\bmcp_|[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)www\./iu;
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
  if (typeof value !== "string" || privateActivityNamePattern.test(value)) return null;
  const name = boundedText(value, 80);
  return name && safeToolNamePattern.test(name) ? name : null;
}

function safeServerName(value: unknown): string | null {
  if (typeof value !== "string" || privateActivityNamePattern.test(value)) return null;
  return boundedText(value, 160);
}

function skillActivityMetadata(payload: Record<string, unknown>) {
  if (payload.origin !== "skill") return {};
  const skillId = typeof payload.skillId === "string" && payload.skillId.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(payload.skillId) ? payload.skillId : null;
  const skillName = boundedText(payload.skillName, 160);
  const skillPath = boundedText(payload.skillPath, 256);
  return { ...(skillId ? { skillId } : {}), ...(skillName ? { skillName } : {}), ...(skillPath ? { skillPath } : {}) };
}

function toolActivityMetadata(payload: Record<string, unknown>) {
  const toolName = safeToolName(payload.name ?? payload.toolName);
  const serverName = safeServerName(payload.serverName);
  return {
    ...skillActivityMetadata(payload),
    ...(isThreadToolActivityOrigin(payload.origin) ? { origin: payload.origin } : {}),
    ...(serverName ? { serverName } : {}),
    ...(toolName ? { toolName } : {})
  };
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

function contextCompactionFromEvents(
  events: readonly RunEventView[],
  fallback: ContextCompactionStatus | null | undefined
): ContextCompactionStatus | null {
  let latest: ContextCompactionStatus | null = null;
  for (const event of events) {
    if (event.type !== "artifact" || !isRecord(event.data) ||
      event.data.artifactType !== "context_compaction") continue;
    const status = decodeContextCompactionStatus(event.data.payload);
    if (!status) continue;
    latest = mergeContextCompactionStatus(latest, status);
  }
  return mergeContextCompactionStatus(fallback, latest);
}

function activityFromEvent(event: RunEventView, index: number): ActivitySignal | null {
  if (event.type !== "artifact" || !isRecord(event.data)) return null;
  const payload = eventPayload(event);
  const artifactType = event.data.artifactType;

  if (artifactType === "context_compaction") {
    const status = decodeContextCompactionStatus(payload);
    return status?.state === "running" ? { index, kind: "compaction" } : null;
  }

  if (artifactType === "search" || artifactType === "citation") {
    return { index, kind: "search" };
  }

  if (!payload) return null;

  if (artifactType === "tool_budget") {
    const budget = decodeThreadToolBudgetWarning(payload);
    return budget ? { index, kind: "synthesis", budget } : null;
  }

  if (artifactType === "tool_call" && payload.status === "requested") {
    return { index, kind: "tool", ...toolActivityMetadata(payload) };
  }

  if (artifactType !== "summary") return null;

  if (payload.stage === "search" && payload.status === "running") {
    return { index, kind: "search" };
  }

  if (payload.stage === "tools" && payload.status === "running") {
    return { index, kind: "tool", ...toolActivityMetadata(payload) };
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
  "search_selected_engines",
  "web_search",
  "websearch",
  "google_search",
  "brave_search"
]);

function humanizeToolName(toolName: string): string {
  return toolName.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

type ToolActivityIdentity = Readonly<{
  skillId?: unknown;
  skillName?: unknown;
  skillPath?: unknown;
  origin?: unknown;
  serverName?: unknown;
  toolName?: unknown;
}>;

/** Accepted tool origin wins over names, including reserved display names.
 * Name fallbacks keep activities without explicit origin readable. */
export function toolActivityOriginV2(call: ToolActivityIdentity): ThreadToolActivityOrigin {
  if (isThreadToolActivityOrigin(call.origin)) return call.origin;
  const serverName = safeServerName(call.serverName);
  const toolName = safeToolName(call.toolName) ?? "";
  if (!call.serverName && (toolName === "create_artifact" || toolName === "read_artifact")) return "artifact";
  if (serverName === "Workspace") return "workspace";
  if ((!call.serverName || serverName === "Auto tools") && toolName === "find_tools") {
    return "discovery";
  }
  if ((!call.serverName || serverName === "Knowledge") &&
    (toolName === "search_knowledge" || toolName === "retrieve_knowledge")) return "knowledge";
  if ((!call.serverName || serverName === "Web search") &&
    webSearchToolNames.has(toolName.toLowerCase())) return "web_search";
  return call.serverName ? "mcp" : "tool";
}

/**
 * User-legible label for one tool call (FRONTEND contract: only user-legible
 * server/tool names). Built-in tools get a plain-language verb; MCP tools
 * keep their server name plus a de-snaked tool name. Raw identifiers such as
 * `search_knowledge` never reach the thread.
 */
export function describeToolCallV2(
  call: ToolActivityIdentity,
  phase: "cancelled" | "failed" | "running" | "settled"
): string {
  const running = phase === "running";
  const origin = toolActivityOriginV2(call);
  if (origin === "skill") {
    const name = boundedText(call.skillName, 160);
    const path = boundedText(call.skillPath, 256);
    if (call.toolName === "read_skill_file") {
      if (phase === "failed") return `Skill file reading failed${name ? ` · ${name}` : ""}`;
      if (phase === "cancelled") return `Skill file reading stopped${name ? ` · ${name}` : ""}`;
      return `${running ? "Reading" : "Read"} ${path ?? "Skill file"}${name ? ` · ${name}` : ""}`;
    }
    const label = name ? `skill “${name}”` : "Skill";
    if (phase === "failed") return `Could not load ${label}`;
    if (phase === "cancelled") return `Loading ${label} stopped`;
    return `${running ? "Loading" : "Loaded"} ${label}`;
  }
  if (origin === "artifact") {
    if (call.toolName === "read_artifact") {
      if (phase === "failed") return "Artifact reading failed";
      if (phase === "cancelled") return "Artifact reading stopped";
      return running ? "Reading artifact" : "Read artifact";
    }
    if (phase === "failed") return "Artifact creation failed";
    if (phase === "cancelled") return "Artifact creation stopped";
    return running ? "Creating artifact" : "Artifact ready";
  }
  if (origin === "image") {
    if (phase === "failed") return "Image generation failed";
    if (phase === "cancelled") return "Image generation stopped";
    return running ? "Creating image" : "Image ready";
  }
  if (origin === "discovery") {
    if (phase === "failed") return "Tool discovery failed";
    if (phase === "cancelled") return "Tool discovery stopped";
    return running ? "Finding relevant tools" : "Found relevant tools";
  }
  if (origin === "knowledge") {
    if (phase === "failed") return "Knowledge search unavailable";
    if (phase === "cancelled") return "Knowledge search stopped";
    return running ? "Searching Knowledge" : "Searched Knowledge";
  }
  if (origin === "web_search") {
    if (phase === "failed") return "Web search failed";
    if (phase === "cancelled") return "Web search stopped";
    return running ? "Searching the web" : "Searched the web";
  }
  // Workspace steps are owned by the activity timeline; the generic row must
  // never expose a raw sandbox tool identifier.
  if (origin === "workspace") {
    if (phase === "failed") return "Workspace step failed";
    if (phase === "cancelled") return "Workspace step stopped";
    return running ? "Working in Workspace" : "Worked in Workspace";
  }
  const human = humanizeToolName(safeToolName(call.toolName) ?? "");
  const serverName = safeServerName(call.serverName) ?? (origin === "mcp" ? "MCP server" : null);
  const operation = serverName ? `${serverName}${human ? `: ${human}` : ""}` : human;
  if (phase === "failed") return operation ? `${operation} failed` : "Tool failed";
  if (phase === "cancelled") return operation ? `${operation} stopped` : "Tool stopped";
  if (serverName) {
    return `${running ? "Using" : "Used"} ${operation}`;
  }
  if (human) return `${running ? "Running" : "Ran"} ${human}`;
  return running ? "Running tools" : "Used tools";
}

export type AnswerProcessFactsV2 = Readonly<{
  hasReasoning: boolean;
  memoryCount: number;
  pastChatCount?: number;
  stepCount: number;
  workDurationMs: number | null;
}>;

/** "a few seconds" under 5 s, then 12s · 1m 4s · 1h 2m. */
export function formatWorkDurationV2(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 5) return "a few seconds";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/** Sum of the settled step durations: the fallback work time when the run recorded none. */
export function stepDurationSumV2(activity: ThreadToolActivity | null | undefined): number | null {
  const durations = (activity?.calls ?? [])
    .map((call) => call.durationMs)
    .filter((duration): duration is number => typeof duration === "number" && duration >= 0);
  return durations.length > 0 ? durations.reduce((total, duration) => total + duration, 0) : null;
}

/**
 * The settled process line reads the way a person would say it — "Thought
 * for 12s", "Worked for 1m 4s" — followed by separate context counts.
 * Only facts that exist appear; none at all means no line.
 */
export function answerProcessLabelV2(facts: AnswerProcessFactsV2): string | null {
  const segments: string[] = [];
  if (facts.stepCount > 0 || facts.hasReasoning) {
    if (facts.workDurationMs === null) {
      segments.push(facts.stepCount > 0 ? "Steps" : "Thought process");
    } else {
      const verb = facts.stepCount > 0 ? "Worked" : "Thought";
      segments.push(`${verb} for ${formatWorkDurationV2(facts.workDurationMs)}`);
    }
  }
  if ((facts.pastChatCount ?? 0) > 0) {
    segments.push(formatMemoryUiCopy("source.pastChatsHeading", { count: facts.pastChatCount! }));
  }
  if (facts.memoryCount > 0) {
    segments.push(formatMemoryUiCopy("source.heading", { count: facts.memoryCount }));
  }
  return segments.length > 0 ? segments.join(" · ") : null;
}

function activityLabel(signal: Omit<ActivitySignal, "index">): string {
  switch (signal.kind) {
    case "synthesis":
      return signal.budget
        ? `Tool ${signal.budget.kind === "calls" ? "call" : "round"} limit (${signal.budget.limit}) reached. Finishing the answer…`
        : "Finishing the answer…";
    case "search":
      return "Searching the web…";
    case "tool":
      return `${describeToolCallV2(signal, "running")}…`;
    case "compute":
      return "Computing…";
    case "compaction":
      return "Compacting context…";
    case "preview":
      return "Rendering preview…";
    case "provider":
      return "Thinking…";
  }
}

export type ContextCompactionCopyV2 = Readonly<{
  /** Fold and announcer label; a failure keeps its whole bounded reason. */
  label: string;
  /** Optional sentence under the label in the fold's Context section. */
  detail: string | null;
}>;

/**
 * Copy for the server-published compaction state only. A cycle whose live
 * feed was lost reads as lost, never as still compacting; an unknown outcome
 * appears only when the server published it.
 */
export function contextCompactionCopyV2(
  status: ContextCompactionStatus,
  options: Readonly<{ connectionLost?: boolean }> = {}
): ContextCompactionCopyV2 {
  if (status.state === "running") {
    return options.connectionLost
      ? {
          detail: "The connection was lost while the context was being compacted. Refresh to see the confirmed outcome.",
          label: "Context compaction · connection lost"
        }
      : {
          detail: "Summarizing earlier messages to fit the working context. The answer continues after this step.",
          label: "Compacting context…"
        };
  }
  switch (status.outcome) {
    case "summary_applied":
    case "masking_applied":
      return {
        detail: status.reducedTokens !== null && status.reducedTokens > 0
          ? `Approx. ${status.reducedTokens.toLocaleString("en-US")} working-context tokens removed`
          : null,
        label: "Context compacted"
      };
    case "irreducible_overflow":
      return { detail: null, label: "Context is still too large" };
    case "source_unavailable":
      return { detail: null, label: "Context source unavailable" };
    case "provider_failed":
      return { detail: null, label: "Provider could not compact the context" };
    case "summary_failed":
      return { detail: null, label: "Context compaction failed" };
    default:
      return { detail: null, label: "Context compaction outcome unavailable" };
  }
}

/** Merges safe live call facts into an existing persisted projection. */
export function presentToolActivityV2(
  events: readonly RunEventView[],
  persisted: ThreadToolActivity | null = null
): ThreadToolActivity | null {
  const calls = [...(persisted?.calls ?? [])];
  let warning = persisted?.warning;
  const matched = new Set<number>();
  for (const event of events) {
    const payload = eventPayload(event);
    if (event.type === "artifact" && isRecord(event.data) && event.data.artifactType === "tool_budget") {
      warning = decodeThreadToolBudgetWarning(payload) ?? warning;
      continue;
    }
    if (event.type !== "artifact" || !isRecord(event.data) ||
      event.data.artifactType !== "tool_call" || payload?.status !== "requested") continue;
    const metadata = toolActivityMetadata(payload);
    const { origin, toolName, serverName } = metadata;
    const round = Number.isSafeInteger(payload.round) && Number(payload.round) > 0
      ? Number(payload.round)
      : null;
    if (!toolName || round === null) continue;
    const existing = calls.findIndex((call, index) =>
      !matched.has(index) && call.round === round && safeToolName(call.toolName) === toolName &&
      safeServerName(call.serverName) === (serverName ?? null) &&
      (!call.origin || !origin || call.origin === origin));
    if (existing >= 0) {
      if (origin && !calls[existing]!.origin) calls[existing] = { ...calls[existing]!, origin };
      matched.add(existing);
      continue;
    }
    calls.push({
      ...metadata,
      round,
      status: "running",
      toolName
    });
  }
  return calls.length > 0 || warning
    ? { calls, ...(warning ? { warning } : {}) }
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
  const failure = { ...eventFailure, ...state.failure };
  if (isToolSynthesisFailure(failure.code, failure.message)) {
    return { ...TOOL_SYNTHESIS_FAILURE, recovery: "regenerate" };
  }
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
  let compaction = contextCompactionFromEvents(state.events, state.contextCompaction);
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
    if (activity && (activity.kind !== "compaction" || compaction?.state === "running")) activitySignals.push(activity);

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
  // A settled answer can be observed before its compaction settlement (resume
  // marks the message complete before the chat refresh): nothing is shown
  // until the server's settled cycle arrives, never a guessed outcome.
  if (terminal) compaction = terminalContextCompactionStatus(compaction);
  const present = (value: RunPresentationV2): RunPresentationV2 =>
    compaction ? { ...value, compaction } : value;

  if (terminal === "complete") {
    return present({ kind: "complete", runId: state.runId });
  }
  if (terminal === "cancelled") {
    return present({ kind: "cancelled", runId: state.runId });
  }
  if (terminal === "error") {
    const pdfFailed = state.pdfPreparation?.some((item) => item.phase === "failed");
    const failure = pdfFailed ? {
      code: null,
      message: state.pdfPreparation!.every((item) => item.route === "local_text")
        ? "This PDF could not be read. Try a different file." : "Document preparation could not finish.",
      recovery: state.pdfPreparation!.some((item) => item.retryable) ? "retry" as const : "change_parameters" as const
    } : failureFromState(state, eventFailure);
    const recoverable = (pdfFailed || state.content.trim().length > 0) && failure.recovery === "retry";
    return present({
      failure,
      kind: recoverable ? "recoverable_error" : "terminal_error",
      runId: state.runId
    });
  }

  if (state.workspacePreparation) {
    return present({ activity: { kind: "preparing", label: "Preparing workspace..." }, kind: "activity", runId: state.runId });
  }

  const pendingDocuments = state.pdfPreparation?.filter((item) =>
    ["checking", "preparing", "assembling"].includes(item.phase));
  if (pendingDocuments?.length) {
    const documents = state.pdfPreparation!;
    const known = documents.every((item) => item.pageCount !== null);
    const completed = documents.reduce((sum, item) => sum + item.completedPages, 0);
    const total = documents.reduce((sum, item) => sum + (item.pageCount ?? 0), 0);
    const label = pendingDocuments.some((item) => item.phase === "checking")
      ? "Checking document…"
      : pendingDocuments.every((item) => item.phase === "assembling") ? "Assembling document…"
      : known ? `Preparing ${documents.length === 1 ? "document" : "documents"} · ${completed} of ${total} pages…`
      : "Preparing documents…";
    return present({ activity: { kind: "preparing", label }, kind: "activity", runId: state.runId });
  }

  if (state.connectionLost) {
    return present({ kind: "connection_lost", runId: state.runId });
  }

  if (compaction?.state === "running") {
    return present({ activity: { kind: "compaction", label: "Compacting context…" }, kind: "activity", runId: state.runId });
  }

  const selectedActivity = activitySignals.at(-1) ?? null;
  if (latestTokenIndex >= 0 && latestTokenIndex >= (selectedActivity?.index ?? -1)) {
    return present({ kind: "streaming", runId: state.runId });
  }

  if (selectedActivity) {
    const { index: _index, ...signal } = selectedActivity;
    return present({
      activity: {
        ...signal,
        label: activityLabel(signal)
      },
      kind: "activity",
      runId: state.runId
    });
  }

  const activity = statusActivity(state.status);
  return present(activity
    ? { activity, kind: "activity", runId: state.runId }
    : { kind: "idle", runId: state.runId });
}
