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

`ops/backup/create.sh` is the bundled Postgres/MinIO consistency boundary. It
records, stops, and verifies `app` plus `memory-worker`, then atomically releases
claimed jobs to due `RETRYABLE_FAILED` and running deletions to due `RETRY_WAIT`
with `memory_backup_fenced`, clearing their leases. Only then does it copy
Postgres and the private bucket; cleanup restarts exactly the prior writers.
Before stopping a writer it requires the exact current migrated schema. Format
2 is the sole accepted bundle format and records that schema identity plus
sorted distinct non-secret suppression key IDs, never key material. Unknown,
older, or incomplete format/schema combinations fail before target mutation.

Restore accepts only an acknowledged empty `aiqsa-restore-*` project using the
internal, no-port `ops/backup/docker-compose.restore.yml`; only Postgres and
MinIO may run. It preflights manifest IDs, restores transactionally, verifies
authoritative IDs, repeats key preflight, restores objects, and writes a
checksummed `PENDING` review manifest without starting an app. `review.sh`
requires an explicit no-journal attestation or a separately applied external
journal's SHA-256 identity, then runs a provider-credential-free deletion-only
coordinator. Unresolved/account deletion, live leases/executions, broken
barrier-obligation ownership, missing keys, object failure, or changed Compose
identity blocks the checksummed promotion receipt. Neither helper cuts over or
promotes production.

## Core Tables

The executable model inventory is `prisma/schema.prisma`. Its current categories are identity/session/approval, users/groups/settings/grants, folders/chats/message DAGs, Assistant definitions/revisions/publications/pins, provider/search catalog, runs/lifecycle checkpoints/usage, MCP definitions/revisions/grants/user state/operational checkpoints/tool calls, attachments plus their durable processing queue and purpose-built deletion outbox, per-pipeline document-processing fairness cursors, Native Memory settings/authority/derivative/operational records, and immutable share snapshots. Living prose records only cross-table constraints that affect behavior.

`MemoryEgressAdminPolicy` is the `ADMIN` singleton; `PER_USER` remains.

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

The Memory coordinator fair-claims work through a short cursor transaction.
Jobs require an active owner; deletions survive disablement. Random leases fence
heartbeat/retry/apply by owner/state/token/expiry; consent waiting has no lease
or fallback. Apply and success share one transaction. Deletion retries become
`BLOCKED_REQUIRES_ADMIN`, never abandoned. Registered deletion, indexing,
learning, verification, embedding, and rebuild kinds are allowlisted. Missing
residuals refuse success; reconciliation may reopen it. Workers
preflight key history.

Global reusable deletion owns one `ALL_REUSABLE` barrier and one `FORGET_PURGE`.
Admission disables gates and fences counters/index/work. Versioned contributors
atomically purge/audit reusable owners and private feedback/receipts. Raw
messages and accepted run items remain with live references detached; failed
applies roll back and the cutoff rejects old-source replay.

Permanent retained-chat deletion uses typed
`SOURCE_PURGE/CHAT@memory-chat-delete-v1`, bound to a consumed authorization,
revision/leaf, and origin-memory choice. Admission excludes the chat, fences
work, and revokes shares. Retry-safe cleanup removes exclusive objects and
source data, retracts unsupported facts, and optionally applies Forget.
Other-chat evidence stays frozen but shows `Source deleted` without a link;
database guards prevent resurrection. Provider/backup erasure is not promised.

`MemoryCandidate` quarantines direct-USER evidence from a succeeded extraction.
Its decision immutably binds operation, hashes, succeeded consolidator, and any
required verifier authority; database checks enforce shape, tenant, and role.
Apply atomically writes fact/version/evidence/event/search/current-pointer state
and closes both rows. Source loss stales decisions; Forget scrubs them and source
purge removes invalid rows.

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
derived model-compatible subset back into that column. Current runtime and wire
contracts read and write the complete plan only.

