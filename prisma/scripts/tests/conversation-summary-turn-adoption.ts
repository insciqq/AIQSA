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
  /** Written by a send and its run, which name their model; the continuation writes its pair with none. */
  model?: true;
  /** An answer a run wrote, which then also has that run. */
  run?: true;
  /** A branch copy of an answer names the run that wrote its source. */
  copiedFrom?: string;
  kind?: (typeof KINDS)[number];
}>;

const summary = (text: string) => `Conversation summary\n\n${text}`;

// The chats the previous release may hold:
// - a source chat, and the chat its continuation made, with its record: the prompt and its summary, a regenerated
//   summary beside it, the user's edit of the prompt to the same words with its own answer, a later turn in those words
//   and an approval continuation;
// - a continued chat whose record went with its source chat;
// - a branch copy of a continued chat, which copied the pair as it was;
// - a branch copy made while the regenerated summary was the active answer, which copied that answer and its run;
// - a branch copy of the user's edit to the same words, which copied the edit's model and its answer's run.
const messages: readonly MessageSpec[] = [
  { chat: "cst-source", id: "cst-s-q", model: true, role: "user", text: "Plan the release" },
  { chat: "cst-source", id: "cst-s-a", model: true, parent: "cst-s-q", role: "assistant", run: true, text: "A plan." },
  { chat: "cst-continued", id: "cst-c-prompt", role: "user", text: PROMPT },
  { chat: "cst-continued", id: "cst-c-summary", parent: "cst-c-prompt", role: "assistant", text: summary("The plan so far.") },
  { chat: "cst-continued", id: "cst-c-regenerated", model: true, parent: "cst-c-prompt", role: "assistant", run: true,
    text: summary("Again.") },
  { chat: "cst-continued", id: "cst-c-edit", model: true, role: "user", text: PROMPT },
  { chat: "cst-continued", id: "cst-c-edit-a", model: true, parent: "cst-c-edit", role: "assistant", run: true, text: summary("Mine.") },
  { chat: "cst-continued", id: "cst-c-q2", model: true, parent: "cst-c-summary", role: "user", text: PROMPT },
  { chat: "cst-continued", id: "cst-c-a2", model: true, parent: "cst-c-q2", role: "assistant", run: true, text: "Going on." },
  { chat: "cst-continued", id: "cst-c-allow", kind: "mcp_approval_continuation", model: true, parent: "cst-c-a2", role: "user",
    text: "The user approved the call." },
  { chat: "cst-continued", id: "cst-c-allow-a", model: true, parent: "cst-c-allow", role: "assistant", run: true, text: "Done." },
  { chat: "cst-orphan", id: "cst-o-prompt", role: "user", text: PROMPT },
  { chat: "cst-orphan", id: "cst-o-summary", parent: "cst-o-prompt", role: "assistant", text: summary("Its source is gone.") },
  { chat: "cst-copy", id: "cst-p-prompt", role: "user", text: PROMPT },
  { chat: "cst-copy", id: "cst-p-summary", parent: "cst-p-prompt", role: "assistant", text: summary("The plan so far.") },
  { chat: "cst-copy-regenerated", id: "cst-r-prompt", role: "user", text: PROMPT },
  { chat: "cst-copy-regenerated", copiedFrom: "cst-c-regenerated-run", id: "cst-r-answer", model: true, parent: "cst-r-prompt",
    role: "assistant", text: summary("Again.") },
  { chat: "cst-copy-edit", id: "cst-e-prompt", model: true, role: "user", text: PROMPT },
  { chat: "cst-copy-edit", copiedFrom: "cst-c-edit-a-run", id: "cst-e-answer", model: true, parent: "cst-e-prompt", role: "assistant",
    text: summary("Mine.") }
];
const leaves: Readonly<Record<string, string>> = {
  "cst-continued": "cst-c-allow-a",
  "cst-copy": "cst-p-summary",
  "cst-copy-edit": "cst-e-answer",
  "cst-copy-regenerated": "cst-r-answer",
  "cst-orphan": "cst-o-summary",
  "cst-source": "cst-s-a"
};
/** The answers a run wrote. */
const runs = messages.filter((message) => message.run);
/** The turns the backfill recognizes. */
const RECOGNIZED: ReadonlySet<string> = new Set(["cst-c-prompt", "cst-o-prompt", "cst-p-prompt", "cst-r-prompt"]);
/**
 * The past-chat index states: those of three recognized chats, one waiting out a failed pass, which the backfill marks;
 * the source's and the edit's copy's, settled, which it leaves. The plain copy has none, and gets none.
 */
const MARKED = ["cst-continued", "cst-copy-regenerated", "cst-orphan"] as const;
const SETTLED = ["cst-copy-edit", "cst-source"] as const;

const content = (text: string): string => quote(JSON.stringify({ blocks: [{ text, type: "text" }] }));
const sqlOrNull = (value: string | undefined): string => value === undefined ? "NULL" : quote(value);
const messageRows = messages.map((message) => `(${[quote(message.id), quote(message.chat), quote(message.role),
  sqlOrNull(message.parent), content(message.text), "'complete'", message.model ? "'fake'" : "NULL",
  message.model ? "'synthetic-model'" : "NULL", sqlOrNull(message.kind), sqlOrNull(message.copiedFrom), quote(BEFORE),
  quote(BEFORE)].join(", ")})`).join(",\n  ");

