import { decodeKnowledgeSelection, type KnowledgeSelection } from "./knowledge";

/** Ordinary chat defaults; diagnostic and utility budgets are owned separately. */
export const DEFAULT_CHAT_MAX_OUTPUT_TOKENS = 65_536;

/** MCP discovery mode a new chat starts with; mirrors the run selection vocabulary. */
export type ChatDefaultMcpMode = "auto" | "load_all" | "off";
export type ChatDefaultSkillsMode = "auto" | "off";

export type ChatDefaults = Readonly<{
  /** Knowledge selection attached to new chats; null starts new chats without Knowledge. */
  knowledgePlan: KnowledgeSelection | null;
  mcpMode: ChatDefaultMcpMode;
  skillsMode: ChatDefaultSkillsMode;
  /** Composer keyboard contract: Enter sends (true) or inserts a newline while Ctrl/⌘+Enter sends. */
  sendWithEnter: boolean;
}>;

export const INSTALLATION_CHAT_DEFAULTS: ChatDefaults = Object.freeze({
  knowledgePlan: null,
  mcpMode: "auto",
  skillsMode: "auto",
  sendWithEnter: true
});

export function decodeChatDefaultMcpMode(value: unknown): ChatDefaultMcpMode | null {
  return value === "auto" || value === "load_all" || value === "off" ? value : null;
}

/**
 * Decodes the optional chat-default fields of a wire object: an absent field
 * means the installation default, a present but invalid field rejects the
 * whole object (null).
 */
export function decodeOptionalChatDefaults(input: Readonly<{
  knowledgePlan: unknown;
  mcpMode: unknown;
  skillsMode?: unknown;
  sendWithEnter: unknown;
}>): ChatDefaults | null {
  let knowledgePlan: KnowledgeSelection | null = null;
  if (input.knowledgePlan !== undefined && input.knowledgePlan !== null) {
    const decoded = decodeKnowledgeSelection(input.knowledgePlan);
    if (!decoded.ok || decoded.plan.mode === "inherited") return null;
    knowledgePlan = decoded.plan.mode === "none" ? null : decoded.plan;
  }
  const mcpMode = input.mcpMode === undefined
    ? INSTALLATION_CHAT_DEFAULTS.mcpMode
    : decodeChatDefaultMcpMode(input.mcpMode);
  if (!mcpMode) return null;
  const skillsMode = input.skillsMode === undefined ? INSTALLATION_CHAT_DEFAULTS.skillsMode : input.skillsMode;
  if (skillsMode !== "auto" && skillsMode !== "off") return null;
  if (input.sendWithEnter !== undefined && typeof input.sendWithEnter !== "boolean") return null;
  return {
    knowledgePlan,
    mcpMode,
    skillsMode,
    sendWithEnter: input.sendWithEnter ?? INSTALLATION_CHAT_DEFAULTS.sendWithEnter
  };
}

/**
 * A bounded Assistant id without whitespace or control characters. Writers
 * answer anything else like an Assistant the requester cannot use.
 */
export function isAssistantReferenceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000- \u007f]/u.test(value);
}

/**
 * The personal default Assistant for new personal chats. Its id is exposed
 * only while the Assistant is available to the user; a saved default that is
 * no longer available is reported without naming it, so the user can clear it.
 */
export type ChatDefaultAssistant = Readonly<{
  assistantId: string | null;
  assistantUnavailable: boolean;
}>;

export function decodeOptionalDefaultAssistant(input: Readonly<{
  assistantId: unknown;
  assistantUnavailable: unknown;
}>): ChatDefaultAssistant | null {
  const assistantId = input.assistantId ?? null;
  const assistantUnavailable = input.assistantUnavailable ?? false;
  if (
    (assistantId !== null && (typeof assistantId !== "string" || !assistantId || assistantId.length > 256)) ||
    typeof assistantUnavailable !== "boolean" ||
    (assistantId !== null && assistantUnavailable)
  ) {
    return null;
  }
  return { assistantId, assistantUnavailable };
}
