import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const MEMORY_NOTE_ADOPTION_MIGRATION = "20261122140000_memory_note_adoption";

// `migrate deploy` never replays an applied migration, so idempotency is proven
// by executing the committed body again inside the proof.
const migrationBody = readFileSync(join(dirname(fileURLToPath(import.meta.url)),
  "../../migrations", MEMORY_NOTE_ADOPTION_MIGRATION, "migration.sql"), "utf8");

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const NEWLINE = "chr(10)";

// Every message a fact cites as evidence, and the chat whose active branch holds it.
type MessageSpec = Readonly<{ at: string; chat: string; parent?: string }>;
const messages: Readonly<Record<string, MessageSpec>> = {
  "mna-saver-m1": { at: "2026-10-01 08:00:00", chat: "mna-saver-chat" },
  "mna-overflow-m1": { at: "2026-10-01 08:00:00", chat: "mna-overflow-chat" },
  "mna-paused-before": { at: "2026-10-10 08:00:00", chat: "mna-paused-chat" },
  "mna-paused-after": { at: "2026-10-20 08:00:00", chat: "mna-paused-chat", parent: "mna-paused-before" },
  "mna-deleter-forget-m1": { at: "2026-10-01 08:00:00", chat: "mna-deleter-forget-chat" },
  "mna-deleter-keep-m1": { at: "2026-10-01 08:00:00", chat: "mna-deleter-keep-chat" },
  "mna-deleter-live-m1": { at: "2026-10-01 08:00:00", chat: "mna-deleter-live-chat" }
};
const chats: Readonly<Record<string, Readonly<{ owner: string; leaf: string }>>> = {
  "mna-saver-chat": { leaf: "mna-saver-m1", owner: "mna-saver" },
  "mna-overflow-chat": { leaf: "mna-overflow-m1", owner: "mna-overflow" },
  "mna-paused-chat": { leaf: "mna-paused-after", owner: "mna-paused" },
  "mna-deleter-forget-chat": { leaf: "mna-deleter-forget-m1", owner: "mna-deleter" },
  "mna-deleter-keep-chat": { leaf: "mna-deleter-keep-m1", owner: "mna-deleter" },
  "mna-deleter-live-chat": { leaf: "mna-deleter-live-m1", owner: "mna-deleter" }
};

type FactSpec = Readonly<{
  id: string;
  owner: string;
  /** Creation time: the order facts were saved in. */
  at: string;
  /** SQL expression of the display text. */
  text: string;
  mode: "EXPLICIT" | "AUTOMATIC";
  /** Absent: ACTIVE with its current version. */
  state?: "FORGOTTEN" | "RETRACTED";
  frame?: "EXPLICIT_REMEMBER" | "NONE";
  /** Messages (keys of `messages`) the version cites as supporting user evidence. */
  evidence?: readonly string[];
  scope?: string;
  /** The chat an explicit save came from. */
  sourceChat?: string;
  secret?: boolean;
  /** Safety classification never finished. */
  pending?: boolean;
  /** Expires right after the fixture commits, so the upgrade finds it expired. */
  expiring?: boolean;
}>;

const at = (minute: number, day = "2026-10-01"): string => `${day} 09:${String(minute).padStart(2, "0")}:00`;

