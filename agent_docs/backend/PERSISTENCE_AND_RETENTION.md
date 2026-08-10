# BACKEND PERSISTENCE AND RETENTION

Owner: Persistence contract maintainers
Scope: Current cross-table constraints, durable ownership, retention, deletion-job, migration, and schema-adjacent behavior; field inventory remains generated.

## Retention Maintenance

AIQSA ships a manual/cron-friendly retention command:

```bash
# disposable development stack
docker compose -f docker-compose.dev.yml run --rm app npm run prune -- --dry-run
docker compose -f docker-compose.dev.yml run --rm app npm run prune -- --execute

# persistent installation, after migration/bootstrap succeeds
docker compose run --rm migrate-bootstrap npm run prune -- --dry-run
docker compose run --rm migrate-bootstrap npm run prune -- --execute
```

The installation release image's one-shot tools role is the cron/manual owner when the standalone runtime is deployed; override its normal bootstrap command with the same `npm run prune -- ...` invocation. The command defaults to dry-run, 30-day terminal `ModelRunEvent`, auth-state, and stale Knowledge-payload retention windows, a 7-day orphaned-attachment window, a 15-minute deletion-job lease, and a 1,000-row batch. `--event-days`, `--auth-days`, `--knowledge-payload-days`, `--orphan-attachment-days`, `--deletion-job-lease-minutes`, and `--batch-size` tune those values.

Dry-run performs only bounded reads. Execute mode deletes old events only for terminal runs; deletes only expired/revoked sessions and consumed/expired auth-flow tokens older than the auth cutoff; and stages orphan and stale Knowledge cleanup transactionally. Knowledge cleanup initially covers only old `failed`, never-visible, non-current versions: it removes partial chunks/embedding-usage markers, clears original/normalized object references, records `payloadPurgedAt`, and retains immutable version identity and bounded failure metadata. Any version that was retrieval-visible remains conservative until run bindings own an explicit recovery-authority cutoff. Orphan selection intentionally includes old attachment `failed` rows and stale `processing` rows; deleting an attachment cascades its processing job. For each storage key, staging takes an advisory lock, rechecks both attachment and Knowledge references, creates or reuses one `AttachmentDeletionJob` only after the last reference is released, and never queues or claims an object still referenced by either aggregate. Run creation links only `ready` uploaded attachments with the inverse compare-and-set (`userId`, `chatId = null`, `messageId = null`, `status = ready`) and rolls its whole graph back with `409 attachment_not_available` if prune or another run won. Deletion workers claim jobs in bounded `FOR UPDATE SKIP LOCKED` leases; object deletion is idempotent, a crash after delete is retried after lease expiry, and failures release durable work with only a stable error code/job id in the summary—never a storage key or provider error string.

## Backup And Restore

`ops/backup/create.sh` is the supported bundled-Postgres/MinIO consistency
boundary. It records whether `app` and `memory-worker` were running, stops both,
verifies neither remains live, and then atomically moves every claimed Memory
job to due `RETRYABLE_FAILED` and every running Memory deletion obligation to
due `RETRY_WAIT` with the stable `memory_backup_fenced` code. Tokens and lease
deadlines are cleared in the same transition, so a stale pre-backup claimant
cannot settle after restart. The transition is conditional on the Memory tables
existing, allowing the current helper to make the required pre-migration backup
of an older installation. Only after that fence does it dump PostgreSQL and
mirror the private bucket; cleanup restarts exactly the writer roles that were
running before the attempt.

Backup format 2 adds the sorted distinct non-secret
`MemorySuppression.fingerprintKeyVersion` IDs to `manifest.env`; key material
never enters the bundle. Format 1 remains structurally verifiable for recovery
of older pre-activation installations. Restore still accepts only explicitly
acknowledged empty disposable services and never starts either writer. It first
validates manifest IDs with the separately recovered keyring, restores the
database transactionally, reads the authoritative distinct IDs back, checks a
format-2 manifest match, and repeats key preflight before object restore and
successful handoff. A missing or invalid key leaves the disposable target
diagnosable but blocks automatic Memory resume. Production promotion still
requires the separate deletion-journal, barrier/outbox, bearer-endpoint, and
resurrection review owned by the Memory lifecycle contract.

## Core Tables

