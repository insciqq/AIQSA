/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const CHAT_SEARCH_CARRIED_EXCLUSIONS_MIGRATION = "20261122142000_chat_search_carried_exclusions";

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const byCode = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

type ChatSpec = Readonly<{
  owner: string;
  mode?: "EXCLUDED" | "TEMPORARY";
  /** Fenced for permanent deletion. */
  fenced?: boolean;
  /** The old Memory's branch counter, which a forgotten source no longer matches. */
  branchGeneration?: number;
}>;

type MessageSpec = Readonly<{
  id: string;
  chat: string;
  at: string;
  role?: "user" | "assistant" | "tool";
  /** Off the active branch: a child of this message instead of the previous one. */
  parent?: string;
  /** The old Memory kept it out of history search, so the upgrade must carry it. */
  out?: true;
}>;

const OWNERS = ["cse-resumed", "cse-reset", "cse-wiped", "cse-paused", "cse-forgot", "cse-all", "cse-other"] as const;

const chats: Readonly<Record<string, ChatSpec>> = {
  "cse-resumed-chat": { owner: "cse-resumed" },
  // Excluded again after its Resume: it becomes searchable only through the new Resume, which says it all is.
  "cse-resumed-excluded": { mode: "EXCLUDED", owner: "cse-resumed" },
  "cse-reset-chat": { owner: "cse-reset" },
  "cse-wiped-chat": { owner: "cse-wiped" },
  "cse-paused-chat": { owner: "cse-paused" },
  "cse-paused-temporary": { mode: "TEMPORARY", owner: "cse-paused" },
  "cse-paused-fenced": { fenced: true, owner: "cse-paused" },
  "cse-forgot-chat": { branchGeneration: 3, owner: "cse-forgot" },
  "cse-all-chat": { owner: "cse-all" },
  "cse-other-chat": { owner: "cse-other" }
};

// Each chat's messages in order; a message names its parent only when it is off the active branch.
const messages: readonly MessageSpec[] = [
  // Resumed on 2 October: everything up to the Resume stays out, the Resume's own instant included.
  { at: "2026-10-01 08:00:00", chat: "cse-resumed-chat", id: "cse-r-q1", out: true },
  { at: "2026-10-01 08:01:00", chat: "cse-resumed-chat", id: "cse-r-a1", out: true, role: "assistant" },
  { at: "2026-10-02 00:00:00", chat: "cse-resumed-chat", id: "cse-r-q2", out: true },
  { at: "2026-10-02 00:00:01", chat: "cse-resumed-chat", id: "cse-r-a2", role: "assistant" },
  { at: "2026-10-03 09:00:00", chat: "cse-resumed-chat", id: "cse-r-q3" },
  { at: "2026-10-03 09:01:00", chat: "cse-resumed-chat", id: "cse-r-a3", role: "assistant" },
  { at: "2026-10-01 08:00:00", chat: "cse-resumed-excluded", id: "cse-e-q1" },
  { at: "2026-10-01 08:01:00", chat: "cse-resumed-excluded", id: "cse-e-a1", role: "assistant" },
  // History cleared on 5 October; a learning reset and an overridable barrier later change nothing.
  { at: "2026-10-04 09:00:00", chat: "cse-reset-chat", id: "cse-h-q1", out: true },
  { at: "2026-10-04 09:01:00", chat: "cse-reset-chat", id: "cse-h-a1", out: true, role: "assistant" },
  { at: "2026-10-10 09:00:00", chat: "cse-reset-chat", id: "cse-h-q2" },
  { at: "2026-10-10 09:01:00", chat: "cse-reset-chat", id: "cse-h-a2", role: "assistant" },
  { at: "2026-10-22 09:00:00", chat: "cse-reset-chat", id: "cse-h-q3" },
  { at: "2026-10-22 09:01:00", chat: "cse-reset-chat", id: "cse-h-a3", role: "assistant" },
  // All of Memory deleted on 5 October.
  { at: "2026-10-01 09:00:00", chat: "cse-wiped-chat", id: "cse-w-q1", out: true },
  { at: "2026-10-06 09:00:00", chat: "cse-wiped-chat", id: "cse-w-a1", role: "assistant" },
  // Memory paused 10 to 12 October, both ends included, and past-chat search paused since 20 October; a learning
  // pause, a tool message and the owner's Temporary and fenced chats change nothing.
  { at: "2026-10-09 09:00:00", chat: "cse-paused-chat", id: "cse-p-q1" },
  { at: "2026-10-10 00:00:00", chat: "cse-paused-chat", id: "cse-p-a1", out: true, role: "assistant" },
  { at: "2026-10-11 00:00:00", chat: "cse-paused-chat", id: "cse-p-tool", parent: "cse-p-a1", role: "tool" },
  { at: "2026-10-12 00:00:00", chat: "cse-paused-chat", id: "cse-p-q2", out: true },
  { at: "2026-10-15 09:00:00", chat: "cse-paused-chat", id: "cse-p-a2", role: "assistant" },
  { at: "2026-10-21 09:00:00", chat: "cse-paused-chat", id: "cse-p-q3", out: true },
  { at: "2026-10-21 09:01:00", chat: "cse-paused-chat", id: "cse-p-a3", out: true, role: "assistant" },
  { at: "2026-10-11 09:00:00", chat: "cse-paused-temporary", id: "cse-t-q1" },
  { at: "2026-10-11 09:00:00", chat: "cse-paused-fenced", id: "cse-d-q1" },
  // A forgotten source stays out although the chat's branch changed since; an expired one and a forgotten fact do not.
  { at: "2026-10-01 09:00:00", chat: "cse-forgot-chat", id: "cse-f-q1" },
  { at: "2026-10-01 09:01:00", chat: "cse-forgot-chat", id: "cse-f-a1", out: true, role: "assistant" },
  { at: "2026-10-02 09:00:00", chat: "cse-forgot-chat", id: "cse-f-q2" },
  { at: "2026-10-02 09:01:00", chat: "cse-forgot-chat", id: "cse-f-a2", role: "assistant" },
  // An unexpired suppression of everything.
  { at: "2026-10-01 09:00:00", chat: "cse-all-chat", id: "cse-x-q1", out: true },
  { at: "2026-10-01 09:01:00", chat: "cse-all-chat", id: "cse-x-a1", out: true, role: "assistant" },
  // Another owner's barriers, pauses and suppressions never reach this one, even one naming its message.
  { at: "2026-10-11 09:00:00", chat: "cse-other-chat", id: "cse-o-q1" },
  { at: "2026-10-11 09:01:00", chat: "cse-other-chat", id: "cse-o-a1", role: "assistant" }
];