const facts: readonly FactSpec[] = [
  // Saved facts under the limit, a remember request, duplicates, trimming, and what is never carried.
  { at: at(1), id: "mna-s1", mode: "EXPLICIT", owner: "mna-saver", text: quote("Answer in short bullet points.") },
  { at: at(2), id: "mna-s2", mode: "EXPLICIT", owner: "mna-saver", text: quote("I work on the billing team.") },
  { at: at(3), evidence: ["mna-saver-m1"], frame: "EXPLICIT_REMEMBER", id: "mna-s3", mode: "AUTOMATIC", owner: "mna-saver",
    text: quote("My manager is Dana.") },
  { at: at(4), id: "mna-s4", mode: "EXPLICIT", owner: "mna-saver", text: quote("Answer in short bullet points.") },
  { at: at(5), evidence: ["mna-saver-m1"], frame: "NONE", id: "mna-s5", mode: "AUTOMATIC", owner: "mna-saver",
    text: quote("Prefers dark mode.") },
  { at: at(6), evidence: ["mna-saver-m1"], id: "mna-s6", mode: "AUTOMATIC", owner: "mna-saver",
    text: quote("I work on the billing team.") },
  { at: at(7), id: "mna-s7", mode: "EXPLICIT", owner: "mna-saver",
    text: `${quote("  Use metric units.")} || ${NEWLINE} || chr(160)` },
  { at: at(8), id: "mna-s8", mode: "EXPLICIT", owner: "mna-saver", state: "FORGOTTEN", text: quote("Synthetic forgotten fact.") },
  { at: at(9), evidence: ["mna-saver-m1"], id: "mna-s9", mode: "AUTOMATIC", owner: "mna-saver", state: "RETRACTED",
    text: quote("Synthetic retracted fact.") },
  { at: at(10), id: "mna-s10", mode: "EXPLICIT", owner: "mna-saver", scope: "mna-saver-chat-scope",
    text: quote("Synthetic chat-scoped fact.") },
  { at: at(11), expiring: true, id: "mna-s11", mode: "EXPLICIT", owner: "mna-saver", text: quote("Synthetic expired fact.") },
  { at: at(12), id: "mna-s12", mode: "EXPLICIT", owner: "mna-saver", pending: true, text: quote("Synthetic unclassified fact.") },
  { at: at(13), id: "mna-s13", mode: "AUTOMATIC", owner: "mna-saver", text: quote("Synthetic unsupported fact.") },
  { at: at(14), id: "mna-s14", mode: "EXPLICIT", owner: "mna-saver", text: quote("   ") },
  // Saved facts over the limit: the first two fill exactly 6 000 characters.
  { at: at(1), id: "mna-o1", mode: "EXPLICIT", owner: "mna-overflow", text: "repeat('a', 3000)" },
  { at: at(2), id: "mna-o2", mode: "EXPLICIT", owner: "mna-overflow", text: "repeat('b', 2999)" },
  { at: at(3), id: "mna-o3", mode: "EXPLICIT", owner: "mna-overflow", text: quote("c") },
  { at: at(4), id: "mna-o4", mode: "EXPLICIT", owner: "mna-overflow", text: quote("Short rule.") },
  { at: at(5), evidence: ["mna-overflow-m1"], id: "mna-o5", mode: "AUTOMATIC", owner: "mna-overflow", text: "repeat('d', 6100)" },
  { at: at(6), id: "mna-o6", mode: "EXPLICIT", owner: "mna-overflow", secret: true, text: quote("Synthetic secret-class fact.") },
  // Memory off still carries the owner's facts.
  { at: at(1), id: "mna-m1", mode: "EXPLICIT", owner: "mna-master-off", text: quote("Synthetic paused-owner fact.") },
  // Learning paused since 2026-10-15: evidence from inside the pause never counted.
  { at: at(1, "2026-10-10"), evidence: ["mna-paused-before"], id: "mna-p1", mode: "AUTOMATIC", owner: "mna-paused",
    text: quote("Synthetic fact before the pause.") },
  { at: at(1, "2026-10-20"), evidence: ["mna-paused-after"], id: "mna-p2", mode: "AUTOMATIC", owner: "mna-paused",
    text: quote("Synthetic fact during the pause.") },
  // Pending chat deletions: one asked to forget its memories, one did not.
  { at: at(1), id: "mna-d1", mode: "EXPLICIT", owner: "mna-deleter", sourceChat: "mna-deleter-forget-chat",
    text: quote("Synthetic forgotten-chat fact.") },
  { at: at(2), evidence: ["mna-deleter-forget-m1"], id: "mna-d2", mode: "AUTOMATIC", owner: "mna-deleter",
    text: quote("Synthetic fact from the forgotten chat.") },
  { at: at(3), id: "mna-d3", mode: "EXPLICIT", owner: "mna-deleter", sourceChat: "mna-deleter-keep-chat",
    text: quote("Synthetic kept-chat fact.") },
  { at: at(4), evidence: ["mna-deleter-forget-m1", "mna-deleter-live-m1"], id: "mna-d4", mode: "AUTOMATIC", owner: "mna-deleter",
    text: quote("Synthetic fact with a live source.") },
  { at: at(5), evidence: ["mna-deleter-keep-m1"], id: "mna-d5", mode: "AUTOMATIC", owner: "mna-deleter",
    text: quote("Synthetic fact from the kept chat.") }
];