`ModelPolicy` is the singleton installation-owned optimistic-versioned model
recommendation. Its nullable restrictive foreign key stores one exact
`ProviderModel`; the baseline, bootstrap, and development seed create a null
foundation without copying or overwriting any existing operator choice.
`UserSettings.defaultProviderModelId` is the independent nullable personal
override: null means dynamic installation inheritance, while non-null preserves
source precedence even if that deployment later becomes unavailable. Neither
policy grants access or credentials. Individual model deletion is blocked by an
installation policy reference. A confirmed non-template connection graph
deletion may clear a child policy in the same serializable transaction,
incrementing its version; disablement or readiness loss never retargets it.

`SystemModelPolicy` is the separate singleton installation-owned
versioned system utility role. Its restrictive foreign key
stores an exact answer-selectable `ProviderModel`; the baseline, bootstrap, and
canonical seed start null. Its
bounded nullable `reasoningEffort` is atomic with the target, null without one,
and means provider default when unset; a value must be advertised by the
selected revision. The row's
`updatedByUserId` is audit metadata only. Resolution uses the selected
model's explicit installation default credential plus the exact current
availability check, regardless of ordinary unassigned-user policy, and does not
consult direct-user or group assignments. It does not require or grant model
entitlement. A null target returns `system_model_absent`; a disabled/deleted
target, invalid configuration, unsupported retained reasoning effort, or
missing/unusable default credential or exact check returns
`system_model_unavailable`. Resolution never chooses another
model, administrator, or credential tier. Deactivating, demoting, or deleting
the saving administrator may change or null the audit reference but cannot
change role availability. Individual model deletion is blocked by the
restrictive role reference; confirmed non-template connection graph deletion
may clear a child role and advance its version inside the same guarded
transaction.

`SearchOption` is the stable user-visible Search source and, except for the connectionless `search-disabled` Off entry, owns display/lifecycle state plus one exact source `ProviderConnection`; user settings, policy, grants, and new run requests retain its logical id. `SearchStrategy` is its physical route, with a typed draft, lifecycle state, and immutable `SearchIntegrationRevision`; hosted and query-only routes never become separate choices. Revisions never authorize a user's credential. Catalog/admission resolve the current user/model/credential/check. The accepted `ModelRun.normalizedRequest` checkpoint snapshots options in plan order with their exact routes and revisions; `ProviderRunBinding` is unique by `(modelRunId, bindingKey)` and carries the `answer` plus each client engine's accepted credential/model snapshot. `SearchRun` records one invocation's revision/identity, status, and normalized citation sources; selection creates no row. The owning `ModelRunToolCall` stores findings, sources, warning or bounded failure, identity, status, and usage once in the version-2 Search checkpoint. Query remains in call arguments; duration, previews, provider-operation traces, and duplicate usage/findings are absent from `SearchRun`. Its compact marker rehydrates provider-facing text for foreground reuse or recovery without replay. Only the canonical version-2 marker/checkpoint shape is accepted; malformed data fails with `tool_call_result_invalid`. Findings have character and 48 KiB UTF-8 bounds; the whole result has the shared 256 KiB ceiling, with overflow settled as attributable Search error evidence. Raw provider bodies, Gemini Suggestions/signatures/steps, and recursive preview fields are not storage authority. The owning tool call, not a parsed provider invocation id, remains the exact parent.

The Assistant aggregate is `AssistantDefinition` (stable identity, owner, optimistic version, current-revision pointer, soft archive), append-only `AssistantRevision` rows (revision number, schema version, name/description/bounded category, exact generated-avatar recipe JSON, restrictive `ProviderModel` foreign key, system/developer prompts, provider-neutral run controls, logical Search plan, logical MCP server ids, up to four starter prompts, author), `AssistantPublication` rows pinning one exact revision per active group or installation-wide (a check ties scope to group presence and a partial unique index allows one installation row per definition), and per-user `AssistantPin` preference rows that grant no access and never enter an accepted run checkpoint. `ModelRun.assistantId`/`assistantRevisionId` carry accepted provenance through a composite foreign key proving lineage plus a check keeping both columns present or absent together; both relations are restrictive so accepted history cannot be stranded. The restrictive `AssistantRevision.providerModelId` reference guards provider-model deletion, and admin deletion eligibility counts owned Assistant definitions (users) and Assistant publications (groups). Assistants are archived, never hard-deleted.

