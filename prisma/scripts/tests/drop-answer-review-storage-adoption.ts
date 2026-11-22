/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const DROP_ANSWER_REVIEW_STORAGE_MIGRATION = "20261123020000_drop_answer_review_storage";

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const list = (values: readonly string[]): string => values.map(quote).join(", ");

const BEFORE = "2026-10-20 07:00:00";
const REVIEW_KINDS = ["answer_review_request", "answer_revision_request"] as const;
const KEPT_KINDS = ["mcp_approval_continuation", "subagent_callback", "browser_sign_in_request"] as const;
type Kind = (typeof REVIEW_KINDS)[number] | (typeof KEPT_KINDS)[number];

type MessageSpec = Readonly<{
  id: string;
  chat: string;
  role: "user" | "assistant";
  parent?: string;
  kind?: Kind;
  session?: string;
  /** A step's round and ordinal, on its turn only. */
  step?: readonly [number, number];
}>;

// Three chats as the previous release left them. An automatic session's review and revision steps sit on the active
// branch with a later ordinary turn below the version, beside a regenerated version copy that lost its session. A
// manual session whose initiator's account was deleted ends the branch at its review answer. A third chat holds the
// server-written turns whose kinds stay.
const messages: readonly MessageSpec[] = [
  { chat: "dar-auto-chat", id: "dar-q1", role: "user" },
  { chat: "dar-auto-chat", id: "dar-a1", parent: "dar-q1", role: "assistant" },
  { chat: "dar-auto-chat", id: "dar-review-turn", kind: "answer_review_request", parent: "dar-a1", role: "user",
    session: "dar-auto-session", step: [1, 0] },
  { chat: "dar-auto-chat", id: "dar-review-answer", parent: "dar-review-turn", role: "assistant", session: "dar-auto-session" },
  { chat: "dar-auto-chat", id: "dar-revision-turn", kind: "answer_revision_request", parent: "dar-review-answer", role: "user",
    session: "dar-auto-session", step: [1, 1] },
  { chat: "dar-auto-chat", id: "dar-version", parent: "dar-revision-turn", role: "assistant", session: "dar-auto-session" },
  { chat: "dar-auto-chat", id: "dar-version-copy", parent: "dar-revision-turn", role: "assistant" },
  { chat: "dar-auto-chat", id: "dar-q2", parent: "dar-version", role: "user" },
  { chat: "dar-auto-chat", id: "dar-a2", parent: "dar-q2", role: "assistant" },
  { chat: "dar-manual-chat", id: "dar-m-q", role: "user" },
  { chat: "dar-manual-chat", id: "dar-m-a", parent: "dar-m-q", role: "assistant" },
  { chat: "dar-manual-chat", id: "dar-m-review-turn", kind: "answer_review_request", parent: "dar-m-a", role: "user",
    session: "dar-manual-session", step: [1, 0] },
  { chat: "dar-manual-chat", id: "dar-m-review-answer", parent: "dar-m-review-turn", role: "assistant",
    session: "dar-manual-session" },
  { chat: "dar-kinds-chat", id: "dar-k-q", role: "user" },
  { chat: "dar-kinds-chat", id: "dar-k-a", parent: "dar-k-q", role: "assistant" },
  { chat: "dar-kinds-chat", id: "dar-k-approval", kind: "mcp_approval_continuation", parent: "dar-k-a", role: "user" },
  { chat: "dar-kinds-chat", id: "dar-k-approval-a", parent: "dar-k-approval", role: "assistant" },
  { chat: "dar-kinds-chat", id: "dar-k-callback", kind: "subagent_callback", parent: "dar-k-approval-a", role: "user" },
  { chat: "dar-kinds-chat", id: "dar-k-callback-a", parent: "dar-k-callback", role: "assistant" },
  { chat: "dar-kinds-chat", id: "dar-k-sign-in", kind: "browser_sign_in_request", parent: "dar-k-callback-a", role: "user" },
  { chat: "dar-kinds-chat", id: "dar-k-sign-in-a", parent: "dar-k-sign-in", role: "assistant" }
];
const leaves: Readonly<Record<string, string>> = {
  "dar-auto-chat": "dar-a2",
  "dar-kinds-chat": "dar-k-sign-in-a",
  "dar-manual-chat": "dar-m-review-answer"
};

/** Each chat's active branch, root first, as the stored tree holds it before and after the drop. */
const branchOf = (chat: string): string[] => {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: string[] = [];
  for (let id: string | undefined = leaves[chat]; id !== undefined; id = byId.get(id)?.parent) path.unshift(id);
  return path;
};