The executable model inventory is `prisma/schema.prisma`. Its current categories are identity/session/approval, users/groups/settings/grants, folders/chats/message DAGs, Assistant definitions/revisions/publications/pins, provider/search catalog, runs/events/usage, MCP definitions/revisions/grants/user state/runtime evidence/tool calls, attachments plus their durable processing queue and purpose-built deletion outbox, per-pipeline document-processing fairness cursors, Native Memory settings/authority/derivative/operational evidence, and immutable share snapshots. Living prose records only cross-table constraints that affect behavior.

Native Memory scope identity is immutable. A typed `FOLDER`, `ASSISTANT`, or
`CHAT` scope carries both its owner and its restrictive live-target relation;
the Assistant relation additionally proves the same owner at the database
boundary. Deferred constraints require every active fact to reference an active
scope at commit and reject an in-place fact rescope. Target deletion changes
the scope to a tombstone, clears the live target relation while retaining
bounded target snapshots, clears active fact pointers, and leaves explicit Move
lineage to a distinct same-owner fact rather than rewriting old history.

`DocumentProcessingFairnessCursor` has exactly the independent `attachment`,
`knowledge`, `memory-job`, and `memory-delete` rows. Its nullable last-owner
value intentionally has no user foreign key: a deleted previous owner remains
only the lexical position from which the next live rotation continues. Each
successful claim locks its one pipeline row, chooses the first eligible owner
lexicographically after the last grant with wraparound, and advances only after
atomically claiming work. An empty cursor starts from the globally oldest
eligible owner head, breaking a tie by owner id. Thus, while `K` owners stay
eligible in one pipeline, every window of the next `K` successful grants
contains each owner once; a newly eligible owner joins within at most `K`
subsequent successful grants. The guarantee is per pipeline and non-preemptive:
already running work still has to release a slot, and a sole eligible owner may
use every available worker. This is scheduling fairness, not a per-user quota
or admission limit. Each physical document queue row copies its immutable
owning user id and proves that copy against its parent with a composite foreign
key. Owner-first due indexes let the document steady-state claim use separate
after-cursor and wraparound range seeks while holding the short cursor lock;
the empty-cursor path alone selects the globally oldest eligible owner head.
Terminal history is excluded from the partial Knowledge queue indexes so
backlog size does not turn a grant into a full eligible-set sort. Prisma owns
the ordinary Attachment indexes; the forward migration owns the two exact
partial Knowledge predicates because the supported Prisma version cannot
represent partial-index conditions. The focused migration contract pins those
predicates and proves their bounded owner-range query plans.

The Memory coordinator uses the same short cursor transaction for
registered `MemoryJob` kinds and registered `MemoryDeletionOutbox` operations.
Jobs require a currently active owner; queued, retryable, waiting, or
expired-claimed work for an unavailable owner is cancelled with a stable code.
Deletion obligations deliberately remain claimable after owner disablement or
account teardown. Claims increment attempts and carry random lease tokens;
heartbeat, stage, retry, gate settlement, and final apply compare the exact
owner, state, token, and unexpired lease. Consent waiting carries neither lease
nor fallback authority. Job apply and success settle in one transaction.
Deletion apply and success do likewise; failures release to bounded retry and
then `BLOCKED_REQUIRES_ADMIN` with a slow due time and audit timestamp, never a
terminal abandoned state. The default registry claims `FORGET_PURGE`,
`TEMPORARY_DELETE`, and the optional fail-closed `EMBED_ITEMS` leaf.
Its typed manifest requires versioned contributors for unaccepted retrieval
attempts, fact evidence, fact search rows (including their vectors/FTS), and
forgotten version content. All leaves and the final completeness audit execute
inside the claim's apply/success transaction, so a crash or failing leaf rolls
the complete purge attempt back. Scrubbing an item from a nonterminal Memory
attempt also settles its `PREPARING` run and assistant message atomically, which
preserves the deferred run/attempt guard. Missing contributors refuse claims;
residual audits refuse success. Status audits and startup reconciliation can
move an earlier `SUCCEEDED` row back to `PENDING` when a later versioned
contributor discovers work, and startup drains the pre-start success set in
bounded batches before claims begin. Other deletion operations and every job
kind remain dormant until their owning slices register handlers. Development
starts the feature-local coordinator from server instrumentation; production
runs the same coordinator code in the private `memory-worker` role. Both
preflight the suppression keyring and every referenced historical key ID before
reconciliation and claims.