/** One digest of a table's rows (less the named keys, and only those `where` keeps), so a proof can show they did not change. */
const rowsDigest = (table: string, minus: readonly string[] = [], where = "true"): string => {
  const row = minus.length > 0 ? `(to_jsonb(r) - ARRAY[${list(minus)}]::text[])` : "to_jsonb(r)";
  return `(SELECT md5(COALESCE(string_agg(${row}::text, ',' ORDER BY ${row}::text), '')) FROM "${table}" AS r WHERE ${where})`;
};

/**
 * What the backfill must leave as it was: every row, less the kind, which the proof reads itself, and less the marked
 * states' version, backoff and write time.
 */
const keptDigest = `md5(concat_ws('|', ${[
  rowsDigest("User"),
  rowsDigest("Chat"),
  rowsDigest("ChatContinuation"),
  rowsDigest("ModelRun"),
  rowsDigest("Message", ["systemTurnKind"]),
  rowsDigest("ChatSearchState", [], `r."chatId" NOT IN (${list(MARKED)})`),
  rowsDigest("ChatSearchState", ["dirtyAt", "nextAttemptAt", "updatedAt"], `r."chatId" IN (${list(MARKED)})`)
].join(",\n  ")}))`;

// The rows the previous release may hold, written in replica mode (no triggers or keys, checks kept) in the order the
// tree needs: one completed continuation's record, and a failed one, which never names a chat.
export const conversationSummaryTurnFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('cst-owner', 'Synthetic owner', 'active', '${BEFORE}');
INSERT INTO "Chat" (id, "userId", title, "createdAt", "updatedAt") VALUES
  ${Object.keys(leaves).map((chat) => `(${quote(chat)}, 'cst-owner', 'Synthetic chat', '${BEFORE}', '${BEFORE}')`).join(",\n  ")};
INSERT INTO "Message" (id, "chatId", role, "parentMessageId", content, status, provider, "modelId", "systemTurnKind",
  "branchSourceModelRunId", "createdAt", "updatedAt") VALUES
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
INSERT INTO "ChatSearchState" ("chatId", "userId", "indexedLeafMessageId", "dirtyAt", "attemptCount", "nextAttemptAt",
  "lastErrorCode", "updatedAt") VALUES
  ('cst-continued', 'cst-owner', 'cst-c-allow-a', '${BEFORE}', 3, '2026-11-02 07:00:00', 'synthetic_failure', '${BEFORE}'),
  ('cst-orphan', 'cst-owner', 'cst-o-summary', NULL, 0, NULL, NULL, '${BEFORE}'),
  ('cst-copy-regenerated', 'cst-owner', 'cst-r-answer', NULL, 0, NULL, NULL, '${BEFORE}'),
  ${SETTLED.map((chat) => `(${quote(chat)}, 'cst-owner', ${quote(leaves[chat]!)}, NULL, 0, NULL, NULL, '${BEFORE}')`).join(",\n  ")};
COMMIT;

CREATE TABLE "_ConversationSummaryTurnFixture" AS SELECT ${keptDigest} AS kept;
`;

const byCode = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
/** Every fixture message with the kind it holds after the backfill: a recognized prompt the new one, any other its own. */
const expectedKinds = [...messages].sort((left, right) => byCode(left.id, right.id))
  .map((message) => `${message.id}:${RECOGNIZED.has(message.id) ? "conversation_summary" : message.kind ?? "-"}`)
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

  -- Every pair a continuation wrote takes the kind, with or without its record, in a copy that kept it and in a copy of
  -- its regenerated summary; the user's edit to the same words, a copy of that edit and a later turn in those words stay
  -- as they were, other kinds included.
  IF (SELECT string_agg(id || ':' || COALESCE("systemTurnKind"::text, '-'), ',' ORDER BY id COLLATE "C") FROM "Message"
      WHERE id LIKE 'cst-%') IS DISTINCT FROM ${quote(expectedKinds)}
    THEN RAISE EXCEPTION 'conversation_summary_turn_backfill'; END IF;

  -- The index state of a chat whose turn changed moves forward and drops its backoff; no state is created for a chat
  -- without one, and every other state stays as it was.
  IF (SELECT count(*) FROM "ChatSearchState" WHERE "chatId" IN (${list(MARKED)}) AND "dirtyAt" > '${BEFORE}'
      AND "nextAttemptAt" IS NULL) <> ${MARKED.length}
    OR (SELECT string_agg("chatId", ',' ORDER BY "chatId" COLLATE "C") FROM "ChatSearchState" WHERE "chatId" LIKE 'cst-%')
      IS DISTINCT FROM ${quote([...MARKED, ...SETTLED].sort(byCode).join(","))}
    THEN RAISE EXCEPTION 'conversation_summary_turn_search_mark'; END IF;
  IF (SELECT kept FROM "_ConversationSummaryTurnFixture") IS DISTINCT FROM ${keptDigest}
    THEN RAISE EXCEPTION 'conversation_summary_turn_changed_what_stays'; END IF;
END $$;
`;