function factSql(fact: FactSpec): string {
  const version = `${fact.id}-version`;
  const event = `${fact.id}-event`;
  const explicit = fact.mode === "EXPLICIT";
  const state = fact.state ?? "ACTIVE";
  const evidence = (fact.evidence ?? []).map((message, index) => `
INSERT INTO "MemoryEvidence" (id, "userId", "factVersionId", stance, "sourceType", "chatId", "messageId", "branchGeneration",
  "sourceRole", "safeExcerpt", "safeSourceHash", "sourceProjectionVersion", "safetyClass", "observedAt", "createdAt")
VALUES ('${fact.id}-evidence-${index}', '${fact.owner}', '${version}', 'SUPPORTS', 'MESSAGE', '${messages[message]!.chat}',
  '${message}', 0, 'user', 'Synthetic excerpt', repeat('e', 64), 'mna-legacy-v1', 'NORMAL', '${fact.at}', '${fact.at}');`).join("");
  return `
INSERT INTO "MemoryFact" (id, "userId", "scopeId", "canonicalKey", category, state, "currentVersionId", "forgottenAt",
  "createdAt", "updatedAt")
VALUES ('${fact.id}', '${fact.owner}', '${fact.scope ?? `${fact.owner}-scope`}', 'mna.${fact.id}', 'other', '${state}',
  ${state === "ACTIVE" ? `'${version}'` : "NULL"}, ${state === "FORGOTTEN" ? `'${fact.at}'` : "NULL"}, '${fact.at}', '${fact.at}');
INSERT INTO "MemoryEvent" (id, "userId", operation, "actorType", "actorUserId", "factId", "factVersionId", "sourceChatId", "createdAt")
VALUES ('${event}', '${fact.owner}', '${explicit ? "EXPLICIT_SAVE" : "AUTO_PROPOSE"}', '${explicit ? "USER" : "JOB"}',
  ${explicit ? `'${fact.owner}'` : "NULL"}, '${fact.id}', '${version}', ${fact.sourceChat ? `'${fact.sourceChat}'` : "NULL"}, '${fact.at}');
INSERT INTO "MemoryFactVersion" (id, "userId", "factId", "displayText", "normalizedSearchText", "languageCode", "structuredValue",
  category, modality, "sourceMode", state, confidence, importance, directness, "sensitivityClass", "safetyClassificationState",
  "safetyClassifierPolicyVersion", "safetyClassificationReasonCode", "safetyClassifiedAt", "semanticFrame", "expiresAt",
  "createdByEventId", "pipelineVersion", "systemFrom", "createdAt")
VALUES ('${version}', '${fact.owner}', '${fact.id}', ${fact.text}, 'synthetic', 'en', '{}'::jsonb,
  'other', 'STATE', '${fact.mode}', '${state}', 1, 0.5, 'DIRECT', '${fact.secret ? "SECRET" : "NORMAL"}',
  ${fact.pending ? "'PENDING', NULL, NULL, NULL" : `'CLASSIFIED', 'memory-safety-lite-v1', 'lite_non_secret_default', '${fact.at}'`},
  ${fact.frame ? `'{"memoryDirective":"${fact.frame}"}'::jsonb` : "NULL"},
  ${fact.expiring ? "CURRENT_TIMESTAMP + INTERVAL '1 millisecond'" : "NULL"},
  '${event}', 'mna-legacy-v1', '${fact.at}', '${fact.at}');${evidence}`;
}

const owners = ["mna-saver", "mna-overflow", "mna-master-off", "mna-history-off", "mna-learning-off", "mna-paused",
  "mna-deleter", "mna-mcp", "mna-empty"] as const;

/** One digest of a table's rows, so a proof can show they did not change. */
const rowsDigest = (table: string, where = "TRUE"): string =>
  `(SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY to_jsonb(r)::text), '')) FROM "${table}" AS r WHERE ${where})`;

/** The old Memory tables (and the fixture's chats), which the upgrade only reads. */
const oldMemoryDigest = `md5(concat_ws('|', ${[
  "UserMemorySettings", "MemoryPauseInterval", "MemoryScope", "MemoryFact", "MemoryFactVersion", "MemoryEvidence",
  "MemoryEvent", "MemoryDeletionOutbox", "MemoryUtilityModelPolicy"
].map((table) => rowsDigest(table)).join(", ")}, ${rowsDigest("Chat", `r."userId" LIKE 'mna-%'`)}))`;

/** Everything the upgrade writes. */
const newStateDigest = `md5(concat_ws('|',
  (SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY r."userId"), '')) FROM (SELECT "id", "userId",
    "memoryEnabled", "pastChatSearchEnabled", "memorySuggestionsEnabled", "sendWithEnter", "updatedAt" FROM "UserSettings") AS r),
  ${rowsDigest("UserMemoryNote")}, ${rowsDigest("MemoryLegacySuggestion")},
  (SELECT md5(to_jsonb(r)::text) FROM (SELECT "embeddingProviderModelId", "embeddingConfiguredAt" FROM "SystemModelPolicy"
    WHERE id = 'installation') AS r),
  ${rowsDigest("InboundMcpOAuthGrant")}, ${rowsDigest("InboundMcpOAuthTokenFamily")},
  ${rowsDigest("InboundMcpOAuthAuthorizationCode")}, ${rowsDigest("InboundMcpOAuthToken")}, ${rowsDigest("BackgroundWorkItem")}))`;

export const memoryNoteAdoptionFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES
${owners.map((owner) => `  ('${owner}', 'Synthetic owner', 'active', now())`).join(",\n")};
INSERT INTO "UserSettings" (id, "userId", "sendWithEnter", "updatedAt") VALUES
  ('mna-saver-settings', 'mna-saver', false, '2026-09-01 00:00:00'),
  ('mna-history-off-settings', 'mna-history-off', false, '2026-09-01 00:00:00'),
  ('mna-paused-settings', 'mna-paused', false, '2026-09-01 00:00:00');