Temporary is a guarded first-send transition from an empty `NORMAL` chat. It
atomically writes policy `temporary-24h-v1`, deadline, first graph, and exactly
one `TEMPORARY_CHAT@temporary-24h-v1` deletion row. Deferred guards enforce or
adopt that unique binding; only its live `RUNNING` lease may delete the chat.

At expiry the handler locks/rechecks the chat, blocks reusable-Memory
corruption, settles active run/attempt/execution/tool state, and deletes the
complete run/chat/share/attachment aggregate in claim-success. Object deletion
is crash-idempotent, preserves keys/jobs with any Attachment/Knowledge
reference, and requires an unchanged manifest plus empty audit before success.

`User.role`/`User.status`, identity/session/token/rule/invite relations, and exact normalized email/domain matching implement the auth state machine. The schema owns field/enumeration shape; the bounded owners routed by `SECURITY.md` own the threat and session contract.

`AuthRateLimitBucket` is the shared fixed-window admission state for every authentication process. Its primary key is a domain-separated installation-secret HMAC of the logical account/token/client bucket; only the bounded attempt count, expiry, and update time accompany it. One PostgreSQL upsert atomically resets an expired window or increments/caps the current one, and the expiry index supports opportunistic cleanup. No raw email, IP, token, credential, or user id is stored in this table.

`McpServer` owns one mutable draft and a pointer to an immutable `McpRevision`; `McpGrant` has exactly one user or group principal, and database checks forbid group personal-slot permissions and empty grants. `McpUserServer` stores preference plus one encrypted personal envelope. Shared, personal, OAuth, and effective runtime values use versioned AES-256-GCM envelopes under `AIQSA_ENCRYPTION_KEY`; runtime generations are disposable while run bindings retain a safe fingerprint plus bounded credential-source/account-label evidence. `ModelRunToolCall` and `ModelRun.toolLoopState` are the compact durable continuation surface. A server deletion tombstone remains only until no revision owns a runtime generation; reconciliation then detaches the active revision and deletes the live server graph without deleting run-owned bindings/calls. User/group hard-delete eligibility counts current MCP configuration so it cannot fall through to an unhandled foreign-key failure; MCP run history follows the existing `ModelRun` ownership.

`SearchPolicy` is one installation-owned optimistic-versioned row containing the
ordered zero-to-three-option recommendation. `UserSettings` stores nullable
`defaultSearchPlan` alongside provider/model/folder defaults, presentation
toggles, and the JSON map of per-model run-control drafts. SQL null, a non-null
empty plan, and a non-empty plan encode the three product states defined by
[Search plans](../run_pipeline/SEARCH_PLANS.md); persistence never writes a
derived model-compatible subset back into that column. Tool activity has a
database default of true. Existing non-null rows remain personal during
migration, newly provisioned rows inherit, and legacy
`defaultSearchStrategyId` remains only a first-option/Off rollback and old-wire
mirror. Per-model singleton Search hints are migration-read compatibility and
are no longer written.

`ModelPolicy` is the singleton installation-owned optimistic-versioned model
recommendation. Its nullable restrictive foreign key stores one exact
`ProviderModel`; migration, bootstrap, and the development seed create a null
foundation without copying or overwriting any existing operator choice.
`UserSettings.defaultProviderModelId` is the independent nullable personal
override: null means dynamic installation inheritance, while non-null preserves
source precedence even if that deployment later becomes unavailable. Neither
policy grants access or credentials. Individual model deletion is blocked by an
installation policy reference. A confirmed non-template connection graph
deletion may clear a child policy in the same serializable transaction,
incrementing its version; disablement or readiness loss never retargets it.

`SystemModelPolicy` is the separate singleton installation-owned
optimistic-versioned system utility role. Its nullable restrictive foreign key
stores one exact answer-selectable `ProviderModel`; migration, bootstrap, and
the development seed create an empty foundation and never infer a target. The
row's `updatedByUserId` is audit metadata only. Resolution uses the selected
model's explicit installation default credential plus the exact current
availability check, regardless of ordinary unassigned-user policy, and does not
consult direct-user or group assignments. It does not require or grant model
entitlement. A null target returns `system_model_absent`; a disabled/deleted
target, invalid configuration, or missing/unusable default credential or exact
check returns `system_model_unavailable`. Resolution never chooses another
model, administrator, or credential tier. Deactivating, demoting, or deleting
the saving administrator may change or null the audit reference but cannot
change role availability. Individual model deletion is blocked by the
restrictive role reference; confirmed non-template connection graph deletion
may clear a child role and advance its version inside the same guarded
transaction.