const leaves = new Map<string, string>();
const parents = new Map<string, string | null>();
for (const message of messages) {
  if (message.parent) {
    parents.set(message.id, message.parent);
    continue;
  }
  parents.set(message.id, leaves.get(message.chat) ?? null);
  leaves.set(message.chat, message.id);
}

const chatRow = ([id, chat]: readonly [string, ChatSpec]): string => {
  const temporary = chat.mode === "TEMPORARY";
  return `(${[quote(id), quote(chat.owner), "'Synthetic chat'", `'${chat.mode ?? "NORMAL"}'`, String(chat.branchGeneration ?? 0),
    temporary ? "'temporary-24h-v1'" : "NULL", temporary ? "'2026-12-01 00:00:00'" : "NULL", String(chat.fenced === true),
    chat.fenced ? "'2026-11-20 00:00:00'" : "NULL", chat.fenced ? quote(`${id}-deletion`) : "NULL",
    "'2026-09-30 00:00:00'", "'2026-10-30 00:00:00'"].join(", ")})`;
};
const messageRow = (message: MessageSpec): string => `(${[quote(message.id), quote(message.chat), `'${message.role ?? "user"}'`,
  parents.get(message.id) ? quote(parents.get(message.id)!) : "NULL",
  quote(JSON.stringify({ blocks: [{ text: `Synthetic text of ${message.id}`, type: "text" }] })), "'complete'",
  quote(message.at), quote(message.at)].join(", ")})`;

const KEY_HASH = "A".repeat(43);
const suppression = (id: string, owner: string, scope: "SOURCE_MESSAGE" | "FACT" | "ALL", extra: Readonly<{
  chat?: string; message?: string; expiresAt?: string;
}> = {}): string => `(${[quote(id), quote(owner), `'${scope}'`, scope === "FACT" ? quote(KEY_HASH) : "NULL",
  extra.chat ? quote(extra.chat) : "NULL", extra.message ? quote(extra.message) : "NULL", scope === "SOURCE_MESSAGE" ? "0" : "NULL",
  "0", "'synthetic-key-v1'", "'synthetic-normalization-v1'", extra.expiresAt ? quote(extra.expiresAt) : "NULL"].join(", ")})`;

// The old Memory's rows as v0.4.43 left them, written in replica mode (no triggers or keys, checks kept). The old
// tables still exist at this point of the history.
export const chatSearchCarriedExclusionsFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES
  ${OWNERS.map((owner) => `(${quote(owner)}, 'Synthetic owner', 'active', '2026-09-30 00:00:00')`).join(",\n  ")};
INSERT INTO "Chat" (id, "userId", title, "memoryMode", "memoryBranchGeneration", "temporaryRetentionPolicyVersion",
  "temporaryRetentionDeadline", archived, "permanentDeletionAt", "permanentDeletionOperationId", "createdAt", "updatedAt") VALUES
  ${Object.entries(chats).map(chatRow).join(",\n  ")};
INSERT INTO "Message" (id, "chatId", role, "parentMessageId", content, status, "createdAt", "updatedAt") VALUES
  ${messages.map(messageRow).join(",\n  ")};
${[...leaves].map(([chat, leaf]) => `UPDATE "Chat" SET "activeLeafMessageId" = ${quote(leaf)} WHERE id = ${quote(chat)};`).join("\n")}