-- Two embedding models in use (A by two owners, B by one) and a third as the old installation default.
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('mna-provider', 'Synthetic provider', 'openai', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "modelClass", capabilities, "defaultParams", "updatedAt")
VALUES ('mna-embed-a', 'mna-provider', 'openai', 'synthetic-embedding-a', 'Synthetic embedding A', 'embedding', '{}', '{}', now()),
  ('mna-embed-b', 'mna-provider', 'openai', 'synthetic-embedding-b', 'Synthetic embedding B', 'embedding', '{}', '{}', now()),
  ('mna-embed-c', 'mna-provider', 'openai', 'synthetic-embedding-c', 'Synthetic embedding C', 'embedding', '{}', '{}', now());
UPDATE "MemoryUtilityModelPolicy" SET "embeddingDefaultProviderModelId" = 'mna-embed-c' WHERE id = 'installation';

-- Each switch off once, an open pause behind an on switch, and a closed pause that changes nothing.
UPDATE "UserMemorySettings" SET "embeddingProviderModelId" = 'mna-embed-a' WHERE "userId" IN ('mna-saver', 'mna-overflow');
UPDATE "UserMemorySettings" SET "useMemoryFacts" = false, "embeddingProviderModelId" = 'mna-embed-b' WHERE "userId" = 'mna-master-off';
UPDATE "UserMemorySettings" SET "referenceChatHistory" = false WHERE "userId" = 'mna-history-off';
UPDATE "UserMemorySettings" SET "learnAutomatically" = false WHERE "userId" = 'mna-learning-off';
INSERT INTO "MemoryPauseInterval" (id, "userId", scope, "pausedAt", "resumedAt", "memoryGeneration") VALUES
  ('mna-pause-master', 'mna-master-off', 'MASTER', '2026-10-15 00:00:00', NULL, 0),
  ('mna-pause-learning', 'mna-paused', 'AUTOMATIC_LEARNING', '2026-10-15 00:00:00', NULL, 0),
  ('mna-pause-closed', 'mna-learning-off', 'SEARCH_HISTORY', '2026-10-02 00:00:00', '2026-10-03 00:00:00', 0);

INSERT INTO "Chat" (id, "userId", title, "createdAt", "updatedAt") VALUES
${Object.entries(chats).map(([id, chat]) => `  ('${id}', '${chat.owner}', 'Synthetic chat', '2026-10-01 07:00:00', '2026-10-01 07:00:00')`).join(",\n")};
INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "createdAt", "updatedAt") VALUES
${Object.entries(messages).map(([id, message]) => `  ('${id}', '${message.chat}', 'user', 'complete',
    '{"blocks":[{"type":"text","text":"Synthetic message"}]}', ${message.parent ? `'${message.parent}'` : "NULL"}, '${message.at}', '${message.at}')`).join(",\n")};
${Object.entries(chats).map(([id, chat]) => `UPDATE "Chat" SET "activeLeafMessageId" = '${chat.leaf}' WHERE id = '${id}';`).join("\n")}

INSERT INTO "MemoryScope" (id, "userId", "scopeType") VALUES
${owners.map((owner) => `  ('${owner}-scope', '${owner}', 'GLOBAL_USER')`).join(",\n")};
-- Legacy scoped Memory never became Personal Memory.
INSERT INTO "MemoryScope" (id, "userId", "scopeType", "targetIdSnapshot", "chatId")
VALUES ('mna-saver-chat-scope', 'mna-saver', 'CHAT', 'mna-saver-chat', 'mna-saver-chat');
${facts.map(factSql).join("\n")}