`SearchOption` is the stable user-visible Search source and, except for the connectionless `search-disabled` Off sentinel, owns display/lifecycle state plus one exact source `ProviderConnection`; user settings, organization policy, grants, and new run requests retain its logical id. `SearchStrategy` is a physical execution route below that parent. It owns a typed mutable draft, optional diagnostic evidence, enabled/archive state, and a pointer to an immutable configuration-evidenced `SearchIntegrationRevision`; hosted and query-only routes never become separate user choices. Revisions never authorize one user's credential. Obsolete credential-bound probe evidence may remain immutable archaeology, but catalog/admission ignore it and resolve the current user/model/credential/check instead. Append-only repair migrations may deterministically create or reactivate a missing same-connection query-only route from an eligible active Responses or native Gemini Search model without network or credential access; they preserve option ids, grants, preferences, hosted routes, revisions, accepted run bindings, and provider models and are idempotent. `SearchRunBinding` snapshots every accepted logical option in plan order together with its exact physical strategy/revision, mode, and optional technical provider binding key. `ProviderRunBinding` is unique by `(modelRunId, bindingKey)`, so one run can retain `answer` plus one exact credential/model snapshot per client engine. `SearchRun` is one actual invocation and keeps exact revision/invocation/query, bounded preview/artifacts, duration, status, usage-bearing evidence, canonical grounded findings, explicit normalized citation sources, and optional bounded provider-operation facts; no invocation row is created merely because an option was selected. The settled owning `ModelRunToolCall` stores the per-engine findings, sources, warnings, operations, and usage once in a versioned canonical execution projection; its compact persisted content marker is rehydrated deterministically into provider-facing text for foreground reuse or recovery without a provider replay. Legacy ordinary tool-result checkpoints retain their existing decoder, while a malformed canonical marker or execution fails with `tool_call_result_invalid`. Per-engine findings are bounded by both characters and 48 KiB of UTF-8, and the complete serialized result remains within the shared 256 KiB tool-result ceiling; overflow is settled as bounded attributable Search error evidence rather than a run-level snapshot failure. Raw provider bodies, Gemini Suggestions/signatures/steps, and recursively discovered preview fields are not storage authority. The exact parent tool relation remains that owning tool call rather than a parsed provider invocation id.

The Assistant aggregate is `AssistantDefinition` (stable identity, owner, optimistic version, current-revision pointer, soft archive), append-only `AssistantRevision` rows (revision number, schema version, name/description/bounded category, exact generated-avatar recipe JSON, restrictive `ProviderModel` foreign key, system/developer prompts, provider-neutral run controls, logical Search plan, logical MCP server ids, up to four starter prompts, author), `AssistantPublication` rows pinning one exact revision per active group or installation-wide (a check ties scope to group presence and a partial unique index allows one installation row per definition), and per-user `AssistantPin` preference rows that grant no access and never enter run evidence. `ModelRun.assistantId`/`assistantRevisionId` carry accepted provenance through a composite foreign key proving lineage plus a check keeping both columns present or absent together; both relations are restrictive so accepted history cannot be stranded. The restrictive `AssistantRevision.providerModelId` reference is the provider-model deletion guard that replaced the retired run-profile guard, and admin deletion eligibility counts owned Assistant definitions (users) and Assistant publications (groups). Assistants are archived, never hard-deleted.

