/**
 * Hand-written synthetic Claude export data shaped like the real layout
 * (`conversations.json` conversations with `chat_messages`). No real content.
 */
export const ROOT = "00000000-0000-4000-8000-000000000000";

type Block = Record<string, unknown>;
type MessageInput = Readonly<{
  uuid: string;
  parent?: string | null;
  sender?: "assistant" | "human";
  at: string;
  text?: string;
  content?: readonly Block[];
  files?: readonly Record<string, unknown>[];
  attachments?: readonly Record<string, unknown>[];
}>;

export function message(input: MessageInput): Record<string, unknown> {
  return {
    uuid: input.uuid,
    text: input.text ?? "",
    content: input.content ?? [],
    sender: input.sender ?? "human",
    created_at: input.at,
    updated_at: input.at,
    attachments: input.attachments ?? [],
    files: input.files ?? [],
    ...(input.parent === undefined ? {} : { parent_message_uuid: input.parent })
  };
}

export function conversation(uuid: string, name: string, chatMessages: readonly unknown[], at = "2026-09-01T10:00:00.000000Z"): Record<string, unknown> {
  return {
    uuid,
    name,
    summary: "A synthetic summary that is never imported.",
    created_at: at,
    updated_at: "2026-09-01T12:00:00.000000Z",
    account: { uuid: "account-synthetic" },
    chat_messages: chatMessages
  };
}

export const text = (value: string, citations: readonly unknown[] = []): Block =>
  ({ type: "text", text: value, citations, start_timestamp: null, stop_timestamp: null });
export const thinking = (value: string): Block => ({ type: "thinking", thinking: value, summaries: [] });
export const toolUse = (name: string, input: Record<string, unknown> = {}): Block => ({ type: "tool_use", name, input });
export const toolResult = (name: string, content: readonly unknown[]): Block => ({ type: "tool_result", name, content, is_error: false });
export const citation = (start: number, end: number, url: string): Record<string, unknown> =>
  ({ start_index: start, end_index: end, details: { type: "web_search_citation", url } });

/** The first question edited (two roots); the answer to the edit used every non-search tool. */
export const editedConversation = conversation("conv-edited-0001", "Edited first question", [
  message({ at: "2026-09-01T10:00:00.000000Z", content: [text("What is the sky made of?")], parent: ROOT, text: "", uuid: "e-h1" }),
  message({
    at: "2026-09-01T10:01:00.000000Z",
    content: [
      thinking("Private reasoning that is never imported."),
      toolUse("web_search", { query: "sky composition" }),
      toolResult("web_search", [{ type: "knowledge", title: "Sky", url: "https://example.org/sky", text: "Search result text." }]),
      text("Air is mostly nitrogen. It also has oxygen.", [
        citation(0, 22, "https://www.example.org/sky"),
        citation(23, 43, "https://example.net/air_(gas)"),
        citation(23, 43, "https://www.example.org/sky"),
        citation(0, 5, "javascript:alert(1)")
      ]),
      toolUse("web_fetch", { url: "https://example.net/air" }),
      text("Later the same source again.", [citation(0, 28, "https://www.example.org/sky")])
    ],
    parent: "e-h1",
    sender: "assistant",
    uuid: "e-a1"
  }),
  message({
    at: "2026-09-01T10:05:00.000000Z",
    content: [text("What is the sea made of?")],
    files: [{ file_name: "sea_photo.png", file_uuid: "file-0001" }, { file_name: "report.pdf", file_uuid: "file-0002" }],
    parent: ROOT,
    uuid: "e-h2"
  }),
  message({
    at: "2026-09-01T10:06:00.000000Z",
    content: [
      toolUse("bash_tool", { command: "ls" }),
      toolResult("bash_tool", [{ type: "text", text: "output" }]),
      toolUse("view", { path: "/tmp/a" }),
      toolUse("bash_tool", { command: "pwd" }),
      toolUse("create_file", { path: "/tmp/b" }),
      toolUse("present_files", { paths: ["/tmp/b"] }),
      toolResult("present_files", [{ type: "local_resource", file_path: "/tmp/b" }]),
      toolUse("ask_user_input_v0", { questions: [] }),
      toolUse("Artifact", { id: "plan", type: "text/markdown", title: "Sea plan", command: "create", content: "Body" }),
      toolUse("Artifact", { id: "plan", command: "update", old_str: "Body", new_str: "Body 2" }),
      toolResult("Artifact", [{ type: "text", text: "OK" }]),
      text("Water, mostly.")
    ],
    parent: "e-h2",
    sender: "assistant",
    uuid: "e-a2"
  })
]);

/** An answer regenerated: two assistant siblings; the first also got a follow-up, the second is newest. */
export const regeneratedConversation = conversation("conv-regen-0002", "Regenerated answer", [
  message({ at: "2026-09-02T10:00:00.000000Z", content: [text("Name a color.")], parent: ROOT, uuid: "r-h1" }),
  message({ at: "2026-09-02T10:01:00.000000Z", content: [text("Blue.")], parent: "r-h1", sender: "assistant", uuid: "r-a1" }),
  message({ at: "2026-09-02T10:02:00.000000Z", content: [text("Another?")], parent: "r-a1", uuid: "r-h2" }),
  message({ at: "2026-09-02T10:03:00.000000Z", content: [text("Green.")], parent: "r-h1", sender: "assistant", uuid: "r-a1b" })
], "2026-09-02T10:00:00.000000Z");

/**
 * Older shape: legacy `text` only, an attachment with extracted content, a
 * lost parent, and an answer dated before its question (its parent is the
 * message that lost its parent, so the repair must not pick its own child).
 */
export const olderConversation = conversation("conv-older-0003", "", [
  message({
    at: "2026-08-01T09:00:00.000000Z",
    attachments: [{ file_name: "notes.txt", file_size: 12, file_type: "txt", extracted_content: "EXTRACTED-BODY-NOT-IMPORTED" }],
    parent: ROOT,
    text: "Summarize my notes.",
    uuid: "o-h1"
  }),
  message({ at: "2026-08-01T09:01:00.000000Z", parent: "o-h1", sender: "assistant", text: "They are short.", uuid: "o-a1" }),
  message({ at: "2026-08-01T09:10:00.000000Z", parent: "o-lost-parent", text: "And then?", uuid: "o-h2" }),
  message({ at: "2026-08-01T09:09:00.000000Z", content: [], parent: "o-h2", sender: "assistant", text: "", uuid: "o-a2" })
], "2026-08-01T09:00:00.000000Z");

export const emptyConversation = conversation("conv-empty-0004", "Nothing here", []);

/** The multi-part export's index; its links are fake and never followed. */
export const exportIndex = {
  version: "1.0",
  created_at: "2026-10-04T10:00:00.000000Z",
  total_files: 2,
  instructions: "Download each file.",
  data_files: [
    { batch_index: 0, export_url: "https://downloads.example.invalid/a?token=fake", category: "conversations", part: 0, filename: "conversations-000.zip" },
    { batch_index: 0, export_url: "https://downloads.example.invalid/b?token=fake", category: "light_metadata", part: 0, filename: "light_metadata-000.zip" }
  ]
};