-- The previous release fenced these chats and queued their purge; one asked to forget its memories.
INSERT INTO "MemoryDeletionOutbox" (id, "userId", operation, "targetType", "targetId", "memoryGeneration",
  "admissionAuthorizationId", "admittedChatSourceRevision", "alsoForgetOriginMemories", state, "nextAttemptAt",
  "attemptCount", "completedAt", "lastAuditAt", "createdAt", "updatedAt") VALUES
  ('mna-purge-forget', 'mna-deleter', 'SOURCE_PURGE', 'CHAT@memory-chat-delete-v1', 'mna-deleter-forget-chat', 0,
    'mna-auth-forget', 0, true, 'PENDING', NULL, 0, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('mna-purge-keep', 'mna-deleter', 'SOURCE_PURGE', 'CHAT@memory-chat-delete-v1', 'mna-deleter-keep-chat', 0,
    'mna-auth-keep', 0, false, 'RETRY_WAIT', CURRENT_TIMESTAMP + INTERVAL '1 hour', 1, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- Finished: one this week, one before it, and a Forget that is not a chat deletion.
  ('mna-purge-recent', 'mna-deleter', 'SOURCE_PURGE', 'CHAT@memory-chat-delete-v1', 'mna-gone-recent', 0,
    'mna-auth-recent', 0, false, 'SUCCEEDED', NULL, 3, CURRENT_TIMESTAMP - INTERVAL '2 days', CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '3 days', CURRENT_TIMESTAMP - INTERVAL '2 days'),
  ('mna-purge-old', 'mna-deleter', 'SOURCE_PURGE', 'CHAT@memory-chat-delete-v1', 'mna-gone-old', 0,
    'mna-auth-old', 0, false, 'SUCCEEDED', NULL, 1, CURRENT_TIMESTAMP - INTERVAL '8 days', CURRENT_TIMESTAMP - INTERVAL '8 days',
    CURRENT_TIMESTAMP - INTERVAL '9 days', CURRENT_TIMESTAMP - INTERVAL '8 days');
INSERT INTO "MemoryDeletionOutbox" (id, "userId", operation, "targetType", "targetId", "memoryGeneration", state,
  "attemptCount", "completedAt", "lastAuditAt", "createdAt", "updatedAt")
VALUES ('mna-forget-recent', 'mna-deleter', 'FORGET_PURGE', 'MEMORY_FACT@memory-purge-v1', 'mna-gone-fact', 0, 'SUCCEEDED',
  1, CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP - INTERVAL '1 day',
  CURRENT_TIMESTAMP - INTERVAL '1 day');
UPDATE "Chat" SET archived = true, "permanentDeletionAt" = CURRENT_TIMESTAMP, "permanentDeletionOperationId" = 'mna-purge-forget'
WHERE id = 'mna-deleter-forget-chat';
UPDATE "Chat" SET archived = true, "permanentDeletionAt" = CURRENT_TIMESTAMP, "permanentDeletionOperationId" = 'mna-purge-keep'
WHERE id = 'mna-deleter-keep-chat';

-- Connected apps: an active Memory grant with its live tokens and codes, a Hub grant of the same app, and a
-- Memory grant the owner already revoked.
INSERT INTO "InboundMcpOAuthClient" (id, "clientId", "clientName", "clientOrigin", "redirectUris", "applicationType", kind,
  "metadataFingerprint", "updatedAt")
VALUES ('mna-client', 'https://client.example.com/oauth/client.json', 'Synthetic client', 'https://client.example.com',
  ARRAY['https://client.example.com/callback'], 'WEB', 'CLIENT_ID_METADATA_DOCUMENT', repeat('f', 64), now());
INSERT INTO "InboundMcpOAuthGrant" (id, "userId", "oauthClientId", revision, state, "revokedAt", "resourcePath", capability, "updatedAt") VALUES
  ('mna-grant-memory', 'mna-mcp', 'mna-client', 1, 'ACTIVE', NULL, '/mcp', 'memory:facts', '2026-11-01 00:00:00'),
  ('mna-grant-hub', 'mna-mcp', 'mna-client', 1, 'ACTIVE', NULL, '/mcp/hub', 'mcp:hub', '2026-11-01 00:00:00'),
  ('mna-grant-revoked', 'mna-saver', 'mna-client', 2, 'REVOKED', '2026-11-02 00:00:00', '/mcp', 'memory:facts', '2026-11-02 00:00:00');
INSERT INTO "InboundMcpOAuthTokenFamily" (id, "grantId", "grantRevision", issuer, resource, "inactivityExpiresAt", "revokedAt",
  "revocationReason", "resourcePath", capability, "updatedAt") VALUES
  ('mna-family-memory', 'mna-grant-memory', 1, 'https://aiqsa.example.com', 'https://aiqsa.example.com/mcp',
    CURRENT_TIMESTAMP + INTERVAL '30 days', NULL, NULL, '/mcp', 'memory:facts', now()),
  ('mna-family-hub', 'mna-grant-hub', 1, 'https://aiqsa.example.com', 'https://aiqsa.example.com/mcp/hub',
    CURRENT_TIMESTAMP + INTERVAL '30 days', NULL, NULL, '/mcp/hub', 'mcp:hub', now()),
  ('mna-family-revoked', 'mna-grant-revoked', 1, 'https://aiqsa.example.com', 'https://aiqsa.example.com/mcp',
    CURRENT_TIMESTAMP + INTERVAL '30 days', '2026-11-02 00:00:00', 'connected_app_revoked', '/mcp', 'memory:facts', now());
INSERT INTO "InboundMcpOAuthToken" (id, "familyId", kind, "tokenHash", "expiresAt", "resourcePath", capability) VALUES
  ('mna-token-memory', 'mna-family-memory', 'ACCESS', repeat('1', 64), CURRENT_TIMESTAMP + INTERVAL '1 hour', '/mcp', 'memory:facts'),
  ('mna-token-hub', 'mna-family-hub', 'ACCESS', repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '1 hour', '/mcp/hub', 'mcp:hub');
INSERT INTO "InboundMcpOAuthAuthorizationCode" (id, "codeHash", "grantId", "oauthClientId", "grantRevision", "redirectUri",
  "codeChallenge", issuer, resource, "expiresAt", "consumedAt", "resourcePath", capability) VALUES
  ('mna-code-memory-open', repeat('3', 64), 'mna-grant-memory', 'mna-client', 1, 'https://client.example.com/callback',
    repeat('A', 43), 'https://aiqsa.example.com', 'https://aiqsa.example.com/mcp', CURRENT_TIMESTAMP + INTERVAL '10 minutes',
    NULL, '/mcp', 'memory:facts'),
  ('mna-code-memory-used', repeat('4', 64), 'mna-grant-memory', 'mna-client', 1, 'https://client.example.com/callback',
    repeat('B', 43), 'https://aiqsa.example.com', 'https://aiqsa.example.com/mcp', CURRENT_TIMESTAMP + INTERVAL '10 minutes',
    CURRENT_TIMESTAMP, '/mcp', 'memory:facts'),
  ('mna-code-hub-open', repeat('5', 64), 'mna-grant-hub', 'mna-client', 1, 'https://client.example.com/callback',
    repeat('C', 43), 'https://aiqsa.example.com', 'https://aiqsa.example.com/mcp/hub', CURRENT_TIMESTAMP + INTERVAL '10 minutes',
    NULL, '/mcp/hub', 'mcp:hub');

CREATE TABLE "_MemoryNoteAdoptionFixture" AS SELECT ${oldMemoryDigest} AS "oldMemory";
`;

const expectedNotes: readonly (readonly [string, string])[] = [
  ["mna-saver", [quote("Answer in short bullet points."), quote("I work on the billing team."), quote("My manager is Dana."),
    quote("Use metric units.")].join(` || ${NEWLINE} || `)],
  ["mna-overflow", `repeat('a', 3000) || ${NEWLINE} || repeat('b', 2999)`],
  ["mna-master-off", quote("Synthetic paused-owner fact.")],
  ["mna-deleter", quote("Synthetic kept-chat fact.")]
];

const expectedSuggestions: readonly (readonly [string, "AUTOMATIC" | "SAVED_OVERFLOW", string, string])[] = [
  ["mna-saver", "AUTOMATIC", quote("Prefers dark mode."), at(5)],
  ["mna-overflow", "SAVED_OVERFLOW", quote("c"), at(3)],
  ["mna-overflow", "SAVED_OVERFLOW", quote("Short rule."), at(4)],
  ["mna-overflow", "AUTOMATIC", "repeat('d', 6000)", at(5)],
  ["mna-overflow", "SAVED_OVERFLOW", quote("Synthetic secret-class fact."), at(6)],
  ["mna-paused", "AUTOMATIC", quote("Synthetic fact before the pause."), at(1, "2026-10-10")],
  ["mna-deleter", "AUTOMATIC", quote("Synthetic fact with a live source."), at(4)]
];

const notesValues = `(VALUES ${expectedNotes.map(([owner, text]) => `('${owner}', ${text})`).join(", ")})`;
const suggestionsValues = `(VALUES ${expectedSuggestions.map(([owner, origin, text, created]) =>
  `('${owner}', '${origin}', ${text}, TIMESTAMP '${created}')`).join(", ")})`;
const actualNotes = `(SELECT "userId", "text" FROM "UserMemoryNote"
  WHERE "revision" = 1 AND "lastChangedBy" = 'USER'::"MemoryNoteAuthor" AND "updatedAt" IS NOT NULL)`;
const actualSuggestions = `(SELECT "userId", "origin"::text, "text", "createdAt" FROM "MemoryLegacySuggestion")`;

/** Every outcome of the main fixture, row for row. */
const memoryNoteAdoptionAssertionsSql = `
DO $$ BEGIN
  -- Switches: only an off switch is written; rows are created only where one is off.
  IF (SELECT count(*) FROM "UserSettings" WHERE "userId" LIKE 'mna-%') <> 5
    THEN RAISE EXCEPTION 'memory_note_adoption_settings_rows'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'mna-saver' AND id = 'mna-saver-settings'
      AND "memoryEnabled" AND "pastChatSearchEnabled" AND "memorySuggestionsEnabled"
      AND NOT "sendWithEnter" AND "updatedAt" = '2026-09-01 00:00:00')
    THEN RAISE EXCEPTION 'memory_note_adoption_saver_settings_changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'mna-master-off'
      AND NOT "memoryEnabled" AND "pastChatSearchEnabled" AND "memorySuggestionsEnabled" AND "sendWithEnter")
    THEN RAISE EXCEPTION 'memory_note_adoption_master_switch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'mna-history-off' AND id = 'mna-history-off-settings'
      AND "memoryEnabled" AND NOT "pastChatSearchEnabled" AND "memorySuggestionsEnabled"
      AND NOT "sendWithEnter" AND "updatedAt" = '2026-09-01 00:00:00')
    THEN RAISE EXCEPTION 'memory_note_adoption_history_switch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'mna-learning-off'
      AND "memoryEnabled" AND "pastChatSearchEnabled" AND NOT "memorySuggestionsEnabled" AND "sendWithEnter")
    THEN RAISE EXCEPTION 'memory_note_adoption_learning_switch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'mna-paused' AND id = 'mna-paused-settings'
      AND "memoryEnabled" AND "pastChatSearchEnabled" AND NOT "memorySuggestionsEnabled"
      AND NOT "sendWithEnter" AND "updatedAt" = '2026-09-01 00:00:00')
    THEN RAISE EXCEPTION 'memory_note_adoption_open_pause'; END IF;

  -- The embedding model most owners selected, not the old default; never marked as an administrator's choice.
  IF NOT EXISTS (SELECT 1 FROM "SystemModelPolicy" WHERE id = 'installation'
      AND "embeddingProviderModelId" = 'mna-embed-a' AND "embeddingConfiguredAt" IS NULL)
    THEN RAISE EXCEPTION 'memory_note_adoption_embedding_model'; END IF;

  -- Notes: saved facts in saved order, once each, trimmed; the second owner's note is exactly at the limit.
  IF (SELECT count(*) FROM "UserMemoryNote") <> ${expectedNotes.length}
    OR EXISTS (${actualNotes} EXCEPT ${notesValues}) OR EXISTS (${notesValues} EXCEPT ${actualNotes})
    THEN RAISE EXCEPTION 'memory_note_adoption_notes'; END IF;
  IF (SELECT char_length("text") FROM "UserMemoryNote" WHERE "userId" = 'mna-overflow') <> 6000
    THEN RAISE EXCEPTION 'memory_note_adoption_note_limit'; END IF;

  -- Suggestions: overflow and secret-class saved facts, and ordinary automatic facts with a live source, clipped.
  IF (SELECT count(*) FROM "MemoryLegacySuggestion") <> ${expectedSuggestions.length}
    OR EXISTS (${actualSuggestions} EXCEPT ${suggestionsValues}) OR EXISTS (${suggestionsValues} EXCEPT ${actualSuggestions})
    THEN RAISE EXCEPTION 'memory_note_adoption_suggestions'; END IF;

  -- Inbound Memory MCP is revoked as Connected apps' Revoke does; the Hub and an earlier revocation stay as they were.
  IF NOT EXISTS (SELECT 1 FROM "InboundMcpOAuthGrant" WHERE id = 'mna-grant-memory'
      AND state = 'REVOKED' AND revision = 2 AND "revokedAt" IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM "InboundMcpOAuthTokenFamily" WHERE id = 'mna-family-memory'
      AND "revokedAt" IS NOT NULL AND "revocationReason" = 'memory_mcp_removed')
    OR EXISTS (SELECT 1 FROM "InboundMcpOAuthAuthorizationCode" WHERE id = 'mna-code-memory-open')
    OR NOT EXISTS (SELECT 1 FROM "InboundMcpOAuthAuthorizationCode" WHERE id = 'mna-code-memory-used')
    THEN RAISE EXCEPTION 'memory_note_adoption_memory_grant_not_revoked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "InboundMcpOAuthGrant" WHERE id = 'mna-grant-hub'
      AND state = 'ACTIVE' AND revision = 1 AND "revokedAt" IS NULL AND "updatedAt" = '2026-11-01 00:00:00')
    OR NOT EXISTS (SELECT 1 FROM "InboundMcpOAuthTokenFamily" WHERE id = 'mna-family-hub'
      AND "revokedAt" IS NULL AND "revocationReason" IS NULL)
    OR NOT EXISTS (SELECT 1 FROM "InboundMcpOAuthAuthorizationCode" WHERE id = 'mna-code-hub-open')
    THEN RAISE EXCEPTION 'memory_note_adoption_hub_grant_changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "InboundMcpOAuthGrant" WHERE id = 'mna-grant-revoked'
      AND state = 'REVOKED' AND revision = 2 AND "revokedAt" = '2026-11-02 00:00:00' AND "updatedAt" = '2026-11-02 00:00:00')
    OR NOT EXISTS (SELECT 1 FROM "InboundMcpOAuthTokenFamily" WHERE id = 'mna-family-revoked'
      AND "revokedAt" = '2026-11-02 00:00:00' AND "revocationReason" = 'connected_app_revoked')
    OR (SELECT count(*) FROM "InboundMcpOAuthToken" WHERE id IN ('mna-token-memory', 'mna-token-hub')) <> 2
    THEN RAISE EXCEPTION 'memory_note_adoption_revoked_grant_changed'; END IF;

  -- Only the chat deletion finished this week answers as complete, exactly as the status route reads it.
  IF (SELECT count(*) FROM "BackgroundWorkItem" WHERE "userId" LIKE 'mna-%') <> 1
    OR NOT EXISTS (SELECT 1 FROM "BackgroundWorkItem" AS work
      INNER JOIN "MemoryDeletionOutbox" AS deletion ON deletion.id = 'mna-purge-recent'
      WHERE work.duty = 'permanent_chat_deletion' AND work."itemId" = 'mna-gone-recent' AND work."userId" = 'mna-deleter'
        AND work."completedAt" = deletion."completedAt" AND work."attemptCount" = 3
        AND work."leaseToken" IS NULL AND work."nextAttemptAt" IS NULL AND work."lastErrorCode" IS NULL)
    THEN RAISE EXCEPTION 'memory_note_adoption_finished_deletions'; END IF;

  -- The old Memory tables, the pending deletions' fences included, are only read.
  IF (SELECT "oldMemory" FROM "_MemoryNoteAdoptionFixture") IS DISTINCT FROM ${oldMemoryDigest}
    THEN RAISE EXCEPTION 'memory_note_adoption_old_tables_changed'; END IF;