The Knowledge aggregate starts at `KnowledgeBase`: owner, optimistic version, soft archive, monotonic content revision, and a composite-proved active `KnowledgeIndexGeneration`. Each immutable generation pins one embedding deployment's normalized vector-space configuration/fingerprint, supported dimension, chunking profile, and indexed content revision; only committed 1024/1536 cosine HNSW profiles are accepted. `KnowledgeDocument` is stable identity with a composite-proved current pointer, while append-only `KnowledgeDocumentVersion` rows keep private object integrity metadata, generation-pinned ingest state/progress, and inclusive/exclusive visibility bounds. A process-local coordinator only wakes database-owned work; each atomic claim applies the shared durable owner rotation using the composite-proved immutable queue copy of `KnowledgeBase.ownerUserId`, with initial document work and reindex work participating in the same owner cycle. Within the selected owner, an eligible document remains ahead of reindex work and each class retains its oldest-eligible ordering. Bounded skip-locked leases, heartbeats, stage fencing, and stable failures drive `queued -> parsing -> chunking -> embedding -> ready | failed`; the short cursor lock and its indexed owner-head seeks never cover parsing or embedding. Knowledge parsing uses only the first code-owned parser for a routed format and never degrades through the attachment fallback chain. Docling OCR supplies printed Russian/English Unicode text and page anchors through the same normalized block contract as native text; pictures or diagrams without printed text create no semantic content, and an empty normalized result fails rather than activating an empty version. Embedding always uses document mode in fixed 64-input batches; the unique generation/version/batch `UsageEvent` tuple commits both owner-attributed usage evidence and crash-resume idempotency.

`KnowledgePolicy` is the one-row `installation` retrieval policy with optimistic version, updater audit reference, candidate/result limits, and fused-score threshold protected by database checks. It grants no resource access and owns no relation to private bases. Migration, seed, and bootstrap insert only a missing default row; every retrieval invocation snapshots the resolved values into its immutable `KnowledgeRun` receipt.

Revision R resolves versions with the inclusive lower and exclusive upper bounds `visibleFromRevision <= R` and (`visibleUntilRevision` is absent or `R < visibleUntilRevision`); moving the current pointer cannot rewrite that historical set. Activation closes the prior exclusive bound, advances the base content revision, and moves the current pointer in one serializable transaction. Reindex creates a shadow generation plus durable `KnowledgeGenerationDocument` work for the exact visible version set. When the target keeps the source generation's chunking profile, a fenced reindex may re-embed the exact ordered active-source chunks if a legacy normalized object no longer decodes; it never reparses the private original, and absence of both usable normalized text and compatible source chunks settles as `reindex_source_unavailable`. Reconciliation locks the base, catches the shadow up after concurrent content changes, and flips only when every fenced version is complete and source generation/content/version fences still match; it can never activate a mixed set. `KnowledgeChunk` proves that its version and generation belong to the same base, stores bounded text plus an untyped pgvector value, and has a generated multilingual `simple` FTS projection with GIN plus dimension-guarded HNSW indexes. `KnowledgeBasePublication` grants live group or installation access without snapshotting content; archived bases are unavailable to non-owners. Base names, document metadata, content, vectors, normalized objects, and retrieval evidence remain private. Users owning bases and groups holding base publications block admin hard delete.

`AssistantRevision.knowledgeBaseIds` is the exact revision-governed Knowledge
allowlist. Nullable `Folder.defaultKnowledgePlan` and
`Chat.defaultKnowledgePlan` own the ordinary project/chat preferences; run
preparation resolves explicit request > chat > folder > Off, while Assistant
runs reject overrides and use only the revision list. All plans are ordered,
duplicate-free, and limited to three bases; an absent historical field decodes
as Off. For each admitted nonempty plan, `KnowledgeRunBinding` stores one row per
ordinal atomically with `ModelRun`: base id and accepted content revision, exact
immutable index generation and indexed revision, vector-space fingerprint and
dimension, plus the current embedding connection/model/credential-version
execution snapshot and credential source. Composite and restrictive foreign
keys keep accepted base, generation, model, credential, and version evidence
from being deleted independently; deleting the owning run cascades only its
bindings. Live ownership/publication, active-base/generation state, embedding
entitlement, vector configuration, and credential/check evidence are reloaded
inside acceptance, so any drift rolls the complete run graph back with a
privacy-neutral failure. Later revocation, archive, or reindex never mutates an
accepted row. A zero-document base is valid and binds the same way; document
availability belongs to later retrieval evidence rather than admission.

