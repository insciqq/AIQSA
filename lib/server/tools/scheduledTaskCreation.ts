import {
  SCHEDULED_TASK_DEFAULT_HISTORY_RETENTION_DAYS,
  SCHEDULED_TASK_EVERY_HOURS,
  SCHEDULED_TASK_HISTORY_RETENTION_DAYS,
  SCHEDULED_TASK_KINDS,
  SCHEDULED_TASK_PROMPT_MAX_LENGTH,
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  SCHEDULED_TASK_WEEKDAYS,
  scheduledTaskCard,
  scheduledTaskErrorMessage,
  type ScheduledTask,
  type ScheduledTaskHistoryRetentionDays
} from "../../contracts/scheduledTasks";
import { describeScheduledTaskSchedule } from "../../domain/scheduledTaskSchedule";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { NormalizedRunRequest } from "../providers/types";
import type { RunRepository, ScheduledTaskCallRefusal } from "../runs/runRepositoryContract";
import { isFetchUrlPlan } from "./fetchUrlPlan";
import { resolveScheduledTaskSkillReferences, SCHEDULED_TASK_SKILLS_SCHEMA, scheduledTaskModelSkills } from "./scheduledTaskSkills";
import { hasInvalidProviderToolArguments, type ModelToolCall, type RunTool, type ToolExecutionResult } from "./types";

/**
 * The one built-in tool through which a chat model creates a scheduled task
 * for the run's owner, directly and without a confirmation step (an operator
 * decision recorded in the run contracts). Admission offers it only to an
 * ordinary personal run (`NormalizedRunRequest.scheduledTaskTool`, frozen
 * there with the settings a created task takes). Execution creates through the
 * owner API's rules and limits; the creation settles the call in its own
 * transaction, so an interrupted call never creates twice. Its writes are
 * server-owned and send nothing out of the installation, hence the `session`
 * class; it is never read-only (`toolReadOnly.ts`).
 */
export const CREATE_SCHEDULED_TASK_TOOL_NAME = "create_scheduled_task";

export type ScheduledTaskToolSettings = NonNullable<NormalizedRunRequest["scheduledTaskTool"]>;
type ScheduledTaskToolRequest = Readonly<{
  /** The run's frozen page-reading authority; its user digests bound the created prompt's links. */
  fetchUrl?: unknown;
  prompt: Readonly<{ baseline?: Readonly<{ timeZone: string; timeZoneSource: "client" | "utc_fallback" }> }>;
  scheduledTaskTool?: ScheduledTaskToolSettings;
  /** The run's frozen Skill manifest: the only Skills a created task may pin. */
  skills?: unknown;
}>;
export type ScheduledTaskCallCreator = NonNullable<RunRepository["createScheduledTaskForCall"]>;

const SETTINGS_KEYS = ["modelId", "provider", "searchEnabled", "toolsEnabled", "workspaceEnabled", "memoryEnabled"];
const ARGUMENT_KEYS = ["title", "prompt", "kind", "chatMode", "schedule", "skills", "historyRetentionDays"];

/**
 * Whether the creating run came from a Telegram message (it has a
 * `TelegramRunLink`): its task then sends results to Telegram. The tool
 * receives the run's id from its execution context (`context.runId`, the
 * persisted run the call belongs to) and asks this lookup about it.
 */
export type ScheduledTaskTelegramOrigin = (run: Readonly<{ runId: string; userId: string }>) => Promise<boolean>;

const TELEGRAM_ORIGIN = Symbol.for("aiqsa.scheduled-task-telegram-origin.v1");
const originSlot = globalThis as typeof globalThis & { [TELEGRAM_ORIGIN]?: ScheduledTaskTelegramOrigin };

/**
 * Set when the scheduled task runner starts; the slot is process-global,
 * shared by every route bundle, so the tool never loads Telegram itself.
 * Without it every created task starts with Telegram delivery off.
 */
export function registerScheduledTaskTelegramOrigin(origin: ScheduledTaskTelegramOrigin | undefined): void {
  originSlot[TELEGRAM_ORIGIN] = origin;
}

/** A failed lookup creates the task as the web would, with Telegram delivery off. */
async function createdFromTelegram(
  origin: ScheduledTaskTelegramOrigin | undefined,
  run: Readonly<{ runId: string; userId: string }>
): Promise<boolean> {
  if (!origin) return false;
  try {
    return await origin(run) === true;
  } catch (error) {
    logEvent("service_operation", {
      error, subsystem: "telegram", stage: "read", outcome: "degraded", action: "degrade", prisma_code: databaseFailureCode(error)
    });
    return false;
  }
}