/** One digest of a table's rows (less the named keys), so a proof can show they did not change. */
const rowsDigest = (table: string, minus: readonly string[] = []): string => {
  const row = minus.length > 0 ? `(to_jsonb(r) - ARRAY[${list(minus)}]::text[])` : "to_jsonb(r)";
  return `(SELECT md5(COALESCE(string_agg(${row}::text, ',' ORDER BY ${row}::text), '')) FROM "${table}" AS r)`;
};

/** What the drop must leave as it was: every row, less the columns that go and the kind, which the proof reads itself. */
const keptDigest = `md5(concat_ws('|', ${[
  rowsDigest("User"),
  rowsDigest("Chat"),
  rowsDigest("ModelRun"),
  rowsDigest("Message", ["answerReviewSessionId", "answerReviewRound", "answerReviewStep", "systemTurnKind"])
].join(",\n  ")}))`;

const content = (message: MessageSpec): string =>
  quote(JSON.stringify({ blocks: [{ text: `Synthetic ${message.role} text of ${message.id}`, type: "text" }] }));
const sqlOrNull = (value: string | number | undefined): string =>
  value === undefined ? "NULL" : typeof value === "number" ? String(value) : quote(value);

const messageRows = messages.map((message) => `(${[quote(message.id), quote(message.chat), quote(message.role),
  sqlOrNull(message.parent), content(message), "'complete'", sqlOrNull(message.kind), sqlOrNull(message.session),
  sqlOrNull(message.step?.[0]), sqlOrNull(message.step?.[1]), quote(BEFORE), quote(BEFORE)].join(", ")})`).join(",\n  ");

// Every Answer Review row the previous release may hold, written in replica mode (no triggers or keys, checks kept)
// in the order the tree needs: an automatic session that finished, a manual one stopped by an initiator whose account
// is gone, their step turns and answers, a step run's accepted request, and the turn kinds that stay.
export const dropAnswerReviewStorageFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('dar-owner', 'Synthetic owner', 'active', '${BEFORE}');
INSERT INTO "Chat" (id, "userId", title, "createdAt", "updatedAt") VALUES
  ${Object.keys(leaves).map((chat) => `(${quote(chat)}, 'dar-owner', 'Synthetic chat', '${BEFORE}', '${BEFORE}')`).join(",\n  ")};
INSERT INTO "AnswerReviewSession" (id, "chatId", "userId", "sourceAssistantMessageId", mode, "authorModel", reviewers,
  "maxRounds", round, state, "stopReason", controls, "endNotifiedAt", "createdAt", "updatedAt") VALUES
  ('dar-auto-session', 'dar-auto-chat', 'dar-owner', 'dar-a1', 'auto', '{"providerModelId":"synthetic-author"}',
    '[{"providerModelId":"synthetic-reviewer"}]', 1, 1, 'finished', 'clean', '{"searchPlan":{"mode":"off"}}', '${BEFORE}',
    '${BEFORE}', '${BEFORE}'),
  ('dar-manual-session', 'dar-manual-chat', NULL, 'dar-m-a', 'manual', '{"providerModelId":"synthetic-author"}',
    '[{"providerModelId":"synthetic-reviewer"},{"providerModelId":"synthetic-second"}]', NULL, 1, 'stopped', 'user_stopped',
    NULL, NULL, '${BEFORE}', '${BEFORE}');
INSERT INTO "Message" (id, "chatId", role, "parentMessageId", content, status, "systemTurnKind", "answerReviewSessionId",
  "answerReviewRound", "answerReviewStep", "createdAt", "updatedAt") VALUES
  ${messageRows};
${Object.entries(leaves).map(([chat, leaf]) => `UPDATE "Chat" SET "activeLeafMessageId" = ${quote(leaf)} WHERE id = ${quote(chat)};`).join("\n")}
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", "assistantMessageId", provider, "modelId", status,
  "normalizedRequest", engine, "createdAt", "updatedAt")
VALUES ('dar-review-run', 'dar-owner', 'dar-auto-chat', 'dar-review-turn', 'dar-review-answer', 'fake', 'synthetic-reviewer',
  'complete', '{"answerReviewStep":{"kind":"review","modelName":"Reviewer","reviewer":0,"round":1,"sessionId":"dar-auto-session","step":0,"version":1}}',
  'v1', '${BEFORE}', '${BEFORE}');
COMMIT;