`KnowledgeRun` is the one-to-one retrieval receipt owned by an actual
`ModelRunToolCall`; a composite foreign key proves that both rows belong to the
same run, and deleting the run cascades the receipt with its call. It stores the
bounded query, explicit outcome, RRF/candidate/result limits and threshold,
per-base revision/candidate evidence, exact scored private result mapping and
included-text truncation, canonical provider text, embedding usage, duration,
stable failure code, and nullable reranker binding/pre/post-order fields
reserved for a later reranking stage. The owning settled tool call stores the
same versioned canonical execution projection with compact-marker rehydration,
so inspection and recovery never reconstruct a receipt from provider text or
repeat a completed retrieval. `complete`, `zero_above_threshold`,
`base_empty`, `base_indexing`, and `embedding_model_unavailable` are closed
persisted outcomes. Query-embedding `UsageEvent` rows remain distinct from
answer-model usage.

Folder names are unique among siblings for each user. Top-level folders use the partial unique index `Folder_userId_top_level_name_key`; child folders use `Folder_userId_parentId_name_key`.

`Group.archivedAt` is the soft-disable flag for ordinary group entitlement administration. Archived groups remain visible to admins for audit/history, but they are excluded from effective entitlement resolution and cannot receive new grants or membership replacement targets. Exactly one non-archived group may have `systemRole = full_access`; database and service guards keep its exact name/lifecycle immutable while membership remains explicit. It cannot be renamed, archived, or deleted, so the ordinary empty-group deletion rule never applies to it. Bootstrap/adoption preserves an ordinary legacy group that already owns the reserved name by moving it to the first available `Full access (custom)` or numbered variant; it never promotes that group to the system role. An active member receives semantic wildcard entitlement to every current/future active provider connection/model and enabled Search option without materializing `AccessGrant` rows, but that wildcard never chooses a provider credential. `AccessGrant` continues to support direct user grants and ordinary group grants for connection-wide, stable model-deployment, and stable Search-option access; its database column remains `searchStrategy` for migration compatibility. Current admin workflows edit ordinary group grants only. PostgreSQL checks require exactly one `userId`/`groupId` principal and exactly one non-empty provider connection/model/Search target. The repeatable seed writes only those stable targets so an existing fixed-id grant cannot retain a stale principal or target.

For MCP, `Full access` uses the materialized group-grant path: bootstrap and the development seed ensure one protected `canUse = true`, empty-personal-slot `McpGrant` for every existing server, and the database insert trigger creates the same grant for every future server. Server deletion still cascades through those rows. This grants server use only; personal slot permission, personal encrypted values, user OAuth identity, and other personal secrets remain direct-user state.

Admin hard-delete workflows are intentionally narrow. Stale users can be deleted only when they are not active, are not the acting admin, and retain no chats, folders, runs, uploads, Assistants, settings, shares, usage events, access grants, or authored session-revocation evidence. Groups can be deleted only with zero members, zero enabled grants, and zero Assistant publications. Invites can be deleted only after they are revoked or expired; accepted invites remain audit history by default.

PromptPreset and RunProfile were removed by the reusable-assistants expand/contract cutover. The `20260806210000_prompt_preset_stock_cleanup` migration is the fail-closed prompt data half: it aborts the deployment without mutation when any row deviates from the exact provisioned `Helpful Assistant` signature or an owner holds more than one preset, and otherwise idempotently clears `UserSettings.defaultPromptPresetId`, `Chat.defaultPromptPresetId`, and `Message.promptPresetId` before deleting the verified stock rows. The following transactional `20260806210500_run_profile_stock_cleanup` preflight takes an exclusive table lock, requires exactly the three untouched fixed RunProfile signatures with no operator attribution, version advance, missing/extra row, or non-stock model target, and installs a statement trigger rejecting INSERT, UPDATE, DELETE, and TRUNCATE. A mismatch leaves the remaining legacy schema and every RunProfile row unchanged; after success, the committed trigger seals the approved rows across an interrupted or retried deployment. `20260806211000_reusable_assistants_v1` then drops the drained columns and tables, automatically removing the table trigger, and creates the Assistant aggregate; `20260806211500_drop_run_profile_stock_cleanup_guard` idempotently removes the now-unreferenced trigger function. The supported single-host topology stops the previous app container before `migrate-bootstrap` runs, which remains the required old-process drain for the cutover. Historical accepted runs keep exact prompt evidence inside `ModelRun.normalizedRequest`; ordinary new runs receive the server-owned standard-chat baseline instead of a database prompt row.