END $$;
`;

export const memoryNoteAdoptionProofSql = `
${memoryNoteAdoptionAssertionsSql}
CREATE TEMPORARY TABLE "_MemoryNoteAdoptionAfter" AS SELECT ${newStateDigest} AS digest;
${migrationBody}
DO $$ BEGIN
  IF (SELECT digest FROM "_MemoryNoteAdoptionAfter") IS DISTINCT FROM ${newStateDigest}
    THEN RAISE EXCEPTION 'memory_note_adoption_body_not_idempotent'; END IF;
END $$;
${memoryNoteAdoptionAssertionsSql}
`;

export const memoryNoteAdoptionRepeatProofSql = memoryNoteAdoptionAssertionsSql;

/** An installation with accounts but no Memory data and no embedding model in use. */
export const memoryNoteAdoptionBareFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('mna-bare', 'Synthetic owner', 'active', now());
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('mna-bare-provider', 'Synthetic provider', 'openai', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "modelClass", capabilities, "defaultParams", "updatedAt")
VALUES ('mna-bare-embed-d', 'mna-bare-provider', 'openai', 'synthetic-embedding-d', 'Synthetic embedding D', 'embedding', '{}', '{}', now()),
  ('mna-bare-embed-e', 'mna-bare-provider', 'openai', 'synthetic-embedding-e', 'Synthetic embedding E', 'embedding', '{}', '{}', now()),
  ('mna-bare-answer', 'mna-bare-provider', 'openai', 'synthetic-answer', 'Synthetic answer model', 'answer', '{}', '{}', now());
`;

