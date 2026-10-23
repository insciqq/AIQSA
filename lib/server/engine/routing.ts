import { logEvent } from "../observability";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";

/**
 * Which engine runs an accepted run until the switch. The native engine
 * takes every run of the users the operator listed in
 * `AIQSA_NATIVE_ENGINE_USERS` (user ids or emails, comma separated; `*` is
 * everyone; unset or empty is nobody) that it can run, whichever entry point
 * admitted it: personal, temporary and Assistant chats from the web or
 * Telegram, scheduled task occurrences and answer review steps. Everything
 * else stays on the old core: Project and Knowledge work, Codex Agent turns,
 * a model without verified tool calling or whose adapter cannot replay the
 * neutral history, and a send that must wait for PDF preparation or for the
 * previous answer's Workspace (those continuations run on the old core).
 */
export const NATIVE_ENGINE_USERS_ENV = "AIQSA_NATIVE_ENGINE_USERS";

export type NativeEngineAllowlist = Readonly<{ all: boolean; emails: ReadonlySet<string>; userIds: ReadonlySet<string> }>;

export function parseNativeEngineUsers(value: string | undefined): NativeEngineAllowlist {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return {
    all: entries.includes("*"),
    emails: new Set(entries.filter((entry) => entry.includes("@")).map((entry) => entry.toLowerCase())),
    userIds: new Set(entries.filter((entry) => entry !== "*" && !entry.includes("@")))
  };
}

export function nativeEngineAllowsUser(allowlist: NativeEngineAllowlist, user: Readonly<{ email: string | null; id: string }>): boolean {
  return allowlist.all || allowlist.userIds.has(user.id) ||
    (user.email !== null && allowlist.emails.has(user.email.trim().toLowerCase()));
}

/**
 * The allowlist's shape for the startup log line, without any id or email:
 * `all` for `*`, `list` with how many entries, `none` when empty.
 */
export function nativeEngineAllowlistMode(allowlist: NativeEngineAllowlist): Readonly<{ count: number; mode: "all" | "list" | "none" }> {
  const count = allowlist.userIds.size + allowlist.emails.size;
  return allowlist.all ? { count, mode: "all" } : count > 0 ? { count, mode: "list" } : { count: 0, mode: "none" };
}

/**
 * The startup line naming which users the native engine takes, without any
 * id or email: `native_engine_users_none`, `_list` with how many entries the
 * list has, or `_all` (`AIQSA_NATIVE_ENGINE_USERS=*`, after the switch).
 */
export function logNativeEngineAllowlist(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const { count, mode } = nativeEngineAllowlistMode(parseNativeEngineUsers(env[NATIVE_ENGINE_USERS_ENV]));
  logEvent("runtime_lifecycle", { code: `native_engine_users_${mode}`, count, outcome: "completed", stage: "startup",
    subsystem: "configuration" });
}

/** Answer adapters that render the neutral history (`lib/server/providers/history.ts`). */
export const NATIVE_ENGINE_ADAPTER_KINDS: ReadonlySet<string> = new Set([
  "anthropic_messages",
  "deepseek_responses_native",
  "fake",
  "gemini_interactions_native",
  "openai_responses_compatible",
  "openai_responses_native",
  "openrouter_chat_completions"
]);

export type NativeEngineRefusal =
  | "adapter_without_history"
  | "agent_turn"
  | "deferred_preparation"
  | "knowledge"
  | "not_listed"
  | "project_chat"
  | "tool_calling_unverified"
  | "workspace_predecessor";

export type NativeEngineRoute = Readonly<{ engine: "native" }> | Readonly<{ engine: "v1"; reason: NativeEngineRefusal }>;

export function nativeEngineRoute(input: Readonly<{
  allowlist: NativeEngineAllowlist;
  prepared: MaterializedPreparedRunData;
  user: Readonly<{ email: string | null; id: string }>;
  /** The send waits for the previous answer's Workspace to settle. */
  workspacePredecessor: boolean;
}>): NativeEngineRoute {
  const refuse = (reason: NativeEngineRefusal): NativeEngineRoute => ({ engine: "v1", reason });
  if (!nativeEngineAllowsUser(input.allowlist, input.user)) return refuse("not_listed");
  const prepared = input.prepared;
  const request = prepared.normalizedRequest;
  if (prepared.project) return refuse("project_chat");
  if (request.agent) return refuse("agent_turn");
  if (request.knowledgePlan.mode !== "none") return refuse("knowledge");
  if (!NATIVE_ENGINE_ADAPTER_KINDS.has(prepared.providerAdmissionPlan.answer.snapshot.model.adapterKind)) {
    return refuse("adapter_without_history");
  }
  if (request.modelCapabilities.toolCalling !== true) return refuse("tool_calling_unverified");
  if (prepared.chatPdfAdmissions?.some((admission) => admission.route !== "direct_pdf")) return refuse("deferred_preparation");
  if (input.workspacePredecessor) return refuse("workspace_predecessor");
  return { engine: "native" };
}