`Chat.defaultProviderModelId` is nullable by design and remains independent after creation. Server-side creation snapshots the user's currently effective personal-or-installation exact deployment; when neither source is safely runnable it stores null and never chooses the first entitled model. Workspace summaries, chat details, branch responses, and chat-update events project an absent default as paired JSON `null` values for `defaultModelId` and `defaultProvider`; the browser decoder temporarily normalizes the earlier paired empty-string representation for deployment compatibility. A half-populated pair remains malformed. Existing-chat activation retains its established visible catalog-fallback behavior for an absent or unavailable saved tuple, but loading alone never rewrites the chat or either model-default owner.

Follow the storage/logging invariants in `agent_docs/CRITICAL_INVARIANTS.md`. Persist message content as the user's actual chat data, plus run metadata needed for operation: provider, model, status, provider response id, normalized token usage, estimated cost compatibility fields, timestamps, error class, final assistant content, and structured artifacts such as citations. Citation URLs are scheme-sanitized at provider parsing, read-back, client normalization, and render time; unsafe URLs are omitted or rendered inert. Full chat details include citation metadata and active-branch token statistics when provider/search artifacts and completed runs expose them, so direct Perplexity answers and historical Perplexity search runs render through the same optional citations block; the workspace list remains lightweight and omits message payloads.

`ModelRun.userId` is denormalized from the owning chat for ownership queries and reconciliation. Active-run concurrency is per chat: the partial unique index `ModelRun_one_active_per_chat_idx` covers `ModelRun.chatId` for `preparing`, `queued`, `streaming`, and `in_progress` statuses. `preparing` is a feature-dark Memory admission state: only it has both normalized request and provider preview null, every other state requires both, and a deferred database guard couples it to exactly one nonterminal Memory retrieval attempt. Phase A commits that private shape and Phase B atomically consumes its READY attempt, creates the immutable Memory binding/items, writes both request artifacts, and transitions to a dispatchable state. Failure, cancel, expiry, boot, and stale recovery instead terminally settle the attempt and freeze the bounded base request before leaving `preparing`. The public accepted-run adapter still rejects projection of this private intermediate state, and execution checks the raw control status before any provider event or I/O. Route handlers keep the fast friendly same-chat pre-check, but insert-time unique conflicts are also returned as `409 active_run_in_progress`. Prisma enums own the closed persisted lifecycle vocabularies: messages use `queued`, `streaming`, `complete`, `cancelled`, or `error`; model runs additionally use `preparing` and `in_progress`; search runs use `complete` or `error`; and attachments use `processing`, `ready`, or `failed`. A new persisted state therefore requires an explicit schema migration and matching behavior tests rather than an unchecked string write.

Schema changes land as append-only Prisma migrations. The one-shot installation tools service uses `prisma migrate deploy`; never use `prisma db push` for persistent data volumes. Existing pre-migration volumes that already match the baseline are marked once with `prisma migrate resolve --applied 20260610180000_baseline` before normal deploys continue. Each migration owns its compatibility preflight, transactional conversion, and rollback guidance beside the SQL or in its focused contract script; `TESTING.md` routes the disposable-database commands. This document records only the resulting schema and runtime invariants.

`prisma/bootstrap.ts` is the installation fresh-install/adoption entry point. Under one serializable transaction and advisory lock it first distinguishes an empty schema from an already-adopted initial-admin password identity by normalized email. Every other nonempty target fails before catalog or user mutation. Fresh bootstrap requires an explicit valid email and password, defaults the display name when omitted, and generates a user UUID when none is supplied. It creates only the active admin, verified password identity, immutable built-in `Full access` group with owner membership and current MCP grants, default settings with no default folder, inert default-off `UserMemorySettings`, nullable installation model-policy foundation, code-owned provider/Search scaffolding, and the disabled fake test deployment; it creates no Memory content/work, prompt row, run-profile slot, real provider-model deployment, folder, or demo chat. An explicit user UUID is enforced when supplied. An adopted rerun may repair missing inert Memory settings or model-policy foundation and restore the built-in group/membership/current MCP grants, but never overwrites either settings row, the policy target, or creates newly added answer-model deployments; adding a new template therefore has no migration/backfill effect on an existing installation. It may refresh metadata for already-owned catalog rows while preserving catalog enablement and every operator-owned password/user-profile/role/status/settings/folder/prompt/grant value. The plaintext initial password is unnecessary after first adoption. The default Gemini Quick Setup candidate set includes Gemini 3.6 Flash, 3.5 Flash, 3.5 Flash-Lite, and 3.1 Pro Preview; those deployments are created and granted only when that setup runs against a provider catalog that exposes them, never by an upgrade migration or adopted-bootstrap backfill.