CREATE TABLE "_DropReviewStorageFixture" AS SELECT ${keptDigest} AS kept;
`;

const RETIRED_TYPES = ["AnswerReviewMode", "AnswerReviewState", "AnswerReviewStopReason", "MessageSystemTurnKind_next"];
const RETIRED_COLUMNS = ["answerReviewSessionId", "answerReviewRound", "answerReviewStep", "systemTurnKind_next"];
const byCode = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
/** Every fixture message with the kind it holds after the drop: a review step's turn none, any other its own. */
const expectedKinds = [...messages].sort((left, right) => byCode(left.id, right.id))
  .map((message) => `${message.id}:${message.kind && !(REVIEW_KINDS as readonly string[]).includes(message.kind) ? message.kind : "-"}`)
  .join(",");
const branchUnchanged = (chat: string): string => `(WITH RECURSIVE path AS (
      SELECT message.id, message."parentMessageId", 0 AS depth
      FROM "Chat" AS chat JOIN "Message" AS message ON message."chatId" = chat.id AND message.id = chat."activeLeafMessageId"
      WHERE chat.id = ${quote(chat)}
      UNION ALL
      SELECT parent.id, parent."parentMessageId", path.depth + 1
      FROM path JOIN "Message" AS parent ON parent."chatId" = ${quote(chat)} AND parent.id = path."parentMessageId"
      WHERE path.depth < ${messages.length}
    ) SELECT string_agg(id, ',' ORDER BY depth DESC) FROM path) IS NOT DISTINCT FROM ${quote(branchOf(chat).join(","))}`;

// Each probe ends rolled back, so the proof also serves as the repeat proof.
export const dropAnswerReviewStorageProofSql = `
DO $$
DECLARE
  violated text;
BEGIN
  -- Nothing of Answer Review is left in the catalog, and the turn kind holds only the kinds that stay, on user turns.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Message'
      AND column_name::text IN (${list(RETIRED_COLUMNS)}))
    OR EXISTS (SELECT 1 FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema() AND relation.relname ~* 'answerReview')
    OR EXISTS (SELECT 1 FROM pg_type AS type_row JOIN pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
      WHERE namespace.nspname = current_schema() AND ltrim(type_row.typname::text, '_') IN (${list(RETIRED_TYPES)}))
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Message"'::regclass AND conname ~* 'answer_?review')
    THEN RAISE EXCEPTION 'drop_answer_review_storage_left'; END IF;
  IF (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum
      WHERE enumtypid = '"MessageSystemTurnKind"'::regtype) IS DISTINCT FROM ARRAY[${list(KEPT_KINDS)}]
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Message'
      AND column_name = 'systemTurnKind' AND udt_name::text = 'MessageSystemTurnKind' AND is_nullable = 'YES')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Message"'::regclass
      AND conname = 'Message_system_turn_kind_check' AND convalidated)
    THEN RAISE EXCEPTION 'drop_answer_review_storage_turn_kind'; END IF;

  -- Review steps are ordinary turns now; every other kind is as it was, and each chat's branch is the one it stored.
  IF (SELECT string_agg(id || ':' || COALESCE("systemTurnKind"::text, '-'), ',' ORDER BY id COLLATE "C") FROM "Message"
      WHERE id LIKE 'dar-%') IS DISTINCT FROM ${quote(expectedKinds)}
    THEN RAISE EXCEPTION 'drop_answer_review_storage_kinds'; END IF;
  IF NOT (${Object.keys(leaves).map(branchUnchanged).join("\n    AND ")})
    THEN RAISE EXCEPTION 'drop_answer_review_storage_branch_moved'; END IF;
  IF (SELECT kept FROM "_DropReviewStorageFixture") IS DISTINCT FROM ${keptDigest}
    THEN RAISE EXCEPTION 'drop_answer_review_storage_changed_what_stays'; END IF;

  -- A retired kind is refused, and the check still keeps a kind off answers.
  BEGIN
    INSERT INTO "Message" (id, "chatId", role, content, "systemTurnKind", "updatedAt")
    VALUES ('dar-probe-review', 'dar-auto-chat', 'user', '{"blocks":[]}', 'answer_review_request', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'drop_answer_review_storage_review_kind_accepted';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  BEGIN
    INSERT INTO "Message" (id, "chatId", role, content, "systemTurnKind", "updatedAt")
    VALUES ('dar-probe-answer', 'dar-auto-chat', 'assistant', '{"blocks":[]}', 'subagent_callback', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'drop_answer_review_storage_kind_check_lost';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated <> 'Message_system_turn_kind_check' THEN RAISE; END IF;
  END;
END $$;
`;
