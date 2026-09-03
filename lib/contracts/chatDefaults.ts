import { decodeKnowledgeSelection, type KnowledgeSelection } from "./knowledge";

/** MCP discovery mode a new chat starts with; mirrors the run selection vocabulary. */
export type ChatDefaultMcpMode = "auto" | "load_all" | "off";

export type ChatDefaults = Readonly<{
  /** Knowledge selection attached to new chats; null starts new chats without Knowledge. */
  knowledgePlan: KnowledgeSelection | null;
  mcpMode: ChatDefaultMcpMode;
  /** Composer keyboard contract: Enter sends (true) or inserts a newline while Ctrl/⌘+Enter sends. */
  sendWithEnter: boolean;
}>;

export const INSTALLATION_CHAT_DEFAULTS: ChatDefaults = Object.freeze({
  knowledgePlan: null,
  mcpMode: "auto",
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
  if (input.sendWithEnter !== undefined && typeof input.sendWithEnter !== "boolean") return null;
  return {
    knowledgePlan,
    mcpMode,
    sendWithEnter: input.sendWithEnter ?? INSTALLATION_CHAT_DEFAULTS.sendWithEnter
  };
}