/** The tools' spelling of "keep old chats forever" (the owner contract's null). */
export const SCHEDULED_TASK_TOOL_HISTORY_FOREVER = 0;

/**
 * A tool's history retention as the owner contract's value: 30, 90 or 365
 * days, `SCHEDULED_TASK_TOOL_HISTORY_FOREVER` for forever; null when invalid.
 */
export function scheduledTaskToolHistoryRetention(value: unknown): Readonly<{ days: ScheduledTaskHistoryRetentionDays }> | null {
  if (value === SCHEDULED_TASK_TOOL_HISTORY_FOREVER) return { days: null };
  return (SCHEDULED_TASK_HISTORY_RETENTION_DAYS as readonly unknown[]).includes(value)
    ? { days: value as ScheduledTaskHistoryRetentionDays } : null;
}

/** How long a task keeps its old chats, as a tool result tells the model. */
export function scheduledTaskToolHistoryText(days: ScheduledTaskHistoryRetentionDays): string {
  return days === null ? "forever" : `${days} days`;
}
const SCHEDULE_FIELDS = {
  once: ["date"], daily: [], weekly: ["days"], monthly: ["dayOfMonth"], hourly: ["everyHours", "until", "days"]
} as const satisfies Record<string, readonly string[]>;
const OPTIONAL_SCHEDULE_FIELDS = ["date", "days", "dayOfMonth", "everyHours", "until"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The frozen marker's exact shape, as recovery decodes an accepted request.
 * A run accepted before tasks had Memory froze no `memoryEnabled`.
 */
export function isScheduledTaskToolSettings(value: unknown): value is ScheduledTaskToolSettings {
  return isRecord(value) && Object.keys(value).every((key) => SETTINGS_KEYS.includes(key)) &&
    typeof value.modelId === "string" && value.modelId.length > 0 && value.modelId.length <= 256 &&
    typeof value.provider === "string" && value.provider.length > 0 && value.provider.length <= 256 &&
    typeof value.searchEnabled === "boolean" && typeof value.toolsEnabled === "boolean" &&
    typeof value.workspaceEnabled === "boolean" &&
    (value.memoryEnabled === undefined || typeof value.memoryEnabled === "boolean");
}

/** The run's frozen zone: the browser's, or UTC when admission had none (`utc_fallback`). */
function runTimeZone(request: ScheduledTaskToolRequest): Readonly<{ fallback: boolean; timeZone: string }> {
  const baseline = request.prompt.baseline;
  return baseline ? { fallback: baseline.timeZoneSource !== "client", timeZone: baseline.timeZone } : { fallback: true, timeZone: "UTC" };
}

/** The tool as a run offers it; its text names the run's frozen time zone. */
export function createScheduledTaskTool(timeZone: string): RunTool {
  return {
    capability: "session",
    // Every ordinary chat request carries this text, so it stays short; the schema describes each field.
    description: [
      "Create an automation: a saved instruction that runs automatically with this chat's model and settings;",
      "its answers appear in the automation's own chat. Use it only when the user's current message asks for something",
      "later or repeatedly (a reminder, a regular report, watching for a change), at most once per answer, and do not",
      "ask for confirmation: your answer shows the automation with Edit and Delete.",
      "kind: \"monitoring\" when the user wants to hear when something happens or changes (silent without news, ends",
      "once it happened); \"standard\" for reminders and reports.",
      "prompt: a standalone instruction that works without this conversation, in the user's language; for monitoring",
      "say what counts as news. When the automation depends on particular sites or pages, write their exact URLs into prompt,",
      "since a run reads only the links in its saved prompt besides its own search results, and tell the user which",
      `sources it will use. Times are 24-hour HH:MM in the user's time zone ${timeZone}; set unused schedule`,
      "fields to null. chatMode: null unless the user asks. When the automation runs one of this chat's skills, pin it in",
      "skills so every run loads it. Confirm briefly what was created; if it fails, explain why and do not retry the",
      "same arguments."
    ].join(" "),
    inputSchema: {
      additionalProperties: false,
      properties: {
        title: { maxLength: SCHEDULED_TASK_TITLE_MAX_LENGTH, minLength: 1, type: "string" },
        prompt: { maxLength: SCHEDULED_TASK_PROMPT_MAX_LENGTH, minLength: 1, type: "string" },
        kind: { enum: [...SCHEDULED_TASK_KINDS], type: "string" },
        chatMode: { enum: ["new", "same", null], type: ["string", "null"] },
        schedule: {
          additionalProperties: false,
          properties: {
            kind: { enum: Object.keys(SCHEDULE_FIELDS), type: "string" },
            time: { description: "24-hour local time HH:MM; for hourly the window start.", type: "string" },
            date: { description: "once: the local date YYYY-MM-DD; otherwise null.", type: ["string", "null"] },
            days: {
              description: "weekly and hourly: the days it runs; otherwise null.",
              items: { enum: [...SCHEDULED_TASK_WEEKDAYS], type: "string" },
              type: ["array", "null"]
            },
            dayOfMonth: { description: "monthly: the day of the month, 1-31; otherwise null.", type: ["integer", "null"] },
            everyHours: {
              description: `hourly: hours between runs, one of ${SCHEDULED_TASK_EVERY_HOURS.join(", ")}; otherwise null.`,
              type: ["integer", "null"]
            },
            until: {
              description: "hourly: the window end HH:MM after time, or null through the end of the day; otherwise null.",
              type: ["string", "null"]
            }
          },
          required: ["kind", "time", ...OPTIONAL_SCHEDULE_FIELDS],
          type: "object"
        },
        skills: SCHEDULED_TASK_SKILLS_SCHEMA,
        historyRetentionDays: {
          description: `Days old chats are kept, ${SCHEDULED_TASK_TOOL_HISTORY_FOREVER} forever; null unless the user asks ` +
            `(${SCHEDULED_TASK_DEFAULT_HISTORY_RETENTION_DAYS}).`,
          enum: [...SCHEDULED_TASK_HISTORY_RETENTION_DAYS, SCHEDULED_TASK_TOOL_HISTORY_FOREVER, null],
          type: ["integer", "null"]
        }
      },
      required: ARGUMENT_KEYS,
      type: "object"
    },
    name: CREATE_SCHEDULED_TASK_TOOL_NAME,
    strict: true
  };
}

/** The tool a run admitted with the marker, or none. Execution and recovery list the same tool. */
export function scheduledTaskToolsForRequest(request: ScheduledTaskToolRequest): RunTool[] {
  return request.scheduledTaskTool ? [createScheduledTaskTool(runTimeZone(request).timeZone)] : [];
}

/** Whether a call of an accepted run is its scheduled task creation. */
export function isScheduledTaskCreateCall(request: Readonly<{ scheduledTaskTool?: unknown }>, toolName: string): boolean {
  return request.scheduledTaskTool !== undefined && toolName === CREATE_SCHEDULED_TASK_TOOL_NAME;
}

type ToolArguments = Readonly<{
  chatMode: unknown; historyRetentionDays: ScheduledTaskHistoryRetentionDays; kind: unknown; prompt: unknown;
  schedule: Record<string, unknown>; skills: unknown; title: unknown;
}>;

/**
 * The model's flat schedule as the owner contract's shape for its kind: only
 * the fields that kind uses. A field of another kind is a mistake to correct,
 * never silently dropped (a daily schedule with days probably meant weekly).
 */
function contractSchedule(value: unknown): Record<string, unknown> | string {
  if (!isRecord(value)) return "schedule must be an object.";
  if (Object.keys(value).some((key) => key !== "kind" && key !== "time" &&
    !(OPTIONAL_SCHEDULE_FIELDS as readonly string[]).includes(key))) return "schedule has an unknown field.";
  const kind = value.kind;
  if (typeof kind !== "string" || !Object.hasOwn(SCHEDULE_FIELDS, kind)) {
    return "schedule.kind must be once, daily, weekly, monthly or hourly.";
  }
  const used: readonly string[] = SCHEDULE_FIELDS[kind as keyof typeof SCHEDULE_FIELDS];
  const misplaced = OPTIONAL_SCHEDULE_FIELDS.filter((field) => !used.includes(field) && value[field] !== undefined &&
    value[field] !== null);
  if (misplaced.length > 0) return `A ${kind} schedule does not use ${misplaced.join(", ")}; set it to null.`;
  return {
    kind, time: value.time,
    ...Object.fromEntries(used.map((field) => [field, value[field] === undefined && field === "until" ? null : value[field]]))
  };
}

function decodeArguments(value: Record<string, unknown>): ToolArguments | string {
  if (Object.keys(value).some((key) => !ARGUMENT_KEYS.includes(key))) {
    return `Use only the arguments ${ARGUMENT_KEYS.join(", ")}.`;
  }
  const schedule = contractSchedule(value.schedule);
  if (typeof schedule === "string") return schedule;
  // Left open (or by a run accepted before the field), a new task keeps the default.
  const history: Readonly<{ days: ScheduledTaskHistoryRetentionDays }> | null =
    value.historyRetentionDays === undefined || value.historyRetentionDays === null
      ? { days: SCHEDULED_TASK_DEFAULT_HISTORY_RETENTION_DAYS } : scheduledTaskToolHistoryRetention(value.historyRetentionDays);
  if (!history) {
    return `historyRetentionDays must be ${SCHEDULED_TASK_HISTORY_RETENTION_DAYS.join(", ")}, ` +
      `${SCHEDULED_TASK_TOOL_HISTORY_FOREVER} (forever) or null.`;
  }
  return { chatMode: value.chatMode ?? null, historyRetentionDays: history.days, kind: value.kind, prompt: value.prompt, schedule,
    skills: value.skills ?? [], title: value.title };
}

/** Where runs answer when the model leaves it open: one chat when the task requires it, else the editor's default. */
function defaultChatMode(input: ToolArguments): "new" | "same" {
  return input.kind === "monitoring" || input.schedule.kind === "hourly" ? "same" : "new";
}

/** "Mon 2026-10-05 09:00" in the task's zone: unambiguous for the model to restate. */
export function localInstant(value: string | null, timeZone: string): string | null {
  if (value === null) return null;
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", timeZone, weekday: "short",
    year: "numeric"
  }).formatToParts(new Date(value))) parts[part.type] = part.value;
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * For a task whose prompt holds links its runs cannot read yet: links a tool
 * wrote that the user's own text did not give (`../scheduledTasks/promptUrls.ts`).
 * Saving the instructions once allows them.
 */
