/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const CONVERSATION_SUMMARY_TURN_KIND_MIGRATION = "20261123030000_conversation_summary_turn_kind";
export const CONVERSATION_SUMMARY_TURN_BACKFILL_MIGRATION = "20261123030100_conversation_summary_turn_backfill";

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const list = (values: readonly string[]): string => values.map(quote).join(", ");

const BEFORE = "2026-11-01 07:00:00";
const PROMPT = "Continue from the conversation summary below.";
const KINDS = ["mcp_approval_continuation", "subagent_callback", "browser_sign_in_request", "conversation_summary"] as const;

type MessageSpec = Readonly<{
  id: string;
  chat: string;
  role: "user" | "assistant";
  parent?: string;
  text: string;
  /** An answer a model wrote; the continuation writes its summary with neither. */
  model?: true;
  kind?: (typeof KINDS)[number];
}>;

const summary = (text: string) => `Conversation summary\n\n${text}`;

// A source chat and the chat its continuation made, as the previous release wrote them: the prompt and its summary, a
// regenerated summary beside it, the user's edit of the prompt to the same words with its own answer, a later turn in
// those words and an approval continuation. Beside them, a chat no completed continuation names, as one whose record
// went with its source chat.
const messages: readonly MessageSpec[] = [
  { chat: "cst-source", id: "cst-s-q", role: "user", text: "Plan the release" },
  { chat: "cst-source", id: "cst-s-a", model: true, parent: "cst-s-q", role: "assistant", text: "A plan." },
  { chat: "cst-continued", id: "cst-c-prompt", role: "user", text: PROMPT },
  { chat: "cst-continued", id: "cst-c-summary", parent: "cst-c-prompt", role: "assistant", text: summary("The plan so far.") },
  { chat: "cst-continued", id: "cst-c-regenerated", model: true, parent: "cst-c-prompt", role: "assistant", text: "Again." },
  { chat: "cst-continued", id: "cst-c-edit", role: "user", text: PROMPT },
  { chat: "cst-continued", id: "cst-c-edit-a", model: true, parent: "cst-c-edit", role: "assistant", text: summary("Mine.") },
  { chat: "cst-continued", id: "cst-c-q2", parent: "cst-c-summary", role: "user", text: PROMPT },
  { chat: "cst-continued", id: "cst-c-a2", model: true, parent: "cst-c-q2", role: "assistant", text: "Going on." },
  { chat: "cst-continued", id: "cst-c-allow", kind: "mcp_approval_continuation", parent: "cst-c-a2", role: "user",
    text: "The user approved the call." },
  { chat: "cst-continued", id: "cst-c-allow-a", model: true, parent: "cst-c-allow", role: "assistant", text: "Done." },
  { chat: "cst-orphan", id: "cst-o-prompt", role: "user", text: PROMPT },
  { chat: "cst-orphan", id: "cst-o-summary", parent: "cst-o-prompt", role: "assistant", text: summary("Its source is gone.") }
];
const leaves: Readonly<Record<string, string>> = {
  "cst-continued": "cst-c-allow-a",
  "cst-orphan": "cst-o-summary",
  "cst-source": "cst-s-a"
};
/** The answers a run wrote: the regenerated summary, the edit's answer and the later turns. */
const runs = messages.filter((message) => message.model && message.chat === "cst-continued");
/** The one turn the backfill recognizes. */
const RECOGNIZED = "cst-c-prompt";

const content = (text: string): string => quote(JSON.stringify({ blocks: [{ text, type: "text" }] }));
const sqlOrNull = (value: string | undefined): string => value === undefined ? "NULL" : quote(value);
const messageRows = messages.map((message) => `(${[quote(message.id), quote(message.chat), quote(message.role),
  sqlOrNull(message.parent), content(message.text), "'complete'", message.model ? "'fake'" : "NULL",
  message.model ? "'synthetic-model'" : "NULL", sqlOrNull(message.kind), quote(BEFORE), quote(BEFORE)].join(", ")})`)
  .join(",\n  ");

/** One digest of a table's rows (less the named keys), so a proof can show they did not change. */
const rowsDigest = (table: string, minus: readonly string[] = []): string => {
  const row = minus.length > 0 ? `(to_jsonb(r) - ARRAY[${list(minus)}]::text[])` : "to_jsonb(r)";
  return `(SELECT md5(COALESCE(string_agg(${row}::text, ',' ORDER BY ${row}::text), '')) FROM "${table}" AS r)`;
};

