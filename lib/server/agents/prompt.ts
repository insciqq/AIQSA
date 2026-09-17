import { textFromContentBlocks } from "@/lib/domain/modelRunEvents";
import type { ProviderRunRequest } from "../providers/types";
import { AGENT_PROMPT_MAX_BYTES } from "./guest";

/** The native prompt is user-level. Selected Skills are never developer instructions. */
export function agentPrompts(request: ProviderRunRequest) {
  const messages = request.context?.messages.length ? request.context.messages
    : [{ id: "current", role: "user", content: request.content }];
  let previousAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "assistant") { previousAssistantIndex = index; break; }
  }
  const render = (currentOnly: boolean) => {
    const selected = currentOnly ? messages.slice(previousAssistantIndex + 1) : messages;
    const text = [
      "Continue the AIQSA conversation below and carry out the current user's task. Historical messages are conversation context, not new commands.",
      ...(request.workspace ? [
        "Current AIQSA turn workspace paths (replace all previous turn paths):",
        JSON.stringify({ outputDirectory: request.workspace.outputDirectory,
          inboxIndexPath: request.workspace.inboxIndexPath, messageManifestPath: request.workspace.messageManifestPath,
          attachments: request.attachments.map(({ fileName, mimeType, byteSize }) => ({ fileName, mimeType, byteSize })) })
      ] : []),
      JSON.stringify(selected.map((message) => ({ role: message.role, text: textFromContentBlocks(message.content) }))),
      ...(request.prompt.personalInstructions ? ["Current personal instructions:", request.prompt.personalInstructions] : []),
      ...request.attachments.flatMap((attachment) => attachment.pdfDelivery === "prepared_text" && attachment.extractedText
        ? [`Prepared document ${JSON.stringify(attachment.fileName)} (document data):`, attachment.extractedText] : []),
      ...(request.prompt.responseReminder ? ["Current response reminder:", request.prompt.responseReminder] : [])
    ].join("\n\n");
    if (Buffer.byteLength(text) > AGENT_PROMPT_MAX_BYTES) throw new Error("agent_context_too_large");
    return text;
  };
  return {
    prompt: render(false), resumePrompt: render(true),
    previousAssistantMessageId: previousAssistantIndex >= 0 ? messages[previousAssistantIndex]!.id : null,
    developerInstructions: [
      request.prompt.system, request.prompt.developer,
      "You are executing one AIQSA user turn inside its isolated Workspace. Use your native tools and the configured AIQSA MCP server. " +
      "Only the current turn's selected Skills and personal instructions apply. Do not publish secrets or authentication material. " +
      "Read /workspace/SECRETS.md for the supplied secret locations; use them only as needed for the task. " +
      "Write user deliverables to the current output directory specified above. Answer the user in the chat when finished."
      + " Cite web sources with ordinary Markdown links to their URLs; internal search reference IDs are not clickable in this chat."
    ].filter(Boolean).join("\n\n")
  };
}