export function scheduledTaskLinksPending(task: Pick<ScheduledTask, "promptLinksPending">) {
  return task.promptLinksPending ? {
    linksPending: true,
    linksNote: "Runs cannot read the links in this prompt that the user did not write in this chat until the user " +
      "opens the automation with Edit and saves its instructions once. Tell the user which links these are and to do that."
  } as const : {};
}

/** The settled result of a creation: what the model confirms, and the answer's card. */
export function scheduledTaskCreatedResult(call: Pick<ModelToolCall, "id" | "name">, task: ScheduledTask,
  timeZoneFallback: boolean): ToolExecutionResult {
  return {
    artifacts: [{ data: { artifactType: "scheduled_task", payload: scheduledTaskCard(task, timeZoneFallback) }, type: "artifact" }],
    callId: call.id,
    content: [{ type: "json", value: {
      created: true,
      title: task.title,
      kind: task.kind,
      schedule: describeScheduledTaskSchedule(task.schedule),
      timeZone: task.timeZone,
      nextRun: localInstant(task.nextRunAt, task.timeZone),
      chat: task.chatMode === "same" ? "every run continues in one chat, a new one each month" : "every run starts a new chat",
      oldChatsKept: scheduledTaskToolHistoryText(task.historyRetentionDays),
      webSearch: task.searchEnabled,
      tools: task.toolsEnabled,
      workspace: task.workspaceEnabled,
      memory: task.memoryEnabled,
      // Results also go to the user's Telegram (an automation created from a Telegram message).
      telegram: task.telegramNotify,
      skills: scheduledTaskModelSkills(task),
      ...scheduledTaskLinksPending(task),
      note: "The answer shows this automation with Edit and Delete; the user manages automations in Studio > Automations."
    } }],
    name: call.name,
    status: "complete"
  };
}