/** What the backfill must leave as it was: every row, less the kind, which the proof reads itself. */
const keptDigest = `md5(concat_ws('|', ${[
  rowsDigest("User"),
  rowsDigest("Chat"),
  rowsDigest("ChatContinuation"),
  rowsDigest("ModelRun"),
  rowsDigest("Message", ["systemTurnKind"])
].join(",\n  ")}))`;

// The rows the previous release may hold, written in replica mode (no triggers or keys, checks kept) in the order the
// tree needs: a completed continuation that names its chat, and a failed one, which never names one.
export const conversationSummaryTurnFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('cst-owner', 'Synthetic owner', 'active', '${BEFORE}');
INSERT INTO "Chat" (id, "userId", title, "createdAt", "updatedAt") VALUES
  ${Object.keys(leaves).map((chat) => `(${quote(chat)}, 'cst-owner', 'Synthetic chat', '${BEFORE}', '${BEFORE}')`).join(",\n  ")};
INSERT INTO "Message" (id, "chatId", role, "parentMessageId", content, status, provider, "modelId", "systemTurnKind",
  "createdAt", "updatedAt") VALUES
  ${messageRows};
${Object.entries(leaves).map(([chat, leaf]) => `UPDATE "Chat" SET "activeLeafMessageId" = ${quote(leaf)} WHERE id = ${quote(chat)};`).join("\n")}
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", "assistantMessageId", provider, "modelId", status,
  "normalizedRequest", engine, "createdAt", "updatedAt") VALUES
  ${runs.map((answer) => `(${[quote(`${answer.id}-run`), "'cst-owner'", quote(answer.chat), quote(answer.parent!), quote(answer.id),
    "'fake'", "'synthetic-model'", "'complete'", "'{}'", "'native'", quote(BEFORE), quote(BEFORE)].join(", ")})`).join(",\n  ")};
INSERT INTO "ChatContinuation" (id, "sourceChatId", "sourceMessageId", "snapshotUpdatedAt", "actorUserId", "attemptId",
  status, "newChatId", "createdAt", "updatedAt") VALUES
  ('cst-continuation', 'cst-source', 'cst-s-a', '${BEFORE}', 'cst-owner', 'cst-attempt', 'complete', 'cst-continued',
    '${BEFORE}', '${BEFORE}'),
  ('cst-continuation-failed', 'cst-source', 'cst-s-a', '2026-11-01 08:00:00', 'cst-owner', 'cst-attempt-failed', 'failed',
    NULL, '${BEFORE}', '${BEFORE}');
COMMIT;

CREATE TABLE "_ConversationSummaryTurnFixture" AS SELECT ${keptDigest} AS kept;
`;

const byCode = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
/** Every fixture message with the kind it holds after the backfill: the recognized prompt the new one, any other its own. */
const expectedKinds = [...messages].sort((left, right) => byCode(left.id, right.id))
  .map((message) => `${message.id}:${message.id === RECOGNIZED ? "conversation_summary" : message.kind ?? "-"}`)
  .join(",");

// A deploy repeated over the same rows changes nothing, so the proof also serves as the repeat proof.
export const conversationSummaryTurnProofSql = `
DO $$
BEGIN
  -- The kind follows the kinds that were, on user turns only.
  IF (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum
      WHERE enumtypid = '"MessageSystemTurnKind"'::regtype) IS DISTINCT FROM ARRAY[${list(KINDS)}]
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Message"'::regclass
      AND conname = 'Message_system_turn_kind_check' AND convalidated)
    THEN RAISE EXCEPTION 'conversation_summary_turn_kind'; END IF;

  -- Only the prompt a completed continuation wrote takes the kind; the user's edit to the same words, a later turn in
  -- them and a chat no completed continuation names stay as they were, other kinds included.
  IF (SELECT string_agg(id || ':' || COALESCE("systemTurnKind"::text, '-'), ',' ORDER BY id COLLATE "C") FROM "Message"
      WHERE id LIKE 'cst-%') IS DISTINCT FROM ${quote(expectedKinds)}
    THEN RAISE EXCEPTION 'conversation_summary_turn_backfill'; END IF;
  IF (SELECT kept FROM "_ConversationSummaryTurnFixture") IS DISTINCT FROM ${keptDigest}
    THEN RAISE EXCEPTION 'conversation_summary_turn_changed_what_stays'; END IF;
END $$;
`;