INSERT INTO "ChatMemoryCheckpoint" (id, "userId", "chatId", "branchGeneration", "sourceRevision", "activeLeafMessageId",
  "sourceContentHash", status, "resumeCreatedAtCutoff") VALUES
  ('cse-checkpoint-resumed', 'cse-resumed', 'cse-resumed-chat', 0, 0, 'cse-r-a3', 'synthetic-source-hash', 'STALE',
    '2026-10-02 00:00:00'),
  ('cse-checkpoint-excluded', 'cse-resumed', 'cse-resumed-excluded', 0, 0, 'cse-e-a1', 'synthetic-source-hash', 'STALE',
    '2026-10-05 00:00:00'),
  ('cse-checkpoint-plain', 'cse-reset', 'cse-reset-chat', 0, 0, 'cse-h-a3', 'synthetic-source-hash', 'PENDING', NULL);
INSERT INTO "MemorySourceBarrier" (id, "userId", kind, "sourceCreatedAtCutoff", "memoryGeneration", "explicitOverrideAllowed") VALUES
  ('cse-barrier-history', 'cse-reset', 'HISTORY_INDEX', '2026-10-05 00:00:00', 0, false),
  ('cse-barrier-learning', 'cse-reset', 'AUTOMATIC_FACTS', '2026-10-20 00:00:00', 0, false),
  ('cse-barrier-overridable', 'cse-reset', 'HISTORY_INDEX', '2026-10-25 00:00:00', 0, true),
  ('cse-barrier-wiped', 'cse-wiped', 'ALL_REUSABLE', '2026-10-05 00:00:00', 0, false),
  ('cse-barrier-foreign', 'cse-all', 'HISTORY_INDEX', '2026-10-30 00:00:00', 0, false);
INSERT INTO "MemoryPauseInterval" (id, "userId", scope, "pausedAt", "resumedAt", "memoryGeneration") VALUES
  ('cse-pause-master', 'cse-paused', 'MASTER', '2026-10-10 00:00:00', '2026-10-12 00:00:00', 0),
  ('cse-pause-search', 'cse-paused', 'SEARCH_HISTORY', '2026-10-20 00:00:00', NULL, 0),
  ('cse-pause-learning', 'cse-paused', 'AUTOMATIC_LEARNING', '2026-10-01 00:00:00', '2026-10-30 00:00:00', 0);
INSERT INTO "MemorySuppression" (id, "userId", scope, "canonicalKeyHash", "sourceChatId", "sourceMessageId",
  "sourceBranchGeneration", "deletionGeneration", "fingerprintKeyVersion", "normalizationVersion", "expiresAt") VALUES
  ${[
    suppression("cse-forgot-source", "cse-forgot", "SOURCE_MESSAGE", { chat: "cse-forgot-chat", message: "cse-f-a1" }),
    suppression("cse-forgot-expired", "cse-forgot", "SOURCE_MESSAGE", { chat: "cse-forgot-chat", expiresAt: "2026-10-03 00:00:00",
      message: "cse-f-q2" }),
    suppression("cse-forgot-fact", "cse-forgot", "FACT"),
    suppression("cse-forgot-foreign", "cse-forgot", "SOURCE_MESSAGE", { chat: "cse-other-chat", message: "cse-o-a1" }),
    suppression("cse-all-everything", "cse-all", "ALL")
  ].join(",\n  ")};
COMMIT;
`;

const expected = messages.filter((message) => message.out).map((message) => message.id).sort(byCode).join(",");

// Each probe ends rolled back, so the proof also serves as the repeat proof. It reads only tables that stay, so it
// holds after the whole history, the drop of the old tables included.
export const chatSearchCarriedExclusionsProofSql = `
DO $$
BEGIN
  -- Exactly the messages the old Memory kept out of history search, and each with its chat's owner.
  IF (SELECT string_agg("messageId", ',' ORDER BY "messageId" COLLATE "C") FROM "ChatSearchExcludedMessage"
      WHERE "chatId" LIKE 'cse-%') IS DISTINCT FROM ${quote(expected)}
    THEN RAISE EXCEPTION 'chat_search_carried_exclusions_rows'; END IF;
  IF EXISTS (SELECT 1 FROM "ChatSearchExcludedMessage" AS excluded
      JOIN "Chat" AS chat ON chat.id = excluded."chatId"
      LEFT JOIN "Message" AS message ON message."chatId" = excluded."chatId" AND message.id = excluded."messageId"
      WHERE excluded."chatId" LIKE 'cse-%' AND (message.id IS NULL OR chat."userId" IS DISTINCT FROM excluded."userId"))
    THEN RAISE EXCEPTION 'chat_search_carried_exclusions_owner'; END IF;

  -- The keys refuse a row for another chat's message or another owner.
  BEGIN
    INSERT INTO "ChatSearchExcludedMessage" ("chatId", "messageId", "userId") VALUES ('cse-other-chat', 'cse-r-a3', 'cse-other');
    RAISE EXCEPTION 'chat_search_carried_exclusions_cross_chat_accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "ChatSearchExcludedMessage" ("chatId", "messageId", "userId") VALUES ('cse-other-chat', 'cse-o-q1', 'cse-forgot');
    RAISE EXCEPTION 'chat_search_carried_exclusions_cross_owner_accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
`;
