import { decodeMemorySearchActivity } from "@/lib/contracts/memorySearchActivity";
import { decodeFetchUrlTarget } from "@/lib/contracts/fetchUrlActivity";
import { CHAT_PDF_READER_OUTPUT_LIMIT, isChatPdfReaderOutputLimitFailure, type ChatPdfPreparationWire } from "@/lib/contracts/chatPdfPreparation";
import {
  continuableRunFailure,
  isToolSynthesisFailure,
  TOOL_SYNTHESIS_FAILURE,
  type ModelRunStatus,
  type RunEventView
} from "@/lib/contracts/runs";
import {
  isThreadToolActivityOrigin,
  decodeThreadToolBudgetWarning,
  type ThreadToolActivity,
  type ThreadToolActivityCall,
  type ThreadToolActivityOrigin,
  type ThreadToolBudgetWarning
} from "@/lib/contracts/chats";
import { formatMemoryUiCopy, memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { decodeThreadSearchActivitySnapshot, mergeThreadSearchEngineActivity } from "@/lib/contracts/searchActivity";
import { decodeContextCompactionStatus, mergeContextCompactionStatus, terminalContextCompactionStatus, type ContextCompactionStatus } from "@/lib/contracts/contextCompaction";
import { decodeReasoningHeading } from "@/lib/domain/reasoningHeading";

export type RunLifecycleStatusV2 = ModelRunStatus | "preparing";

/** `continue`: the answer's work is kept and an ordinary next turn picks it up. */
export type RunRecoveryV2 = "change_parameters" | "continue" | "regenerate" | "retry";

export type RunFailureV2 = Readonly<{
  code?: string | null;
  message?: string | null;
  recovery?: RunRecoveryV2;
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
  | "compaction"
  | "files"
  | "preparing"
  | "provider"
  | "queued"
  /** A model request after tool work. It reads their results
   * but shows the run's waiting phrase like any other model wait: in a tool
   * loop that is most of the run (operator decision 2026-10-21). */
  | "results"
  | "search"
  | "synthesis"
  | "tool";

export type RunPresentationV2 = Readonly<{
  activity?: Readonly<{
    kind: RunActivityKindV2;
    label: string;
    budget?: ThreadToolBudgetWarning;
    origin?: ThreadToolActivityOrigin;
    /** The model's latest streamed reasoning heading since this activity
     * began: untrusted, bounded plain text that replaces the waiting label
     * only where the user shows reasoning. */
    reasoningHeading?: string;
    serverName?: string;
    toolName?: string;
  }>;
  compaction?: ContextCompactionStatus;
  /** Server-settled failed cycles that a later cycle superseded before this
   * projection, oldest first. The saved answer keeps only its latest cycle,
   * so these come from the live or replayed event feed. */
  compactionFailures?: readonly ContextCompactionStatus[];
  failure?: Readonly<{
    code: string | null;
    message: string;
    recovery: RunRecoveryV2;
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
  /** This run streamed reasoning headings: its process line keeps its slot
   * while the answer text streams. */
  reasoningObserved?: true;
  runId: string | null;
}>;

type TerminalSignal = "cancelled" | "complete" | "error";

type ActivitySignal = Readonly<{
  index: number;
  kind: Exclude<RunActivityKindV2, "preparing" | "queued">;
  budget?: ThreadToolBudgetWarning;
  fetchTarget?: string;
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
  const fetchTarget = payload.origin === "web_fetch" ? decodeFetchUrlTarget(payload.fetchTarget) : null;
  return {
    ...skillActivityMetadata(payload),
    ...(fetchTarget ? { fetchTarget } : {}),
    ...(isThreadToolActivityOrigin(payload.origin) ? { origin: payload.origin } : {}),
    ...(serverName ? { serverName } : {}),
    ...(toolName ? { toolName } : {})
  };
}

/** A live call's identity in its run (`liveToolCallStatus`): its round and its position in that round. */
function liveToolCallKey(payload: Record<string, unknown>): string | null {
  const { ordinal, round } = payload;
  return Number.isSafeInteger(round) && Number(round) > 0 && Number.isSafeInteger(ordinal) && Number(ordinal) >= 0
    ? `${Number(round)}:${Number(ordinal)}` : null;
}

/** A live call's settlement: its outcome and whole duration; anything malformed is ignored. */
function liveToolCallSettlement(payload: Record<string, unknown>): Readonly<{ durationMs?: number; status: "complete" | "error" }> | null {
  if (payload.status !== "complete" && payload.status !== "error") return null;
  const { durationMs } = payload;
  if (durationMs !== undefined && !(Number.isSafeInteger(durationMs) && Number(durationMs) >= 0)) return null;
  return { status: payload.status, ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}) };
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

/** Every server-published cycle once, oldest first. Within one cycle a
 * settlement wins over progress, and the saved fallback is the earliest source. */
function contextCompactionCycles(
  events: readonly RunEventView[],
  fallback: ContextCompactionStatus | null | undefined
): ContextCompactionStatus[] {
  const cycles = new Map<number, ContextCompactionStatus>();
  const observe = (status: ContextCompactionStatus) => {
    cycles.set(status.cycle, mergeContextCompactionStatus(cycles.get(status.cycle), status) ?? status);
  };
  if (fallback) observe(fallback);
  for (const event of events) {
    if (event.type !== "artifact" || !isRecord(event.data) ||
      event.data.artifactType !== "context_compaction") continue;
    const status = decodeContextCompactionStatus(event.data.payload);
    if (status) observe(status);
  }
  return [...cycles.values()].sort((left, right) => left.cycle - right.cycle);
}

/** `resultsPending`: tool work was shown earlier in this feed. */
function activityFromEvent(event: RunEventView, index: number, resultsPending: boolean): ActivitySignal | null {
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

  if (artifactType === "memory_search_activity") {
    const activity = decodeMemorySearchActivity(payload);
    if (!activity) return null;
    return activity.status === "running"
      ? { index, kind: "tool", origin: "memory", serverName: "Memory", toolName: "memory_search" }
      : { index, kind: "provider" };
  }

  if (artifactType === "tool_call" && payload.status === "requested") {
    return { index, kind: "tool", ...toolActivityMetadata(payload) };
  }

  if (artifactType !== "summary") return null;

  // Server phases (`liveRunPhaseStatus`): the server names the phase, the words are ours.
  if (payload.stage === "tools" && payload.status === "running") {
    return { index, kind: "tool", ...toolActivityMetadata(payload) };
  }

  if (payload.stage === "files" && payload.status === "running") {
    return { index, kind: "files" };
  }

  if (payload.stage === "model" && payload.status === "waiting") {
    return { index, kind: resultsPending ? "results" : "provider" };
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
  memorySearchOutcome?: unknown;
  fetchTarget?: unknown;
  fetchOutcome?: unknown;
  fetchHttpStatus?: unknown;
  fetchRefusalScope?: unknown;
  fetchContentKind?: unknown;
}>;

/** Why a page link was refused, worded by how the owner allows it. */
function notInConversationCopy(target: string, scope: unknown): string {
  switch (scope) {
    case "scheduled_run": return `Didn't read ${target}: open the automation and save its instructions to allow this link`;
    case "task_instructions": return `Didn't read ${target}: links in an automation's instructions are read only by that automation's runs`;
    default: return `Skipped ${target}: only links from this chat or web search are read`;
  }
}

/**
 * A page read the run skipped by its own rules (a link it may not read, or
 * its page limit): nothing was sent and nothing failed, so the step stays
 * neutral instead of reading as an error.
 */
export function fetchCallSkippedV2(call: ToolActivityIdentity): boolean {
  return call.fetchOutcome === "fetch_url_not_in_conversation" || call.fetchOutcome === "fetch_url_limit_reached";
}

/** A page read's row: "Reading <host/path>", then its outcome in plain words. */
function describeFetchCallV2(call: ToolActivityIdentity, phase: "cancelled" | "failed" | "running" | "settled"): string {
  const target = decodeFetchUrlTarget(call.fetchTarget) ?? "web page";
  const pdf = call.fetchContentKind === "pdf";
  if (phase === "running") return `Reading ${target}`;
  if (phase === "cancelled") return `Reading ${target} stopped`;
  if (phase === "settled" && (call.fetchOutcome === undefined || call.fetchOutcome === "read")) {
    return pdf ? `Read PDF ${target}` : `Read ${target}`;
  }
  switch (call.fetchOutcome) {
    case "fetch_url_not_in_conversation": return notInConversationCopy(target, call.fetchRefusalScope);
    case "fetch_blocked_address":
    case "fetch_port_not_allowed":
    case "fetch_url_credentials":
    case "fetch_url_invalid":
    case "fetch_redirect_invalid": return `Blocked ${target}: this address is not allowed`;
    case "fetch_redirect_limit": return `Couldn't read ${target}: too many redirects`;
    case "fetch_timeout": return `Couldn't read ${target}: the ${pdf ? "PDF" : "page"} took too long`;
    case "fetch_too_large": return `Couldn't read ${target}: the ${pdf ? "PDF" : "page"} is too large`;
    case "fetch_unsupported_content_type": return `Couldn't read ${target}: not a web page or PDF, upload the file instead`;
    case "fetch_http_status": {
      const status = typeof call.fetchHttpStatus === "number" ? ` ${call.fetchHttpStatus}` : " an error";
      return `Couldn't read ${target}: the site returned${status}`;
    }
    case "fetch_network_error": return `Couldn't read ${target}: the site is unreachable`;
    case "fetch_no_readable_text": return pdf ? `No readable text in PDF ${target}, it may be scanned` : `No readable text on ${target}`;
    case "fetch_pdf_password_protected": return `Couldn't read ${target}: the PDF is password-protected`;
    case "fetch_pdf_invalid": return `Couldn't read ${target}: the PDF is damaged or unreadable`;
    case "fetch_pdf_too_many_pages": return `Couldn't read ${target}: the PDF has too many pages`;
    case "fetch_reader_unavailable": return `Couldn't read ${target}: page reading is unavailable`;
    case "fetch_url_limit_reached": return `Skipped ${target}: page limit for this answer reached`;
    case "fetch_url_interrupted": return `Reading ${target} was interrupted`;
    default: return `Couldn't read ${target}`;
  }
}

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
  if ((!call.serverName || serverName === "Web search") &&
    webSearchToolNames.has(toolName.toLowerCase())) return "web_search";
  return call.serverName ? "mcp" : "tool";
}

/**
 * User-legible label for one tool call (FRONTEND contract: only user-legible
 * server/tool names). Built-in tools get a plain-language verb; MCP tools
 * keep their server name plus a de-snaked tool name. Raw identifiers such as
 * `find_tools` never reach the thread.
 */
export function describeToolCallV2(
  call: ToolActivityIdentity,
  /** `held`: never sent, waiting for the user's approval (only MCP calls are gated). */
  phase: "cancelled" | "failed" | "held" | "running" | "settled"
): string {
  const running = phase === "running";
  const origin = toolActivityOriginV2(call);
  // The agent handed the live browser to the user (`features/browser-live/`).
  if ((origin === "tool" || origin === "workspace") && safeToolName(call.toolName) === "browser_handoff") {
    if (phase === "failed") return "Browser handoff failed";
    if (phase === "cancelled") return "Browser handoff stopped";
    return running ? "Waiting for you in the browser" : "Asked for your help in the browser";
  }
  if (origin === "skill") {
    const name = boundedText(call.skillName, 160);
    const path = boundedText(call.skillPath, 256);
    if (call.toolName === "read_skill_file") {
      if (phase === "failed") return `Skill file reading failed${name ? ` · ${name}` : ""}`;
      if (phase === "cancelled") return `Skill file reading stopped${name ? ` · ${name}` : ""}`;
      return `${running ? "Reading" : "Read"} ${path ?? "Skill file"}${name ? ` · ${name}` : ""}`;
    }
    if (call.toolName === "save_skill") {
      if (phase === "failed") return "Skill was not saved";
      if (phase === "cancelled") return "Saving Skill stopped";
      return running ? "Saving Skill" : "Saved Skill";
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
  if (origin === "vision") {
    if (phase === "failed") return "Image analysis failed";
    if (phase === "cancelled") return "Image analysis stopped";
    return running ? "Analyzing image" : "Analyzed image";
  }
  if (origin === "discovery") {
    if (phase === "failed") return "Tool discovery failed";
    if (phase === "cancelled") return "Tool discovery stopped";
    return running ? "Finding relevant tools" : "Found relevant tools";
  }
  if (origin === "memory" && call.toolName === "memory_search") {
    // Failed searches are not listed (memorySearchCallHiddenV2) and limits stay
    // with the model; neither ever reaches the user as a failure.
    if (phase === "cancelled" || call.memorySearchOutcome === "cancelled") return "Memory search stopped";
    if (running) return "Searching memory";
    if (call.memorySearchOutcome === "no_results") return "No matching memories found";
    return "Searched memory";
  }
  if (origin === "web_fetch") return describeFetchCallV2(call, phase === "held" ? "settled" : phase);
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
  if (phase === "held") return operation || "Tool call";
  if (phase === "failed") return operation ? `${operation} failed` : "Tool failed";
  if (phase === "cancelled") return operation ? `${operation} stopped` : "Tool stopped";
  if (serverName) {
    return `${running ? "Using" : "Used"} ${operation}`;
  }
  if (human) return `${running ? "Running" : "Ran"} ${human}`;
  return running ? "Running tools" : "Used tools";
}

/** A failed Memory search is dropped from the process steps entirely. */
export function memorySearchCallHiddenV2(call: ToolActivityIdentity & Readonly<{ status?: unknown }>): boolean {
  return toolActivityOriginV2(call) === "memory" && call.toolName === "memory_search" &&
    call.memorySearchOutcome !== "cancelled" &&
    (call.status === "error" || call.memorySearchOutcome === "failure");
}

/** A call of the plan tool: the answer shows the plan it set, not the call. */
export function planCallHiddenV2(call: ToolActivityIdentity): boolean {
  return toolActivityOriginV2(call) === "session" && call.toolName === "update_plan";
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

/**
 * The neutral waiting phrases (operator decision 2026-10-20). An answer shows
 * one of them while the model works without a more specific status: chosen
 * from its run id, so it stays the same across renders and reconnects, never
 * rotates, and never names work that is not happening.
 */
export const RUN_WAITING_PHRASES_V2 = Object.freeze([
  "Thinking…",
  "Pondering…",
  "Mulling it over…",
  "Working on it…",
  "Considering…",
  "Reflecting…",
  "Deliberating…",
  "Musing…"
] as const);

/** The run's waiting phrase (FNV-1a of its id); a run not yet accepted has none of its own. */
export function runWaitingPhraseV2(runId: string | null): string {
  if (!runId) return RUN_WAITING_PHRASES_V2[0];
  let hash = 0x811c9dc5;
  for (let index = 0; index < runId.length; index += 1) {
    hash = Math.imul(hash ^ runId.charCodeAt(index), 0x01000193);
  }
  return RUN_WAITING_PHRASES_V2[(hash >>> 0) % RUN_WAITING_PHRASES_V2.length]!;
}

function activityLabel(signal: Omit<ActivitySignal, "index">, runId: string | null): string {
  switch (signal.kind) {
    case "synthesis":
      return signal.budget
        ? `Tool ${signal.budget.kind === "calls" ? "call" : "round"} limit (${signal.budget.limit}) reached. Finishing the answer…`
        : "Finishing the answer…";
    case "search":
      return "Searching the web…";
    case "tool":
      return `${describeToolCallV2(signal, "running")}…`;
    case "compaction":
      return "Compacting context…";
    case "files":
      return "Reading files…";
    case "results":
    case "provider":
      return runWaitingPhraseV2(runId);
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
          detail: "Summarizing earlier messages to fit the working context. The answer starts after this step.",
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

/**
 * The announcer's input: a run projection with, when the caller knows it, the
 * id of the tail answer it belongs to. Without it the announcer cannot tell an
 * older settled answer returning to the tail from the followed one settling.
 */
export type AnnouncedRunPresentationV2 = RunPresentationV2 & Readonly<{ answerId?: string }>;

/** What the run announcer remembers about the one answer it follows. */
export type RunAnnouncerMemoryV2 = Readonly<{
  chatId: string;
  runId: string | null;
  /** The observed tail answer, when the caller names it. */
  answerId: string | null;
  /** The settled tail answer a followed run started after, when named. */
  priorAnswerId: string | null;
  /** Settled when first observed: history is never announced. */
  historical: boolean;
  started: boolean;
  connectionLost: boolean;
  compactionStarted: boolean;
  compactionSucceeded: boolean;
  /** Highest server-settled compaction cycle already accounted for. */
  settledCycle: number;
  /** The terminal sentence once the run settled while followed. */
  terminal: string | null;
}>;

export type RunAnnouncementStepV2 = Readonly<{
  memory: RunAnnouncerMemoryV2;
  /** A different chat (or the first observation): pending speech is stale. */
  chatChanged: boolean;
  /** Phase sentences, in order, to speak before any terminal sentence. */
  parts: readonly string[];
  /** Terminal sentence to speak last; repeated only to fold a later compaction settlement into it. */
  terminal: string | null;
  /** True when `terminal` is first observed for this run. */
  terminalFirst: boolean;
  /** The followed answer left without settling (a refused send rolled back to
   * no answer or to the earlier one): its spoken phase and pending speech are
   * stale, and nothing replaces them. */
  withdrawn: boolean;
}>;

const RUN_ANNOUNCEMENT_WORKING_V2 = "Working on the answer…";

function sentence(text: string): string {
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

function terminalAnnouncement(presentation: RunPresentationV2): string {
  if (presentation.kind === "complete") return "Answer ready. The message field is available.";
  if (presentation.kind === "cancelled") return "Run stopped. The message field is available.";
  const reason = presentation.failure?.message ? ` ${sentence(presentation.failure.message)}` : "";
  return `Run failed.${reason} The message field is available.`;
}

function connectionLostAnnouncement(presentation: RunPresentationV2): string {
  return presentation.compaction?.state === "running"
    ? "Connection lost while compacting context. Refresh the run state."
    : "Connection lost. Refresh the run state.";
}

/**
 * Announcer policy: only phase kinds are spoken, never counters, tool labels
 * or streaming/tool flips. Per followed run: started once; connection lost
 * once per loss; compaction start once, every failed cycle with its reason
 * (also one superseded by a later cycle before it was observed), success at
 * most once; the terminal sentence with its reason once. A compaction
 * settlement after the terminal sentence folds into it. A run already settled
 * when first observed (chat switch, history load) stays silent; an answer
 * without a run id continues the followed one only after it had started. A
 * started answer that leaves the tail unsettled (an answer tail is never idle,
 * or the settled answer it started after is the tail again) withdraws its
 * phase silently: the refusal that removed it speaks for itself, and the next
 * answer is a new run.
 */
export function stepRunAnnouncementV2(
  previous: RunAnnouncerMemoryV2 | null,
  chatId: string,
  presentation: AnnouncedRunPresentationV2
): RunAnnouncementStepV2 {
  const chatChanged = !previous || previous.chatId !== chatId;
  const compaction = presentation.compaction;
  const settled = settledRunPresentationV2(presentation);
  const previousSettled = Boolean(previous && (previous.historical || previous.terminal !== null));
  const answerId = presentation.answerId ?? null;
  // An answer settled in place keeps its id, so the prior answer only returns
  // under an id the followed answer no longer has.
  const withdrawn = Boolean(!chatChanged && previous?.started && !previousSettled && (presentation.kind === "idle" ||
    (settled && answerId !== null && answerId === previous.priorAnswerId && answerId !== previous.answerId)));
  // A settled run never becomes live again; an unsettled answer adopts its
  // durable run id without becoming a new run.
  // Two missing run ids are no evidence of one answer: an empty or loading
  // chat followed by a settled tail without a run id is history.
  const sameRun = !chatChanged && !withdrawn && !(previousSettled && !settled) && (
    (previous.runId === presentation.runId && (presentation.runId !== null || previous.started)) ||
    (previous.runId === null && previous.started && !previousSettled));
  const failures = presentation.compactionFailures ?? [];
  if (!sameRun || !previous) {
    const settledCycle = Math.max(
      compaction && compaction.state !== "running" ? compaction.cycle : 0,
      ...failures.map((status) => status.cycle)
    );
    const base = {
      answerId,
      chatId,
      compactionStarted: Boolean(compaction) || failures.length > 0,
      compactionSucceeded: compaction?.state === "complete",
      connectionLost: false,
      historical: settled,
      priorAnswerId: null,
      runId: presentation.runId,
      settledCycle,
      started: false,
      terminal: settled ? terminalAnnouncement(presentation) : null
    };
    if (settled || presentation.kind === "idle") {
      return { chatChanged, memory: base, parts: [], terminal: null, terminalFirst: false, withdrawn };
    }
    const lost = presentation.kind === "connection_lost";
    const compacting = !lost && compaction?.state === "running";
    return {
      chatChanged,
      memory: {
        ...base,
        connectionLost: lost,
        priorAnswerId: !chatChanged && previousSettled ? previous.answerId : null,
        started: true
      },
      parts: [lost ? connectionLostAnnouncement(presentation)
        : compacting ? contextCompactionCopyV2(compaction).label : RUN_ANNOUNCEMENT_WORKING_V2],
      terminal: null,
      terminalFirst: false,
      withdrawn: false
    };
  }

  const memory: { -readonly [Key in keyof RunAnnouncerMemoryV2]: RunAnnouncerMemoryV2[Key] } = {
    ...previous,
    answerId,
    runId: presentation.runId
  };
  if (memory.historical) {
    return { chatChanged: false, memory, parts: [], terminal: null, terminalFirst: false, withdrawn: false };
  }
  const parts: string[] = [];
  if (!settled && presentation.kind !== "idle") {
    const lost = presentation.kind === "connection_lost";
    if (lost && !memory.connectionLost) parts.push(connectionLostAnnouncement(presentation));
    if (lost) {
      memory.compactionStarted ||= compaction?.state === "running";
    } else if (compaction?.state === "running" && !memory.compactionStarted) {
      parts.push(contextCompactionCopyV2(compaction).label);
      memory.compactionStarted = true;
    } else if (!memory.started) {
      parts.push(RUN_ANNOUNCEMENT_WORKING_V2);
    }
    memory.connectionLost = lost;
    memory.started = true;
  }
  for (const failure of failures) {
    if (failure.cycle <= memory.settledCycle) continue;
    parts.push(`${contextCompactionCopyV2(failure).label}.`);
    memory.compactionStarted = true;
    memory.settledCycle = failure.cycle;
  }
  if (compaction && compaction.state !== "running" && compaction.cycle > memory.settledCycle) {
    const text = `${contextCompactionCopyV2(compaction).label}.`;
    if (compaction.state === "failed") parts.push(text);
    else if (!memory.compactionSucceeded) parts.push(text);
    memory.compactionStarted = true;
    memory.compactionSucceeded ||= compaction.state === "complete";
    memory.settledCycle = compaction.cycle;
  }
  if (settled && memory.terminal === null) {
    memory.terminal = terminalAnnouncement(presentation);
    return { chatChanged: false, memory, parts, terminal: memory.terminal, terminalFirst: true, withdrawn: false };
  }
  return {
    chatChanged: false,
    memory,
    parts,
    terminal: memory.terminal !== null && parts.length > 0 ? memory.terminal : null,
    terminalFirst: false,
    withdrawn: false
  };
}

/** Merges safe live call facts into an existing persisted projection. */
export function presentToolActivityV2(
  events: readonly RunEventView[],
  persisted: ThreadToolActivity | null = null,
  terminal = false
): ThreadToolActivity | null {
  const calls = [...(persisted?.calls ?? [])];
  let searchEngines = [...(persisted?.searchEngines ?? [])];
  let warning = persisted?.warning;
  const matched = new Set<number>();
  // Rows of live calls by identity (`round:ordinal`) until they settle, and every row a live identity owns.
  const live = new Map<string, number>();
  const claimed = new Set<number>();
  for (const event of events) {
    const payload = eventPayload(event);
    if (event.type === "artifact" && isRecord(event.data) && event.data.artifactType === "search_activity") {
      const snapshot = decodeThreadSearchActivitySnapshot(payload);
      if (snapshot) searchEngines = mergeThreadSearchEngineActivity(searchEngines, snapshot.engines);
      continue;
    }
    if (event.type === "artifact" && isRecord(event.data) && event.data.artifactType === "memory_search_activity") {
      const snapshot = decodeMemorySearchActivity(payload);
      if (!snapshot) continue;
      const existing = calls.findIndex(call => call.origin === "memory" &&
        call.toolName === "memory_search" && call.round === snapshot.round && call.memorySearchCall === snapshot.call);
      const call = { origin: "memory" as const, serverName: "Memory", toolName: "memory_search",
        round: snapshot.round, memorySearchCall: snapshot.call, status: snapshot.status,
        ...(snapshot.outcome ? { memorySearchOutcome: snapshot.outcome } : {}),
        ...(snapshot.durationMs !== undefined ? { durationMs: snapshot.durationMs } : {}) };
      if (existing < 0) calls.push(call);
      else if (calls[existing]!.status === "running") calls[existing] = { ...calls[existing]!, ...call };
      continue;
    }
    if (event.type === "artifact" && isRecord(event.data) && event.data.artifactType === "tool_budget") {
      warning = decodeThreadToolBudgetWarning(payload) ?? warning;
      continue;
    }
    if (event.type !== "artifact" || !isRecord(event.data) || event.data.artifactType !== "tool_call" || !payload) continue;
    const settlement = payload.status === "requested" ? null : liveToolCallSettlement(payload);
    if (payload.status !== "requested" && !settlement) continue;
    const metadata = toolActivityMetadata(payload);
    const { origin, toolName, serverName } = metadata;
    const round = Number.isSafeInteger(payload.round) && Number(payload.round) > 0
      ? Number(payload.round)
      : null;
    if (!toolName || round === null) continue;
    // Native search has ordinal-bound snapshots, including terminal outcomes.
    if (origin === "memory" && toolName === "memory_search") continue;
    const key = liveToolCallKey(payload);
    const sameCall = (call: ThreadToolActivityCall) => call.round === round && safeToolName(call.toolName) === toolName &&
      safeServerName(call.serverName) === (serverName ?? null) && (!call.origin || !origin || call.origin === origin);
    if (settlement) {
      // Its own row by identity; a persisted row its live start was not seen for by the name match.
      const index = key !== null && live.has(key) ? live.get(key)!
        : calls.findIndex((call, candidate) => !claimed.has(candidate) && call.status === "running" && sameCall(call));
      const call = calls[index];
      // A persisted outcome stays authoritative.
      if (!call || call.status !== "running" || !sameCall(call)) continue;
      calls[index] = { ...call, status: settlement.status,
        ...(settlement.durationMs !== undefined ? { durationMs: settlement.durationMs } : {}) };
      if (key !== null) live.delete(key);
      continue;
    }
    if (key !== null && live.has(key)) continue;
    // The persisted row of exactly this call when the projection names it, else the first unmatched one alike.
    const byIdentity = key === null ? -1 : calls.findIndex((call, index) => !matched.has(index) &&
      call.details !== undefined && `${call.details.roundIndex}:${call.details.ordinal}` === key && sameCall(call));
    // A row another live identity owns is another call, not a replay of this one.
    const existing = byIdentity >= 0 ? byIdentity : calls.findIndex((call, index) => !matched.has(index) &&
      !(key !== null && claimed.has(index)) && sameCall(call));
    if (existing >= 0) {
      if (origin && !calls[existing]!.origin) calls[existing] = { ...calls[existing]!, origin };
      matched.add(existing);
      if (key !== null) {
        live.set(key, existing);
        claimed.add(existing);
      }
      continue;
    }
    if (key !== null) {
      live.set(key, calls.length);
      claimed.add(calls.length);
    }
    calls.push({
      ...metadata,
      round,
      status: "running",
      toolName
    });
  }
  if (terminal) {
    searchEngines = searchEngines.map(row => ({ ...row, settled: row.requested }));
    // A call the ended run never settled has no outcome to show: it reads as stopped, as the saved projection
    // reads such a call, never as done or failed, and it no longer spins.
    for (const [index, call] of calls.entries()) if (call.status === "running") calls[index] = { ...call, status: "cancelled" };
  }
  const visibleCalls = calls.filter(call => !memorySearchCallHiddenV2(call));
  return visibleCalls.length > 0 || warning || searchEngines.length > 0
    ? { calls: visibleCalls, ...(searchEngines.length ? { searchEngines } : {}), ...(warning ? { warning } : {}) }
    : null;
}

function statusActivity(status: RunLifecycleStatusV2 | null | undefined, runId: string | null) {
  if (status === "queued") {
    return { kind: "queued" as const, label: "Queued" };
  }
  // Until the server accepts the run (and names it) the request is still
  // being prepared; only an accepted run has its own waiting phrase.
  if (status === "preparing" || !runId && (status === "in_progress" || status === "streaming")) {
    return { kind: "preparing" as const, label: "Preparing request…" };
  }
  if (status === "in_progress" || status === "streaming") {
    return { kind: "provider" as const, label: runWaitingPhraseV2(runId) };
  }
  return null;
}

const NEUTRAL_RUN_PREPARATION_CODE_V2 = "preparation_failed";
// Run failures persisted with Memory wording, including historical messages
// already stored before the neutral server copy.
const memoryRunFailureMessagePattern = /^Memory (?:preparation|search|egress)\b|answer-model Memory tool/u;
// The external-dispatch evidence ledger keeps a historical `memory_egress_`
// prefix; its failures concern providers or MCP, not Memory.
const EGRESS_LEDGER_CODE_PREFIX = "memory_egress_";

/** Users never see Memory failures: a run that failed while preparing or
 * settling Memory keeps its recovery actions with neutral copy, and its
 * support reference never carries a `memory_` code. Egress-ledger failures
 * keep their own text and show their code without the `memory_` prefix. */
export function neutralizeMemoryRunFailureV2<T extends Readonly<{ code?: string | null; message?: string | null }>>(
  failure: T
): T {
  const egressCode = typeof failure.code === "string" && failure.code.startsWith(EGRESS_LEDGER_CODE_PREFIX);
  const memoryCode = !egressCode && typeof failure.code === "string" && failure.code.startsWith("memory_");
  const memoryMessage = typeof failure.message === "string" &&
    memoryRunFailureMessagePattern.test(failure.message.trim());
  if (!egressCode && !memoryCode && !memoryMessage) return failure;
  return {
    ...failure,
    ...(egressCode ? { code: failure.code!.slice("memory_".length) } : {}),
    ...(memoryCode ? { code: NEUTRAL_RUN_PREPARATION_CODE_V2 } : {}),
    ...(memoryMessage || memoryCode ? { message: memoryUiCopy("answer.preparationFailed") } : {})
  };
}

function failureFromState(
  state: RunLifecycleStateV2,
  eventFailure: RunFailureV2 | null
): NonNullable<RunPresentationV2["failure"]> {
  const failure = { ...eventFailure, ...state.failure };
  if (isToolSynthesisFailure(failure.code, failure.message)) {
    return { ...TOOL_SYNTHESIS_FAILURE, recovery: "regenerate" };
  }
  // Live by its code, after a reload by the saved answer's reviewed text.
  const continuable = continuableRunFailure(failure.code, failure.message);
  if (continuable) return { ...continuable, recovery: "continue" };
  const recovery = failure.recovery === "retry" ? "retry" : "change_parameters";
  const partial = state.content.trim().length > 0;
  const fallback = partial && recovery === "retry"
    ? "The answer was interrupted mid-run. The partial result is kept; you can retry with the same parameters."
    : "The run failed. Change the request parameters and try again.";

  return neutralizeMemoryRunFailureV2({
    code: safeErrorCode(failure.code),
    message: boundedText(failure.message, 600) ?? fallback,
    recovery
  });
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
  const compactionCycles = contextCompactionCycles(state.events, state.contextCompaction);
  let compaction = compactionCycles.at(-1) ?? null;
  const latestCycle = compaction?.cycle ?? 0;
  const compactionFailures = compactionCycles.filter((status) =>
    status.state === "failed" && status.cycle < latestCycle);
  let terminal: TerminalSignal | null = terminalStatus(
    state.authoritativeMessageStatus
  );
  const activitySignals: ActivitySignal[] = [];
  let latestTokenIndex = -1;
  let latestReasoning: Readonly<{ heading: string; index: number }> | null = null;
  let resultsPending = false;
  let eventFailure: RunFailureV2 | null = null;
  const settledMemorySearchCalls = new Set<string>();
  const activeMemorySearchCalls = new Set<string>();
  const activeToolCalls = new Map<string, Omit<ActivitySignal, "index">>();

  for (const [index, event] of state.events.entries()) {
    if (event.type === "token") {
      latestTokenIndex = index;
      continue;
    }

    // A reasoning heading is progress of the current phase, never a phase.
    const heading = event.type === "artifact" && isRecord(event.data) && event.data.artifactType === "summary"
      ? decodeReasoningHeading(event.data.payload) : null;
    if (heading) {
      latestReasoning = { heading, index };
      continue;
    }

    const nativeSearch = event.type === "artifact" && isRecord(event.data) && event.data.artifactType === "memory_search_activity"
      ? decodeMemorySearchActivity(event.data.payload) : null;
    const nativeKey = nativeSearch ? `${nativeSearch.round}:${nativeSearch.call}` : null;
    const lateNativeStart = nativeSearch?.status === "running" && nativeKey !== null && settledMemorySearchCalls.has(nativeKey);
    if (nativeSearch && nativeKey !== null) {
      if (nativeSearch.status !== "running") {
        settledMemorySearchCalls.add(nativeKey);
        activeMemorySearchCalls.delete(nativeKey);
      } else if (!lateNativeStart) activeMemorySearchCalls.add(nativeKey);
    }
    // A settled call no longer names the line: a call still running does, else the run's wait.
    const toolCall = event.type === "artifact" && isRecord(event.data) && event.data.artifactType === "tool_call"
      ? eventPayload(event) : null;
    const toolKey = toolCall ? liveToolCallKey(toolCall) : null;
    const toolSettled = toolCall !== null && toolKey !== null && liveToolCallSettlement(toolCall) !== null &&
      activeToolCalls.has(toolKey) &&
      (activeToolCalls.get(toolKey)!.toolName ?? null) === (toolActivityMetadata(toolCall).toolName ?? null) &&
      activeToolCalls.delete(toolKey);
    const stillRunning = toolSettled ? [...activeToolCalls.values()].at(-1) : undefined;
    const activity: ActivitySignal | null = lateNativeStart ? null
      : toolSettled ? stillRunning ? { ...stillRunning, index } : { index, kind: "provider" }
      : nativeSearch && activeMemorySearchCalls.size > 0
      ? { index, kind: "tool" as const, origin: "memory" as const, serverName: "Memory", toolName: "memory_search" }
      : activityFromEvent(event, index, resultsPending);
    if (activity?.kind === "tool" && toolCall?.status === "requested" && toolKey !== null) {
      const { index: _index, ...signal } = activity;
      activeToolCalls.set(toolKey, signal);
    }
    if (activity && (activity.kind !== "compaction" || compaction?.state === "running")) activitySignals.push(activity);
    resultsPending ||= activity?.kind === "tool";

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
  const present = (value: RunPresentationV2): RunPresentationV2 => ({
    ...value,
    ...(compaction ? { compaction } : {}),
    ...(compactionFailures.length > 0 ? { compactionFailures } : {})
  });

  if (terminal === "complete") {
    return present({ kind: "complete", runId: state.runId });
  }
  if (terminal === "cancelled") {
    return present({ kind: "cancelled", runId: state.runId });
  }
  if (terminal === "error") {
    const pdfFailed = state.pdfPreparation?.some((item) => item.phase === "failed");
    const failure = pdfFailed && isChatPdfReaderOutputLimitFailure(eventFailure?.code ?? state.failure?.code,
      state.failure?.message ?? eventFailure?.message) ? {
      code: CHAT_PDF_READER_OUTPUT_LIMIT.code, message: CHAT_PDF_READER_OUTPUT_LIMIT.message, recovery: "change_parameters" as const
    } : pdfFailed ? {
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
    return present({ kind: "streaming", runId: state.runId, ...(latestReasoning ? { reasoningObserved: true as const } : {}) });
  }
  // Only a heading the model streamed after the current phase began names it.
  const reasoningHeading = latestReasoning && latestReasoning.index > latestTokenIndex &&
    latestReasoning.index > (selectedActivity?.index ?? -1) ? latestReasoning.heading : null;

  if (selectedActivity) {
    const { index: _index, ...signal } = selectedActivity;
    return present({
      activity: {
        ...signal,
        label: activityLabel(signal, state.runId),
        ...(reasoningHeading && (signal.kind === "provider" || signal.kind === "results") ? { reasoningHeading } : {})
      },
      kind: "activity",
      runId: state.runId
    });
  }

  const activity = statusActivity(state.status, state.runId);
  return present(activity
    ? { activity: { ...activity, ...(reasoningHeading && activity.kind === "provider" ? { reasoningHeading } : {}) },
        kind: "activity", runId: state.runId }
    : { kind: "idle", runId: state.runId });
}