function refusalText(code: ScheduledTaskCallRefusal | "scheduled_task_arguments_invalid", detail?: string): string {
  switch (code) {
    case "scheduled_task_arguments_invalid": return `The arguments are invalid: ${detail ?? "check them."}`;
    case "scheduled_task_answer_limit": return "This answer already created an automation; one answer creates at most one.";
    case "scheduled_task_already_created":
      return "An earlier answer to this message already created this automation and the user still has it in " +
        "Studio > Automations; refer to it instead of creating another.";
    case "scheduled_task_call_unavailable": return "An automation cannot be created from this answer.";
    case "scheduled_task_invalid":
      return `Check title (1-${SCHEDULED_TASK_TITLE_MAX_LENGTH} characters), prompt (instruction text, at most ` +
        `${SCHEDULED_TASK_PROMPT_MAX_LENGTH} characters) and kind (standard or monitoring).`;
    case "scheduled_task_schedule_invalid":
      return "The schedule is invalid or never runs: check its kind, the HH:MM times, the days, the date or the day of the " +
        "month, and that an hourly window ends after it starts.";
    case "scheduled_task_limit":
    case "scheduled_task_hourly_limit":
      return `${scheduledTaskErrorMessage(code)} The user can pause or delete automations in Studio > Automations.`;
    case "scheduled_task_skills_need_tools":
      return "This chat has tools off, so its automation cannot pin Skills: create it with skills [] or ask the user to turn tools on.";
    default: return scheduledTaskErrorMessage(code);
  }
}