The Knowledge aggregate starts at `KnowledgeBase`: owner, optimistic version, soft archive, monotonic content revision, and a composite-proved active `KnowledgeIndexGeneration`. Each immutable generation pins one embedding deployment's normalized vector-space configuration/fingerprint, supported dimension, chunking profile, and indexed content revision; only committed 1024/1536 cosine HNSW profiles are accepted. `KnowledgeDocument` is stable identity with a composite-proved current pointer, while append-only `KnowledgeDocumentVersion` rows keep private object integrity metadata, generation-pinned ingest state/progress, and inclusive/exclusive visibility bounds. A process-local coordinator only wakes database-owned work; each atomic claim applies the shared durable owner rotation using the composite-proved immutable queue copy of `KnowledgeBase.ownerUserId`, with initial document work and reindex work participating in the same owner cycle. Within the selected owner, an eligible document remains ahead of reindex work and each class retains its oldest-eligible ordering. Bounded skip-locked leases, heartbeats, stage fencing, and stable failures drive `queued -> parsing -> chunking -> embedding -> ready | failed`; the short cursor lock and its indexed owner-head seeks never cover parsing or embedding. Knowledge parsing uses only the first code-owned parser for a routed format and never degrades through the attachment fallback chain. Docling OCR supplies printed Russian/English Unicode text and page anchors through the same normalized block contract as native text; pictures or diagrams without printed text create no semantic content, and an empty normalized result fails rather than activating an empty version. Embedding always uses document mode in fixed 64-input batches; the unique generation/version/batch `UsageEvent` tuple commits both owner-attributed usage evidence and crash-resume idempotency.

`KnowledgePolicy` is the one-row `installation` retrieval policy with optimistic version, updater audit reference, candidate/result limits, and fused-score threshold protected by database checks. It grants no resource access and owns no relation to private bases. Migration, seed, and bootstrap insert only a missing default row; every retrieval invocation snapshots the resolved values into its immutable `KnowledgeRun` receipt.

Revision R resolves versions with the inclusive lower and exclusive upper bounds `visibleFromRevision <= R` and (`visibleUntilRevision` is absent or `R < visibleUntilRevision`); moving the current pointer cannot rewrite that historical set. Activation closes the prior exclusive bound, advances the base content revision, and moves the current pointer in one serializable transaction. Reindex creates a shadow generation plus durable `KnowledgeGenerationDocument` work for the exact visible version set. When the target keeps the source generation's chunking profile, a fenced reindex may re-embed the exact ordered active-source chunks if the stored normalized object is unreadable; it never reparses the private original, and absence of both usable normalized text and compatible source chunks settles as `reindex_source_unavailable`. Reconciliation locks the base, catches the shadow up after concurrent content changes, and flips only when every fenced version is complete and source generation/content/version fences still match; it can never activate a mixed set. `KnowledgeChunk` proves that its version and generation belong to the same base, stores bounded text plus an untyped pgvector value, and has a generated multilingual `simple` FTS projection with GIN plus dimension-guarded HNSW indexes. `KnowledgeBasePublication` grants live group or installation access without snapshotting content; archived bases are unavailable to non-owners. Base names, document metadata, content, vectors, normalized objects, and retrieval evidence remain private. Users owning bases and groups holding base publications block admin hard delete.

`AssistantRevision.knowledgeBaseIds` is the exact revision-governed Knowledge
allowlist. Nullable `Folder.defaultKnowledgePlan` and
`Chat.defaultKnowledgePlan` own the ordinary project/chat preferences; run
preparation resolves explicit request > chat > folder > Off, while Assistant
runs reject overrides and use only the revision list. All plans are ordered,
duplicate-free, limited to three bases, and required in the complete current
shape. For each admitted nonempty plan, `KnowledgeRunBinding` stores one row per
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
availability belongs to the later retrieval outcome rather than admission.