const bareEmbedding = (expected: string | null, code: string): string => `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SystemModelPolicy" WHERE id = 'installation' AND "embeddingConfiguredAt" IS NULL
      AND "embeddingProviderModelId" ${expected === null ? "IS NULL" : `= '${expected}'`})
    THEN RAISE EXCEPTION '${code}'; END IF;
END $$;`;

const memoryNoteAdoptionBareAssertionsSql = `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "UserSettings") OR EXISTS (SELECT 1 FROM "UserMemoryNote")
      OR EXISTS (SELECT 1 FROM "MemoryLegacySuggestion") OR EXISTS (SELECT 1 FROM "BackgroundWorkItem")
    THEN RAISE EXCEPTION 'memory_note_adoption_bare_rows_invented'; END IF;
END $$;
${bareEmbedding(null, "memory_note_adoption_bare_embedding_invented")}
`;

/**
 * Nothing in use invents nothing; then, on the body run again, an answer model as the old default is never taken,
 * the old default is taken when no owner selected a model, and a role already set is never overwritten.
 * Ends rolled back.
 */
export const memoryNoteAdoptionBareProofSql = `
${memoryNoteAdoptionBareAssertionsSql}
BEGIN;
UPDATE "MemoryUtilityModelPolicy" SET "embeddingDefaultProviderModelId" = 'mna-bare-answer' WHERE id = 'installation';
${migrationBody}
${bareEmbedding(null, "memory_note_adoption_bare_answer_model_taken")}
UPDATE "MemoryUtilityModelPolicy" SET "embeddingDefaultProviderModelId" = 'mna-bare-embed-d' WHERE id = 'installation';
${migrationBody}
${bareEmbedding("mna-bare-embed-d", "memory_note_adoption_bare_default_not_taken")}
UPDATE "UserMemorySettings" SET "embeddingProviderModelId" = 'mna-bare-embed-e' WHERE "userId" = 'mna-bare';
${migrationBody}
${bareEmbedding("mna-bare-embed-d", "memory_note_adoption_bare_role_overwritten")}
ROLLBACK;
${memoryNoteAdoptionBareAssertionsSql}
`;

export const memoryNoteAdoptionBareRepeatProofSql = memoryNoteAdoptionBareAssertionsSql;