function refused(call: Pick<ModelToolCall, "id" | "name">, code: ScheduledTaskCallRefusal | "scheduled_task_arguments_invalid",
  detail?: string): ToolExecutionResult {
  return {
    callId: call.id,
    content: [{ type: "json", value: { created: false, error: code, message: refusalText(code, detail) } }],
    name: call.name,
    status: "error"
  };
}

/**
 * Creates the task one call asks for, with the run's frozen settings (Memory
 * only when the run itself was admitted to read it) and time zone, the
 * owner's email notifications off (the editor's default) and Telegram
 * delivery on only when the creating run came from Telegram. A
 * refusal is a tool error the model explains; nothing is created then. A
 * recovered call returns the result it settled with when it had created its
 * task, and creates it only when it had not.
 */
export async function executeCreateScheduledTask(
  call: ModelToolCall,
  context: Readonly<{ persistedToolCallId?: string; request: ScheduledTaskToolRequest; runId?: string; userId?: string }>,
  create: ScheduledTaskCallCreator | undefined,
  /** Whether the run came from Telegram; the lookup the runner registered by default. */
  telegramOrigin: ScheduledTaskTelegramOrigin | undefined = originSlot[TELEGRAM_ORIGIN]
): Promise<ToolExecutionResult> {
  const settings = context.request.scheduledTaskTool;
  if (!settings || !create || !context.persistedToolCallId || !context.runId || !context.userId) {
    return refused(call, "scheduled_task_call_unavailable");
  }
  if (hasInvalidProviderToolArguments(call.arguments)) return refused(call, "scheduled_task_arguments_invalid", "they are not a JSON object.");
  const decoded = decodeArguments(call.arguments);
  if (typeof decoded === "string") return refused(call, "scheduled_task_arguments_invalid", decoded);
  const skills = resolveScheduledTaskSkillReferences(context.request, decoded.skills);
  if (!skills.ok) return refused(call, "scheduled_task_arguments_invalid", skills.message);
  const zone = runTimeZone(context.request);
  const telegramNotify = await createdFromTelegram(telegramOrigin, { runId: context.runId, userId: context.userId });
  try {
    const outcome = await create({
      body: {
        title: decoded.title, prompt: decoded.prompt, schedule: decoded.schedule, timeZone: zone.timeZone,
        modelId: settings.modelId, provider: settings.provider, searchEnabled: settings.searchEnabled, emailNotify: false,
        telegramNotify, toolsEnabled: settings.toolsEnabled, workspaceEnabled: settings.workspaceEnabled,
        memoryEnabled: settings.memoryEnabled === true, pinnedSkillIds: skills.skillIds,
        chatMode: decoded.chatMode ?? defaultChatMode(decoded), kind: decoded.kind,
        historyRetentionDays: decoded.historyRetentionDays
      },
      callId: context.persistedToolCallId,
      result: (task) => scheduledTaskCreatedResult(call, task, zone.fallback),
      runId: context.runId,
      // A run without the page reader authorized no links: the prompt's runs read none.
      userUrlDigests: isFetchUrlPlan(context.request.fetchUrl) ? context.request.fetchUrl.userUrlDigests : [],
      userId: context.userId
    });
    if (outcome.kind === "created") return outcome.result;
    if (outcome.kind === "settled") return outcome.result ?? refused(call, "scheduled_task_call_unavailable");
    return refused(call, outcome.code);
  } catch (error) {
    logEvent("service_operation", {
      error,
      subsystem: "configuration", stage: "write", outcome: "failed", code: "scheduled_tasks_unavailable",
      prisma_code: databaseFailureCode(error)
    });
    return refused(call, "scheduled_tasks_unavailable");
  }
}