`KnowledgeRun` is the one-to-one private retrieval checkpoint owned by an
actual `ModelRunToolCall`; a composite foreign key proves that both rows belong
to the same run, and deleting the run cascades the checkpoint with its call. It
stores the bounded query, explicit outcome, RRF/candidate/result limits and
threshold, per-base revision/candidate facts, exact scored private result
mapping and included-text truncation, canonical provider text, embedding usage,
duration, stable failure code, and nullable reranker binding/pre/post-order
fields reserved for a later reranking stage. The owning settled tool call stores
the same versioned canonical execution projection with compact-marker
rehydration, so recovery never reconstructs a result from provider text or
repeats a completed retrieval. None of these private fields is a browser
projection. `complete`, `zero_above_threshold`,
`base_empty`, `base_indexing`, and `embedding_model_unavailable` are closed
persisted outcomes. Query-embedding `UsageEvent` rows remain distinct from
answer-model usage.

Folder names are unique among siblings for each user. Top-level folders use the partial unique index `Folder_userId_top_level_name_key`; child folders use `Folder_userId_parentId_name_key`.

`Group.archivedAt` soft-disables an ordinary group: admins retain audit visibility, but the group grants nothing and accepts no new grants or membership replacement. One non-archived group may have `systemRole = full_access`; database/service guards make its name and lifecycle immutable and forbid rename, archive, or deletion while membership stays explicit. Bootstrap renames an ordinary reserved-name collision to the first available `Full access (custom)` variant instead of promoting it. An active member semantically receives every current/future active provider connection/model and enabled Search option without materialized grants or credential selection. `AccessGrant` still supports direct-user and ordinary-group connection/model/Search targets (the schema retains `searchStrategy`); admin workflows edit ordinary-group grants only. Checks require exactly one principal and one nonempty target. The repeatable seed repairs only stable targets, preventing a fixed-id grant from retaining a stale principal or target.

For MCP, `Full access` uses the materialized group-grant path: bootstrap and the development seed ensure one protected `canUse = true`, empty-personal-slot `McpGrant` for every existing server, and the database insert trigger creates the same grant for every future server. Server deletion still cascades through those rows. This grants server use only; personal slot permission, personal encrypted values, user OAuth identity, and other personal secrets remain direct-user state.

Admin hard-delete is narrow. Stale users must be inactive, not the acting admin, and have no unrelated owned chats, folders, runs, uploads, Assistants, settings, shares, usage, grants, or authored revocations; those block before Memory mutation. The mandatory default `UserMemorySettings` row is inert. If Memory alone remains and the deletion composition exposes its exact hook and handler, admission fences gates/counters, cancels undispatched work, creates one typed `ACCOUNT_MEMORY_DELETE`, and returns the blocker while reconciliation runs. Recoverable/unknown provider calls stay attached; settled usage-backed evidence detaches only after its recovery horizon. After an audited reusable/private purge, the global transaction deletes retained usage/execution/job/outbox evidence, then the user. Replay and drift fail closed and retry. Missing/conflicting composition or a disabled admission policy leaves new Memory cleanup a zero-mutation blocker; policy rollback does not prevent the same hook and handler from resuming or finalizing an already-accepted obligation. Groups require zero members, enabled grants, and Assistant publications. Invites require revocation or expiry; accepted invites remain audit history.

Reusable Assistants own saved instruction and model configuration. PromptPreset
and RunProfile do not exist in the current schema. Standard chats receive the
server-owned baseline directly, while accepted runs retain only the bounded
execution state required by their current recovery and output contracts.

`Chat.defaultProviderModelId` is nullable by design and remains independent after creation. Server-side creation snapshots the user's currently effective personal-or-installation exact deployment; when neither source is safely runnable it stores null and never chooses the first entitled model. Workspace summaries, chat details, branch responses, and chat-update events project an absent default as paired JSON `null` values for `defaultModelId` and `defaultProvider`; empty strings and half-populated pairs are malformed. Existing-chat activation retains its established visible catalog-fallback behavior for an absent or unavailable saved tuple, but loading alone never rewrites the chat or either model-default owner.

