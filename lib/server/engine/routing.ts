import type { MaterializedPreparedRunData } from "../runs/runPreparation";

/**
 * Which engine runs an accepted interactive run during the pilot. The native
 * engine takes the personal and temporary chats of the users the operator
 * listed in `AIQSA_NATIVE_ENGINE_USERS` (user ids or emails, comma separated;
 * `*` is everyone; unset or empty is nobody). Everything else stays on the old
 * core until rollout: Assistant chats, scheduled tasks, Telegram and answer
 * review (their handlers name no native engine), Project and Knowledge
 * work, Codex Agent turns, a model without verified tool calling or whose
 * adapter cannot replay the neutral history, and a send that must wait for
 * PDF preparation or for the previous answer's Workspace (those continuations
 * run on the old core).
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

/** Answer adapters that render the neutral history (`lib/server/providers/history.ts`). */
export const NATIVE_ENGINE_ADAPTER_KINDS: ReadonlySet<string> = new Set([
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
  | "answer_review"
  | "assistant_chat"
  | "deferred_preparation"
  | "knowledge"
  | "not_listed"
  | "project_chat"
  | "scheduled"
  | "tool_calling_unverified"
  | "workspace_predecessor";

export type NativeEngineRoute = Readonly<{ engine: "native" }> | Readonly<{ engine: "v1"; reason: NativeEngineRefusal }>;

export function nativeEngineRoute(input: Readonly<{
  allowlist: NativeEngineAllowlist;
  answerReview: boolean;
  prepared: MaterializedPreparedRunData;
  scheduled: boolean;
  user: Readonly<{ email: string | null; id: string }>;
  /** The send waits for the previous answer's Workspace to settle. */
  workspacePredecessor: boolean;
}>): NativeEngineRoute {
  const refuse = (reason: NativeEngineRefusal): NativeEngineRoute => ({ engine: "v1", reason });
  if (!nativeEngineAllowsUser(input.allowlist, input.user)) return refuse("not_listed");
  if (input.scheduled) return refuse("scheduled");
  if (input.answerReview) return refuse("answer_review");
  const prepared = input.prepared;
  const request = prepared.normalizedRequest;
  if (prepared.project) return refuse("project_chat");
  if (prepared.assistant || prepared.chatAssistant) return refuse("assistant_chat");
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
