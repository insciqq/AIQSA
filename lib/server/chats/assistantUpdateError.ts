import type { ChatAssistantErrorCode } from "../../contracts/chats";

export type ChatAssistantUpdateErrorCode = Exclude<ChatAssistantErrorCode, "assistant_binding_conflict">;

/** A chat update the Assistant rules refuse; the handler maps the code to its status. */
export class ChatAssistantUpdateError extends Error {
  constructor(readonly code: ChatAssistantUpdateErrorCode) {
    super(code);
    this.name = "ChatAssistantUpdateError";
  }
}