Follow `agent_docs/CRITICAL_INVARIANTS.md`. Beyond actual message data, persist run fields only for execution, recovery, side-effect safety, security, retention, citation/output reconstruction, or aggregate accounting: accepted bindings, lifecycle state, provider-native background identity, reported usage, required timestamps, stable errors, final content, citations, and generated artifacts. Sanitize citation URLs at parse, read, decode, and render boundaries. Chat details expose only message-bound outputs and currently owned branch context/accounting facts; workspace summaries omit message payloads.

Minimize run data in order: remove inspector UI/projectors; add an explicit allowlisted outcome serializer; classify broad snapshots, previews, event rows, Search/Knowledge/Memory records, and tool-call fields by operational consumer; narrow checkpoints and prove recovery/no-duplicate-side-effects; then stop writes and remove schema through forward migrations. Never move removed payloads into debug logs or start with destructive schema deletion.

`ModelRun.userId` is denormalized for ownership/reconciliation. `ModelRun_one_active_per_chat_idx` permits one `preparing | queued | streaming | in_progress` run per chat. Private Memory admission couples `preparing` to one nonterminal retrieval attempt. Phase A commits the graph; Phase B consumes READY, creates immutable bindings/items, freezes the minimum recovery checkpoint, and enters a dispatchable state. The bounded in-process preparing snapshot retains the actual provider request preview only for the Phase-B consistency fence; request and final-response previews are not database fields. `normalizedRequest` remains null while `preparing` and non-null after dispatch admission. `ModelRunEvent` stores only exact reloadable outputs: link-safe citations, normalized hosted-Search sources, and bounded reasoning text. Lifecycle, token, query/operation, tool, usage, error, and terminal events remain transient. Failure/cancel/expiry/recovery settle the attempt before leaving `preparing`; execution checks status before provider I/O. Insert conflicts return `409 active_run_in_progress`. Persisted lifecycle enums remain closed and require migrations plus behavior tests for additions.

The unpublished development history was replaced by
`20260815000000_baseline`, which remains the first immutable installation
anchor in the ordered migration set. Its frozen SHA-256 is
`71c210d018bf2c56c4003a0a74f5c84dfdea939336c889b04b786444461f5b33`; the
single migration contract verifies that checksum before database mutation and
proves a synthetic next append-only migration in its full two-database mode.
Future schema changes land as append-only Prisma migrations with any required
PostgreSQL-only DDL audited in the same migration. The baseline cannot be
regenerated from `schema.prisma` alone because its custom PostgreSQL DDL is part
of the contract. No upgrade path from older development schemas is supported.
The one-shot installation tools service uses `prisma migrate deploy`; never use
`prisma db push` for persistent data volumes. `TESTING.md` routes the ordinary
and full disposable migration contracts.

`prisma/bootstrap.ts` is the installation fresh-install/adoption entry point. Under one serializable transaction and advisory lock it first distinguishes an empty schema from an already-adopted initial-admin password identity by normalized email. Every other nonempty target fails before catalog or user mutation. Fresh bootstrap requires an explicit valid email and password, defaults the display name when omitted, and generates a user UUID when none is supplied. It creates only the active admin, verified password identity, immutable built-in `Full access` group with owner membership and current MCP grants, default settings with no default folder, fact/history-on and learning-off `UserMemorySettings`, nullable installation model-policy foundation, code-owned provider/Search scaffolding, and the disabled fake test deployment; it creates no Memory content/work, prompt row, run-profile slot, real provider-model deployment, folder, or demo chat. An explicit user UUID is enforced when supplied. An adopted rerun may repair missing default Memory settings or model-policy foundation and restore the built-in group/membership/current MCP grants, but never overwrites either settings row, the policy target, or creates newly added answer-model deployments; adding a new template therefore has no migration/backfill effect on an existing installation. It may refresh metadata for already-owned catalog rows while preserving catalog enablement and every operator-owned password/user-profile/role/status/settings/folder/prompt/grant value. The plaintext initial password is unnecessary after first adoption. The default Gemini Quick Setup candidate set includes Gemini 3.6 Flash, 3.5 Flash, 3.5 Flash-Lite, and 3.1 Pro Preview; those deployments are created and granted only when that setup runs against a provider catalog that exposes them, never by an upgrade migration or adopted-bootstrap backfill.