The production one-shot role runs migration deploy, then installation
bootstrap, then the idempotent legacy provider/SMTP/MCP control-plane cutover.
That order preserves bootstrap's fail-closed empty-versus-adopted decision: a
fresh cutover must not create control-plane rows before the initial password
identity exists. On an adopted database bootstrap repairs only code-owned
foundation before the cutover imports any complete legacy environment drafts.

`prisma/seed.ts` is intentionally repeatable only for the development/test volumes. Its first executable guard requires exact internal `AIQSA_TEST_MODE=1` and rejects production `NODE_ENV` before any database query. On fresh and repeated runs it atomically keeps the fixed operator active/admin and restores its verified password identity, plus two fixed active ordinary-user identities used for access testing; matching scrypt hashes are retained, while missing, changed, malformed, or obsolete hashes are replaced. Exact-email/user ownership conflicts and multiple password identities fail closed instead of updating an arbitrary identity. These committed credentials are disposable public fixtures and are never an installation bootstrap path. The production installation bootstrap is covered to create only its requested administrator foundation and never these ids, emails, passwords, groups, or MCP fixtures.

Fake QSA is likewise a disposable development runtime, never an installed provider. Production migration/bootstrap may retain its code-owned connection/model rows solely for referential history, but always disables the connection and model, clears active publication, and excludes the family from Quick setup's configured Connections projection. The development seed explicitly repairs and republishes Fake only inside its guarded disposable environment.

The local seed creates initial settings with no default folder and inert default-off `UserMemorySettings` on fresh volumes, but no Memory content/work, prompt rows, folders, chats, or messages. It repairs `Full access` plus operator owner membership/current MCP grants, while leaving the two ordinary fixture users outside that group. It also repairs a development-only ordinary-user group with Fake QSA access, one shared MCP definition granted through that group, one private MCP definition granted directly to only the MCP Member fixture, and an exact direct personal-slot permission on the shared definition for that member. The Restricted Member has only group `canUse`, no personal-slot authority, and no visibility of the private server. It does not delete an existing folder or chat, overwrite an existing `UserSettings` or `UserMemorySettings`, change the operator display name, or disturb unrelated operator-created records on repeat runs; explicit local identities, role/status foundations, system-group foundation, and fixed seed-owned access fixtures remain repairable.

After that canonical seed succeeds, it checks only the exact ignored checkout-local entrypoint `.aiqsa/local-dev-profile/post-seed.ts`. A missing entrypoint or exact `AIQSA_LOCAL_DEV_PROFILE_DISABLED=1` is a no-op, so ordinary developers and CI retain the canonical empty-workspace contract without setup. A regular file must export `run(context)`; the seed passes its existing Prisma client, repository root, and loader-contract version, awaits completion before disconnecting, and fails the seed when an opted-in profile is invalid or fails. The concrete profile, fixtures, provider inputs, and local state remain ignored private checkout data; the tracked loader neither discovers arbitrary scripts nor supplies provider environment fallback to application runtime.

`Message(chatId, parentMessageId)` references `Message(chatId, id)`, and `Chat(id, activeLeafMessageId)` references the same composite message identity, so neither a parent nor the selected leaf can cross a chat boundary. The active-leaf relation uses PostgreSQL 16 column-scoped `ON DELETE SET NULL (activeLeafMessageId)`: deleting a selected message clears only the pointer, never `Chat.id`. Prisma declares the composite relations, but the committed raw migration is authoritative for that column-scoped delete action because Prisma cannot render it safely. Route-level branch repair remains a readable fallback. `Attachment.messageId` is indexed because message-subtree deletion detaches uploads before the retention command removes old orphaned rows and objects.

Workspace content search uses a parameterized `content::text ILIKE` query over `Message.content`, scoped by chat ownership and `archived = false`, and capped at 50 chat ids. This is a simple linear scan suitable for the current small dataset; add measured full-text or trigram indexing when multi-user data volume demands it.
