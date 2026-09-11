import { textFromContentBlocks } from "../../domain/modelRunEvents";
import type { ProviderRunRequest } from "../providers/types";
import type { McpRouterContext } from "./router";

/** Only the chat adapter reads an already authorized branch. */
export function mcpChatDiscoveryContext(
  request: Pick<ProviderRunRequest, "content" | "context">
): McpRouterContext {
  const currentText = textFromContentBlocks(request.content).trim();
  const messages = (request.context?.messages ?? []).filter((message) => message.purpose === undefined);
  const last = messages.at(-1);
  if (last?.role === "user" && textFromContentBlocks(last.content).trim() === currentText) messages.pop();
  return {
    currentText,
    messages: messages.map((message) => ({ role: message.role, text: textFromContentBlocks(message.content) }))
  };
}