The production one-shot role runs migration deploy and then installation
bootstrap. Bootstrap owns the fail-closed empty-versus-adopted decision and
repairs only code-owned foundation on an adopted database. Provider and SMTP
configuration is created explicitly through the Control Center; the tools role
does not import application configuration from environment variables.

`prisma/seed.ts` is intentionally repeatable only for the development/test volumes. Its first executable guard requires exact internal `AIQSA_TEST_MODE=1` and rejects production `NODE_ENV` before any database query. On fresh and repeated runs it atomically keeps the fixed operator active/admin and restores its verified password identity, plus two fixed active ordinary-user identities used for access testing; matching scrypt hashes are retained, while missing, changed, malformed, or obsolete hashes are replaced. Exact-email/user ownership conflicts and multiple password identities fail closed instead of updating an arbitrary identity. These committed credentials are disposable public fixtures and are never an installation bootstrap path. The production installation bootstrap is covered to create only its requested administrator foundation and never these ids, emails, passwords, groups, or MCP fixtures.

Fake QSA is likewise a disposable development runtime, never an installed provider. Production migration/bootstrap may retain its code-owned connection/model rows solely for referential history, but always disables the connection and model, clears active publication, and excludes the family from Quick setup's configured Connections projection. The development seed explicitly repairs and republishes Fake only inside its guarded disposable environment.

The local seed creates initial settings with no default folder and fact/history-on, learning-off `UserMemorySettings` on fresh volumes, but no Memory content/work, prompt rows, folders, chats, or messages. It repairs `Full access` plus operator owner membership/current MCP grants, while leaving the two ordinary fixture users outside that group. It also repairs a development-only ordinary-user group with Fake QSA access, one shared MCP definition granted through that group, one private MCP definition granted directly to only the MCP Member fixture, and an exact direct personal-slot permission on the shared definition for that member. The Restricted Member has only group `canUse`, no personal-slot authority, and no visibility of the private server. It does not delete an existing folder or chat, overwrite an existing `UserSettings` or `UserMemorySettings`, change the operator display name, or disturb unrelated operator-created records on repeat runs; explicit local identities, role/status foundations, system-group foundation, and fixed seed-owned access fixtures remain repairable.

After that canonical seed succeeds, it checks only the exact ignored checkout-local entrypoint `.aiqsa/local-dev-profile/post-seed.ts`. A missing entrypoint or exact `AIQSA_LOCAL_DEV_PROFILE_DISABLED=1` is a no-op, so ordinary developers and CI retain the canonical empty-workspace contract without setup. A regular file must export `run(context)`; the seed passes its existing Prisma client, repository root, and loader-contract version, awaits completion before disconnecting, and fails the seed when an opted-in profile is invalid or fails. The concrete profile, fixtures, provider inputs, and local state remain ignored private checkout data; the tracked loader neither discovers arbitrary scripts nor supplies provider environment fallback to application runtime.

`Message(chatId, parentMessageId)` references `Message(chatId, id)`, and `Chat(id, activeLeafMessageId)` references the same composite message identity, so neither a parent nor the selected leaf can cross a chat boundary. The active-leaf relation uses PostgreSQL 16 column-scoped `ON DELETE SET NULL (activeLeafMessageId)`: deleting a selected message clears only the pointer, never `Chat.id`. Prisma declares the composite relations, but the committed raw migration is authoritative for that column-scoped delete action because Prisma cannot render it safely. Route-level branch repair remains a readable fallback. `Attachment.messageId` is indexed because message-subtree deletion detaches uploads before the retention command removes old orphaned rows and objects.

Workspace content search uses a parameterized `content::text ILIKE` query over `Message.content`, scoped by chat ownership and `archived = false`, and capped at 50 chat ids. This is a simple linear scan suitable for the current small dataset; add measured full-text or trigram indexing when multi-user data volume demands it.
