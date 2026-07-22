# BACKEND

## Backend Goals

The backend supports a transparent QSA workflow without becoming a generic agent platform.

Current responsibilities:

- email/password plus optional Google/Yandex OAuth auth with verified access requests, direct one-time invite acceptance, admin-managed approval rules/manual actions, password reset, explicit bootstrap-token recovery backed by revocable DB sessions, and user/group entitlements;
- backend-served provider/model/search catalog;
- saved user defaults for provider/model/search/prompt, citation/reasoning visibility, and per-model run-control drafts including search strategy, background, Stream, reasoning effort, temperature, and output-token caps;
- persistent chats, folders, messages, branches, prompt presets, runs, attachments, shares, and usage;
- deterministic fake-provider SSE;
- OpenAI Responses, Anthropic Messages, and OpenRouter adapters;
- OpenRouter-backed Perplexity tool executor;
- PDF/image/text-like document upload foundation;
- anonymous sanitized share snapshots.

## Current API Surface

```text
GET    /api/health/live
GET    /api/health/ready
POST   /api/auth/token
POST   /api/auth/login
GET    /api/auth/oauth/:provider
GET    /api/auth/oauth/:provider/callback
POST   /api/auth/register
POST   /api/auth/invite/accept
POST   /api/auth/verify-email
POST   /api/auth/password-reset/request
POST   /api/auth/password-reset/complete
POST   /api/auth/logout
GET    /api/admin
POST   /api/admin/action
GET    /api/me
GET    /api/me/catalog
PATCH  /api/me/settings

GET    /api/chats
POST   /api/chats
GET    /api/chats/:chatId
PATCH  /api/chats/:chatId
DELETE /api/chats/:chatId

POST   /api/folders
PATCH  /api/folders/:folderId
DELETE /api/folders/:folderId

POST   /api/prompts
PATCH  /api/prompts/:promptId
DELETE /api/prompts/:promptId
POST   /api/prompts/:promptId/default

POST   /api/chats/:chatId/messages
PATCH  /api/messages/:messageId
DELETE /api/messages/:messageId
POST   /api/messages/:messageId/branch-chat
POST   /api/messages/:messageId/regenerate

GET    /api/model-runs/:runId
POST   /api/model-runs/:runId/cancel

POST   /api/uploads
POST   /api/chats/:chatId/share
POST   /api/shares/:shareId/revoke
GET    /api/public-shares/:shareToken
GET    /s/:shareToken
```

There are no standalone current routes for `/api/providers`, `/api/models`, `/api/settings`, or `/api/usage`; catalog and usage surfaces are delivered through the current chat/catalog/run APIs, while current-user default control updates use `/api/me/settings`.

The local-only `/api/test/auth-mails` route is outside the product API list and returns `404` unless deterministic local test auth is allowed. Shared wire contracts and route tests, rather than a duplicated script manifest, own request/response semantics.

The public operational health routes expose only `ok`, `ready`, or `not_ready`, never dependency errors or configuration values. Liveness checks the process. Readiness also rejects insecure non-local/test/recovery configuration and probes Postgres plus the configured private S3 bucket with a bounded storage request.

## Route Behavior

All private routes resolve an active current user through `lib/server/auth/requestAuth.ts`; all browser mutations pass the central same-origin proxy guard. `SECURITY.md` is the sole prose owner of cookie/session lookup, password hashing/dummy verification, rate limiting, proxy trust, Origin rules, recovery exposure, and other auth threat controls. This section records observable API state transitions.

- `POST /api/auth/login` accepts normalized email/password credentials and returns one generic unauthorized outcome for invalid, unverified, or inactive identities. Password verification stays outside the transaction, then session settlement locks the password identity and rechecks the exact hash, verification state, and active user status before creating the revocable DB-backed session; password reset uses the same identity lock, so an obsolete hash cannot create a post-reset session.
- `GET /api/auth/oauth/:provider` exists for `google` and `yandex` only when that provider has a paired client id/secret. It derives the exact callback from the trusted application base URL, signs a ten-minute provider/state/nonce/PKCE/internal-next transaction into an HttpOnly cookie, and redirects to the provider. The callback validates and consumes that flow before code exchange. Google uses a signed OIDC ID token with issuer/audience/expiry/nonce and `email_verified=true`; Yandex uses its authenticated profile `id`/`default_email` only when returned `client_id` matches this application.
- A first OAuth identity merges into the existing `User` with the same normalized email, so password, Google, and Yandex entry points retain one owner for chats, groups, grants, prompts, settings, uploads, and runs. The stable `(provider, providerAccountId)` identity owns later sign-ins even if the provider email changes. New OAuth users require the same exact email/domain access rule and are provisioned through the existing active-user path; an existing pending user remains pending when no current rule applies. Disabled/denied users and conflicting provider-subject/email bindings receive no session. OAuth does not consume an invite by email match: the existing token-bearing invite route remains its own activation proof, after which OAuth can merge into that activated user.
- Successful OAuth callbacks create the ordinary revocable DB session and redirect only to the signed sanitized internal path. Provider access/refresh/ID tokens, authorization codes, PKCE verifiers, raw provider errors, and profile bodies are never persisted; callback outcomes expose only stable privacy-safe login codes.
- `POST /api/auth/register` is the normal access-request path, not public signup. It accepts email/display-name, never a password, and mutates only for an eligible exact email/domain (the repository retains legacy invite-token compatibility for verification links created before direct invite onboarding). It creates/reuses an unverified password identity plus one current hashed verification token; reissue replaces the previous unconsumed link, and successful mail delivery does not clear the client/email admission buckets. The route returns a generic request result; required verification-mail failure is reported truthfully.
- `POST /api/auth/invite/accept` takes the one-time invite token, display name, and new password; it never accepts an email from the browser. After token/email-scoped locks, one transaction consumes the valid open invite token, creates or completes only the matching unverified password identity, marks the email verified, activates and provisions the user with the invite defaults, invalidates sibling email-verification links, and creates the first revocable session. The response sets that session cookie so the recipient enters the safe requested workspace path without a second email or sign-in. Invalid/expired/revoked/accepted/concurrently consumed invites and already verified identities return the same stable invalid-invite outcome without partial settlement.
- `POST /api/auth/verify-email` requires the one-time token plus a newly chosen valid password. Client-wide and token-key admission runs before scrypt. The repository locks the identity and owning user, consumes the selected token and all sibling verification tokens, establishes the password hash, verifies the email, and settles the current rule/invite in one transaction. A matching rule/invite activates and provisions the user; otherwise the verified user remains pending for admin review.
- Password-reset request is generic. Eligible and ineligible plausible emails share a small SMTP-independent response floor; an eligible request persists its one-time token before starting bounded SMTP delivery, but the HTTP response does not await the SMTP promise. Completion applies client-wide and token-key admission before scrypt, locks and revalidates the selected active verified password identity, then compare-and-set consumes the selected token, consumes all sibling reset tokens, changes the password, and revokes every user session in one repository transaction. Any failure rolls back the entire transition. `POST /api/auth/logout` revokes the current session before clearing the cookie.
- Registration-verification, password-reset, and requested admin-invitation email delivery use a bounded SMTP transport: connection and individual command phases share one absolute send deadline, failures destroy the current plain/TLS socket, and success closes through bounded QUIT. `ENV_VARIABLES.md` owns the exact configurable deadline defaults.
- `POST /api/auth/token` is a hidden, explicitly env-gated bootstrap recovery route. Disabled recovery behaves as not found; enabled success maps only to the active seeded operator and creates the same DB-backed session type.
- `GET /api/admin` requires an active admin and returns the bare shared `lib/contracts/admin.ts` dashboard: users, groups/grants, grantable catalog, rules, invites, deletion eligibility, and provider-reported usage attribution. Non-admin users receive `403`; repository records require deletion metadata even though the compatibility wire keeps it optional for older client fixtures.
- `POST /api/admin/action` requires an active admin and owns approvals/rejection/disable, scoped/global session revocation, rules/invites, group membership/grants, guarded stale deletion, and group lifecycle. Its valid request and public response envelopes compile against `lib/contracts/admin.ts`, while the handler still validates every untrusted field before use. Invite creation may request SMTP delivery and returns `emailDelivery` as `sent`, `not_requested`, `unavailable`, or `failed`; because SMTP happens after the invite transaction, unavailable/failed delivery remains a successful invite creation and still returns the only recoverable plaintext URL for manual copy. The handler reuses activation provisioning, never deletes owned data during disable/reject, and rejects self-disable, final-active-admin removal, and self/active/owned-data/member/grant/open-or-accepted deletion hazards with structured codes.
- `adminHandlers.ts` depends on the stable, type-only `adminRepositoryContract.ts`; the thin `adminRepository.ts` Prisma facade composes user/session mutations from `adminUserSessionCommands.ts`, group/grant mutations from `adminGroupGrantCommands.ts`, and invite/rule mutations from `adminInviteRuleCommands.ts`. Pure admin input normalization, wire serialization, deletion eligibility/counting, and usage attribution are owned by `adminRepositoryInputs.ts`, `adminRepositorySerializers.ts` plus `adminSerializationPrimitives.ts`, `adminDeletionMetadata.ts`, and `adminUsageAggregation.ts`, with direct unit coverage for those mappings and guard results.
- The facade delegates its global admin operational read model to `adminDashboardQueries.ts`, which composes the grantable catalog from `adminCatalogQueries.ts` and usage aggregates from `adminUsageQueries.ts`. Eleven bounded database reads start concurrently; the two added usage reads preserve distinct model-run counts after provider/model attribution is split. User identity/session/settings/membership and catalog relations use least-data selects, so credential and token hashes are not loaded by the dashboard query. Archived memberships remain visible and receive current-membership operational usage attribution, while archived groups remain excluded from effective entitlements.
- Admin command settlement boundaries are deliberate. Verification, approval, rejection, disable, and guarded stale-user deletion serialize their status/ownership decisions on the same user-row lock; a committed terminal admin decision therefore cannot be overwritten by stale activation work, and concurrent foreign-key ownership creation settles before deletion eligibility is counted. Approval plus provisioning, access-rule default replacement, invite/default-group/hashed-token creation, guarded hard deletes, active-membership replacement, and disable/reject plus target-session revocation use interactive transactions. Disabling an active administrator locks and rechecks the active-admin rows so concurrent requests cannot remove every administrator. Admin invite creation accepts only the same plausible normalized email shape as password login/reset. Exact group-grant delete/recreate remains a sequential non-transactional operation; changing that boundary requires separate behavior work. Approval selects only user id/status and identity verification timestamps, never password hashes. Invite plaintext remains handler-owned: the invite command receives and persists only its `tokenHash`, while the handler may place the fresh URL in the explicitly requested recipient email before returning the same one-time creation response.
- `GET /api/me/catalog` returns current-user entitled providers/models/search strategies/prompt presets plus saved default provider/model/search/prompt, visibility toggles, and per-model run-control drafts. Search options are concrete strategies only: `search-disabled`, `openai-native-web-search`, and `perplexity-tool-search` where supported. Catalog and settings routes share `prismaCatalogData.ts` for exposure/loading and `currentUserCatalog.ts` for entitlement/default selection, so their eligibility rules cannot drift.
- `PATCH /api/me/settings` updates current-user defaults after validating selected provider/model/search/prompt and parameter drafts against that same backend-filtered catalog. Saved search preferences must be concrete strategies that the selected model catalog includes. Sanitized per-model control values remain patches until the repository transaction locks the current user's latest settings row; against that row it revalidates the resulting provider/model/search tuple, merges independent model keys and draft fields, applies scalar fields, and synchronizes prompt-default flags together. Concurrent accepted patches therefore cannot replace unrelated model drafts or leave a search choice attached to a concurrently superseded model.
- `GET /api/chats` returns current-user folders and exact lightweight chat summaries; summary rows include `messageCount` and `pinned` but omit `messages` and `usageStats`, and the repository selects no message/run graph. With `q=<query>`, the route also returns up to 50 current-user, non-archived chat ids whose `Message.content` JSON text matches the query.
- `POST /api/chats` creates blank persisted chats with `folderId = null` unless a folder id is explicitly supplied and returns the same exact summary projection. Creation reads and revalidates the current user's prompt default inside its transaction under the shared prompt-default lock, so it cannot persist a concurrently deleted preset. The shell's visible New Chat actions are lazy and normally call this route only when the first message is sent.
- `GET /api/chats/:chatId` reconciles stale active runs for that current-user chat, then returns the full chat with message DAG, latest assistant run ids, and safe thread artifact summaries for active-chat rendering.
- `PATCH /api/chats/:chatId` updates current-user title/default/folder/favorite fields and active branch leaf, then returns the exact summary projection without loading thread/run detail. Active-leaf changes serialize on the chat row and return `409 active_run_in_progress` while that chat owns an active run; title/folder/favorite metadata remains independently mutable.
- `DELETE /api/chats/:chatId` archives a current-user chat after locking the chat and rechecking that it has no active run; otherwise it returns the same stable active-run conflict.
- Archived chats are non-operational: detail/list/search hide them, and send, regeneration, message edit, chat PATCH, and share creation paths treat them as not found. Unarchive is not currently exposed.
- Folder routes create, rename, move, and delete current-user folders/projects. Folders can have a parent folder and project memory; names are unique within the same parent, with top-level names unique per user. Folder moves check parent ownership and cycle prevention inside the same serializable transaction as the update. Deleting a folder leaves chats with no folder and child folders top-level through `onDelete: SetNull`.
- Prompt routes create/update/delete current-user prompt presets and set the user's default prompt preset. The current user default cannot be deleted; deleting another preset clears matching current-user settings, chat defaults, and nullable message provenance in the same transaction. A namespaced per-user PostgreSQL advisory protocol gives delete/default/settings writes the exclusive side and new-chat/branch-chat validation the shared side; shared readers remain concurrent, and send/run execution never acquires this lock. `PromptPreset.isDefault` is kept synchronized with `UserSettings.defaultPromptPresetId`, including prompt defaults saved through `/api/me/settings`.
- `POST /api/chats/:chatId/messages` is the send entry point. The browser carries the exact nullable active leaf it used; after route-owned auth, orphan reconciliation, chat lookup, and the active-run gate, the shared server-only `runPreparation.ts` boundary rechecks that leaf while assembling trusted branch context, validates entitlements/content/capabilities/prompt/parameters/search/attachments, applies the context budget, and builds the request preview. One repository transaction locks the chat and rechecks ownership, non-archived state, and the same expected leaf before creating the user turn, assistant placeholder, guarded model run, attachment links, active leaf, first-message title/defaults, and accepted current-user model/search/control defaults through the shared locked settings mutation. Ordinary prompt choice remains next-run state and never changes `UserSettings.defaultPromptPresetId`; only explicit `Make default`/settings writes own that user default. A changed leaf returns `409 active_leaf_changed`; missing settings, a no-longer-owned prompt, settings failure, or an insert-time active-run conflict rolls back the whole graph. Only after commit does `runExecution.ts` start provider/tool execution and SSE. Both run messages store the accepted nullable prompt-preset provenance. Attachment-only content is valid, and its attachments remain on the latest provider user turn.
- `PATCH /api/messages/:messageId` edits a current-user user or assistant message by creating a same-role branch fork and moving the chat active leaf to the edited replacement. Edit, delete, and branch-chat transactions first lock only the owned non-archived source `Chat` row, then re-read their message graph and active-run state under the common `Chat -> active ModelRun -> Messages/Attachments` lock order shared with run creation. Edits therefore reject with `409 active_run_in_progress` when a same-chat run wins without serializing work in other chats.
- `DELETE /api/messages/:messageId` deletes a current-user message subtree and moves the chat active leaf to a valid ancestor when needed. Subtree deletion uses the locked current leaf rather than a pre-lock snapshot, rejects with `409 active_run_in_progress` while the chat/subtree has active run state, and deletes only terminal run rows.
- `POST /api/messages/:messageId/branch-chat` clones the selected message's ancestor path into a new current-user chat, copies input/output/reasoning token metadata plus nullable prompt provenance, and revalidates the derived prompt default under the shared prompt-default lock. Every referenced source attachment is validated against its exact owner/chat/message, cloned to a new row/id tied to the cloned message, and rewritten in message content while retaining the same private `storageKey`; no object bytes are duplicated, and either live row protects the object from retention. The cloned selected message becomes the new active leaf, and the route returns only the new chat summary; the ordinary authenticated detail route hydrates the cloned thread. Branch cloning takes the same source-chat lock and rejects with `409 active_run_in_progress` while the source chat/path has active run state.
- `POST /api/messages/:messageId/regenerate` creates a sibling assistant branch. Its route-owned source lookup and active-run gate feed the same `runPreparation.ts` pipeline as send, using stored user content and the selected branch context instead of request-supplied replacements. Regeneration locks and rechecks the non-archived chat, then commits the sibling assistant with accepted prompt provenance, guarded run, active leaf, and accepted model/search/control defaults in one transaction before entering the same `runExecution.ts` search/tool and streaming path without title generation.
- Foreground send/regenerate streams emit a transient `chat_update` after persistence and before `done`; it carries the changed chat summary plus canonical user/assistant message records so the browser can patch the active thread without re-fetching chat detail.
- `GET /api/model-runs/:runId` delegates provider refresh and stale reconciliation to `runRecovery.ts` unless the injected `runExecution.ts` controller registry reports a live foreground owner, then exposes request preview, event log, final response preview, status, normalized token usage, provider response id, search runs, tool artifacts, and errors. Refresh requires provider-specific explicit completion proof. Terminal provider failure or outstanding tool calls settle once through a run-row-locked CAS that replaces usage attribution, appends provider evidence plus one terminal error, marks the error as definitively recovered, and cannot later be overwritten by completion; eligible transient errors may still recover to complete. Concurrent reads coalesce only by run id, while different runs/chats remain independent. `lib/contracts/runs.ts` owns the client-visible response projection, stable errors, and fail-closed browser decoder while inspection-only extra fields remain additive. Refresh/reconcile contention falls back to the current persisted run instead of failing the read.
- `POST /api/model-runs/:runId/cancel` first compare-and-sets an owned active run to durable `cancelled`. Only that winning request aborts the in-process controller and attempts bounded provider-native cancellation; provider-response-id publication is status-gated, so an id discovered after durable cancellation is not persisted and the discovering foreground/recovery path issues the one missing native cancel. An allowlisted provider/status success or generic failure preview is added through a separate `status = cancelled` guarded write, never the raw cancel response. If completion or another terminal writer already won, the route returns `409 model_run_not_cancelable` with the actual current status and touches neither controller nor provider.
- `POST /api/uploads` validates auth, ownership context, file size/type/extension, magic bytes or text-like content, and image/PDF processing limits before storing an object or creating an attachment row. Every upload receives a UUID-bearing object key, so identical content cannot reuse a key that retention may already own. If attachment-row creation fails after the put, the handler stages a purpose-built deletion job, attempts immediate object cleanup, and removes the job only after that cleanup is acknowledged; storage/ack failure leaves retryable durable work. Stored MIME/content type is derived from the validated extension/kind, not the client-declared `File.type`. Supported text-like documents are `.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.html`, and `.htm`; they are decoded locally, JSON is pretty-printed when valid, HTML has scripts/styles stripped, and persisted `extractedText` is capped at 20,000 characters with truncation metadata. PDFs over 500 pages or over the 20-second extraction timeout fail with `pdf_too_complex`; default PDF extraction runs in a terminable worker and the test injection path observes an abort signal.
- Share routes create, fetch, render, and revoke sanitized immutable snapshots.

## Retention Maintenance

AIQSA ships a manual/cron-friendly retention command:

```bash
docker compose run --rm app npm run prune -- --dry-run
docker compose run --rm app npm run prune -- --execute
# persistent installation, after the tools image is built and migration/bootstrap succeeded
docker compose run --rm migrate-bootstrap npm run prune -- --dry-run
```

The installation tools image is the cron/manual owner when the standalone runtime is deployed; override its normal bootstrap command with the same `npm run prune -- ...` invocation. The command defaults to dry-run, 30-day terminal `ModelRunEvent` and auth-state retention windows, a 7-day orphaned-attachment window, a 15-minute deletion-job lease, and a 1,000-row batch. `--event-days`, `--auth-days`, `--orphan-attachment-days`, `--deletion-job-lease-minutes`, and `--batch-size` tune those values.

Dry-run performs only bounded reads. Execute mode deletes old events only for terminal runs; deletes only expired/revoked sessions and consumed/expired auth-flow tokens older than the auth cutoff; and stages orphan cleanup transactionally. For each storage key, staging locks and rechecks attachment rows, creates or reuses one `AttachmentDeletionJob` before removing the final row, and never queues an object still referenced by another row. Run creation links uploaded attachments with the inverse compare-and-set (`userId`, `chatId = null`, `messageId = null`) and rolls its whole graph back with `409 attachment_not_available` if prune or another run won. Workers claim jobs in bounded `FOR UPDATE SKIP LOCKED` leases; object deletion is idempotent, a crash after delete is retried after lease expiry, and failures release durable work with only a stable error code/job id in the summary—never a storage key or provider error string.

## Core Tables

The executable model inventory is `prisma/schema.prisma`. Its current categories are identity/session/approval, users/groups/settings/grants, folders/chats/message DAGs/prompts, provider/search catalog, runs/events/usage, attachments plus their purpose-built deletion outbox, and immutable share snapshots. Living prose records only cross-table constraints that affect behavior.

`User.role`/`User.status`, identity/session/token/rule/invite relations, and exact normalized email/domain matching implement the auth state machine. The schema owns field/enumeration shape; `SECURITY.md` owns the threat and session contract.

`UserSettings` stores the user's default provider/model/search/prompt/folder, citation and reasoning block visibility, and a JSON map of per-provider/model control drafts such as search strategy, background mode, Stream mode, reasoning effort, temperature, and max output tokens. Settings draft sanitization accepts a per-model `searchStrategyId` only when that selected model's backend-filtered catalog includes the strategy. The database default and seed default for `defaultSearchStrategyId` are `openai-native-web-search`; migration `20260613120000_remove_search_auto_and_legacy` converts old Auto/legacy settings to concrete strategy ids and removes old catalog/grant rows.

Folder names are unique among siblings for each user. Top-level folders use the partial unique index `Folder_userId_top_level_name_key`; child folders use `Folder_userId_parentId_name_key`.

`Group.archivedAt` is the soft-disable flag for group entitlement administration. Archived groups remain visible to admins for audit/history, but they are excluded from effective entitlement resolution and cannot receive new grants or membership replacement targets. `AccessGrant` supports direct user grants and group grants for provider-wide, provider/model-specific, and search-strategy access; current admin workflows edit group grants only. PostgreSQL checks require exactly one `userId`/`groupId` principal and exactly one non-empty target shape: provider-wide, provider plus model, or search strategy. The repeatable seed assigns every nullable shape field explicitly so an existing fixed-id grant cannot retain a stale principal or target.

Admin hard-delete workflows are intentionally narrow. Stale users can be deleted only when they are not active, are not the acting admin, and own no chats, folders, runs, uploads, prompts, settings, shares, usage events, or access grants. Groups can be deleted only with zero members and zero enabled grants. Invites can be deleted only after they are revoked or expired; accepted invites remain audit history by default.

`PromptPreset.isDefault` stores the same current-user prompt default represented by `UserSettings.defaultPromptPresetId`. Prompt default write paths clear the user's other prompt flags before setting the selected prompt, and the partial unique index `PromptPreset_one_default_per_user_idx` enforces at most one default prompt flag per user.

Follow the storage/logging invariants in `agent_docs/CRITICAL_INVARIANTS.md`. Persist message content as the user's actual chat data, plus run metadata needed for operation: provider, model, status, provider response id, normalized token usage, estimated cost compatibility fields, timestamps, error class, final assistant content, and structured artifacts such as citations. Citation URLs are scheme-sanitized at provider parsing, read-back, client normalization, and render time; unsafe URLs are omitted or rendered inert. Full chat details include citation metadata and active-branch token statistics when provider/search artifacts and completed runs expose them, so direct Perplexity answers and historical Perplexity search runs render through the same optional citations block; the workspace list remains lightweight and omits message payloads.

`ModelRun.userId` is denormalized from the owning chat for ownership queries and reconciliation. Active-run concurrency is per chat: the partial unique index `ModelRun_one_active_per_chat_idx` covers `ModelRun.chatId` for `queued`, `streaming`, and `in_progress` statuses. Route handlers keep the fast friendly same-chat pre-check, but insert-time unique conflicts are also returned as `409 active_run_in_progress`. Prisma enums own the closed persisted lifecycle vocabularies: messages use `queued`, `streaming`, `complete`, `cancelled`, or `error`; model runs additionally use `in_progress`; search runs use `complete` or `error`; and the current upload path persists `ready` attachments. A new persisted state therefore requires an explicit schema migration and matching behavior tests rather than an unchecked string write.

Schema changes must land as Prisma migrations. The one-shot installation tools service uses `prisma migrate deploy`; do not use `prisma db push` for persistent data volumes. Existing pre-migration volumes that already match the baseline should be marked once with `prisma migrate resolve --applied 20260610180000_baseline` before normal deploys continue. Migration `20260712210000_schema_integrity_hardening` is fail-closed and explicitly transactional: read-only preflights reject unknown cross-chat pointers, grant shapes, or lifecycle values without deleting/coercing them; only the known legacy message state `in_progress` maps to `streaming`. Its migration-local README owns full inspection and data-preserving schema rollback instructions. Migration `20260714090000_verified_email_password_establishment` atomically consumes outstanding legacy verification tokens and clears password hashes only from unverified password identities; affected users must request a fresh link and choose a password after email proof. Migration `20260718193000_attachment_retention_outbox` preserves legacy duplicate storage keys while adding the purpose-built unique-key deletion-job table plus attachment/auth retention indexes; `db:retention:migration:contract` proves that compatibility and the new constraints on a disposable database.

`prisma/bootstrap.ts` is the installation fresh-install/adoption entry point. Under one serializable transaction and advisory lock it first distinguishes an empty schema from an already-adopted initial-admin password identity by normalized email. Every other nonempty target fails before catalog or user mutation. Fresh bootstrap requires an explicit valid email and password, defaults the display name when omitted, and generates a user UUID when none is supplied. It creates only the active admin, verified password identity, private operator group/grants, default prompt/settings with no default folder, and code-owned model/search catalog; it creates no folder or demo chat. An explicit user UUID is enforced when supplied. An adopted rerun may refresh code-owned catalog metadata but preserves catalog enablement and every operator-owned password/profile/role/status/settings/folder/prompt/grant value. The plaintext initial password is unnecessary after first adoption.

`prisma/seed.ts` is intentionally repeatable only for the development/test volumes. Its first executable guard requires exact internal `AIQSA_TEST_MODE=1` and rejects production `NODE_ENV` before any database query. On fresh and repeated runs it atomically keeps the fixed user active/admin and restores the verified password identity `operator@aiqsa.local` / `AIQSA-local-2026!`; a matching scrypt hash is retained, while a missing, changed, malformed, or obsolete hash is replaced. Exact-email/user ownership conflicts and multiple password identities fail closed instead of updating an arbitrary identity. This committed credential is a disposable public fixture and is never an installation bootstrap path.

The local seed creates initial settings with no default folder and the seeded prompt default on fresh volumes, plus fixed-id demo content useful locally without synthesizing `Inbox`. It does not delete an existing folder, overwrite an existing `UserSettings`, move an existing seeded chat between folders, replace a user-selected non-seed prompt default, change the operator display name, or disturb unrelated operator-created records on repeat runs; the explicit local email, password identity, admin/status foundation, and fixed seed-owned demo fixtures remain repairable. When the seeded prompt is still the user's default, the seed may refresh that default flag and clear conflicting prompt defaults so the partial unique index stays valid; if the user has chosen another default prompt, the seed preserves that choice.

`Message(chatId, parentMessageId)` references `Message(chatId, id)`, and `Chat(id, activeLeafMessageId)` references the same composite message identity, so neither a parent nor the selected leaf can cross a chat boundary. The active-leaf relation uses PostgreSQL 16 column-scoped `ON DELETE SET NULL (activeLeafMessageId)`: deleting a selected message clears only the pointer, never `Chat.id`. Prisma declares the composite relations, but the committed raw migration is authoritative for that column-scoped delete action because Prisma cannot render it safely. Route-level branch repair remains a readable fallback. `Attachment.messageId` is indexed because message-subtree deletion detaches uploads before the retention command removes old orphaned rows and objects.

Workspace content search uses a parameterized `content::text ILIKE` query over `Message.content`, scoped by chat ownership and `archived = false`, and capped at 50 chat ids. This is a simple linear scan suitable for the current small dataset; add measured full-text or trigram indexing when multi-user data volume demands it.

## Conversation Context Replay

Persisted `Message` rows are durable chat memory. The backend, not the browser, builds model context for every send:

- `Chat.activeLeafMessageId` and `Message.parentMessageId` define the visible branch.
- A shared recursive PostgreSQL ancestor query starts at the active, expected, or explicit leaf and loads only that same-chat path in chronological order; ownership/non-archived scope stays in SQL, siblings are never materialized, and a visited-id guard terminates malformed cycles safely.
- The new user message is appended as the child of the active leaf and included as the final context message.
- Non-visible sibling branches are excluded.
- The run service applies the ADR 0007/0017 context budget before run creation: ASCII contributes approximately one token per four characters, non-ASCII code points contribute at least one, extended pictographs contribute two, the budget is `contextWindow - maxOutputTokens - 10% contextWindow`, and oldest prior turns are dropped whole when needed.
- The budget includes provider-bound current-message attachment payload estimates, not only attachment references: extracted document/PDF fallback text, native PDF page/byte proxies, and image dimension proxies can make the current request return `400 context_too_large` before provider dispatch.
- Runs that fit the budget keep the prior request shape. Trimmed runs store the trimmed `context.messages`, add `context.summary.truncation`, and emit a persisted `context_truncated` artifact. If prompts plus the current user message exceed budget, the route returns `400 context_too_large` before creating a run or calling a provider.
- Branch checkout persists by updating `Chat.activeLeafMessageId`; message deletion removes the selected subtree and falls back to the deleted root's parent if the active leaf was inside it.
- Provider adapters receive a provider-neutral `context.mode = "branch_path"` payload with ordered user/assistant messages.
- Request previews expose safe context ids, roles, and text snippets.
- If the chat belongs to a folder/project with memory, the run preparation boundary appends `Project memory` to the normalized system prompt for sends and regenerations before provider request preview/building.

OpenAI Responses uses ordered input items, Anthropic Messages and OpenRouter Chat use ordered message arrays, and the fake provider echoes a deterministic context-memory preview for tests.

## Visible Answer Contract

The visible assistant message is for the user-facing answer only. The run preparation boundary adds a backend invariant to provider requests:

- do not print debug sections such as `Question`, `Search`, `Provider Parameters`, `Request Preview`, `Artifacts`, `Usage`, or `Errors` in chat;
- keep provider/search/request/usage/error details out of visible chat answers; the UI shows Events/Details summaries and the model-run API keeps debug previews inspectable;
- include citations naturally in the answer only when useful.

OpenAI Responses and OpenRouter answer adapters sanitize the common old debug-template shape before emitting/saving visible answer text. Raw provider text remains available in model-run response previews when it differs from the visible answer.

## Chat Titles

The first send in a blank/new chat derives a short deterministic title from local message text inside the run-creation transaction. The update is compare-and-set against `New Chat`/`Untitled QSA`, so a concurrent or existing explicit title wins. Attachment-only or blank text keeps `New Chat`. Title derivation never calls a provider and creates no usage, event, or accounting record.

## Provider Adapters

Provider-specific code stays behind internal adapters. OpenAI and OpenRouter are decomposed by wire responsibility behind unchanged provider facades without changing the common adapter boundary.

Provider HTTP transports keep `AIQSA_PROVIDER_TIMEOUT_MS` active through bounded success-JSON and non-2xx error-body reads. Those untrusted bodies share the `AIQSA_PROVIDER_RESPONSE_MAX_BYTES` cap (16 MiB by default), are cancelled on timeout/overflow, and feed only sanitized error previews. A successful SSE response releases the ordinary request deadline after headers and remains governed by caller cancellation plus the per-read stream idle timeout, so a healthy long answer is not cut off by the short JSON deadline.

`lib/server/providers/types.ts` is the code owner of the adapter boundary: `NormalizedRunRequest` is the normalized/persistable request shape and `ProviderRunRequest` adds resolved private attachments plus tool/streaming execution controls. Do not copy those interfaces into living prose; update the exported types and their tests together. Each adapter emits normalized events and returns a `ProviderRunResult` with safe provider-specific request/response previews, usage, and artifacts.

OpenAI-style parameter metadata uses temperature `1` as the neutral default; `0` remains an explicit deterministic/focused choice. Accepted max-output aliases are canonicalized once before budgeting and provider serialization. For `perplexity-tool-search`, preparation snapshots the enabled strategy, configured search model and model limits, plus the server-owned routing/privacy policy; a request may override only canonical bounded `params.search.maxOutputTokens` and `temperature`. Both answer adapters force non-streaming tool rounds with `parallel_tool_calls: false`, allow at most three actual tool executions, reapply the context budget to attachments plus the accumulated tool transcript after each appended result, emit cumulative truncation evidence when that drops more history, then force a no-tool synthesis round.

The model run input is created only after backend validation of provider, model, search strategy, provider parameters, and attachment content blocks against the current user's catalog. Preparation starts from the enabled `ProviderModel.defaultParams` stored on the server and recursively overlays only validated per-run controls; for OpenRouter the complete catalog `provider` routing/fallback/privacy object is server-authoritative and cannot be weakened by a direct request. Immediately before provider/tool dispatch, execution performs bounded fresh reads of the user's provider/model/search entitlements, the enabled model row, and the selected search-strategy row. Revocation or catalog disable in the preparation-to-dispatch interval therefore fails the durable run without a provider call, while unrelated chats remain independently executable. PDF validation accepts either extracted-PDF support or `nativePdfInput`; original PDF bytes are loaded from private storage only for selected models with `nativePdfInput`. Run-route parameter validation rejects out-of-range, unsupported, ambiguous alias, or unknown posted params with `400 { "error": "invalid_run_params" }`; settings drafts are the only path that clamps operator-entered control values before saving.

## OpenAI Responses API

OpenAI uses Responses API as the first-class OpenAI path.

`openaiResponses.ts` is the stable adapter facade. `openaiResponsesRequest.ts` owns actual request and always-redacted preview construction; `openaiResponsesResponse.ts` owns status, completed-response, usage/tool/artifact, and SSE normalization; `openaiResponsesTransport.ts` owns authenticated fetch endpoints, timeout composition, JSON parsing, and sanitized HTTP errors; `openaiResponsesLifecycle.ts` owns provider-specific create/retrieve/poll/retry/refresh/cancel sequencing. The registry and run engine do not depend on those internal modules.

Current defaults:

- model id from the backend catalog/env default; the direct catalog keeps GPT-5.5 as the default and also exposes entitled GPT-5.6 Sol, Terra, and Luna entries;
- `background=true`;
- `stream=false` unless the per-model Stream control is enabled for the run;
- `store=true`;
- `reasoning.effort=medium`; GPT-5.6 also defaults `reasoning.mode=standard` and advertises its additional `max` effort and `pro` mode only through those models' catalog controls;
- manual context replay, not provider-side chat memory.

Current adapter behavior:

- fetch-based Responses API requests;
- provider-side prompt caching hints always include a hashed per-chat `prompt_cache_key`; pre-5.6 models retain `prompt_cache_retention: "24h"`, while GPT-5.6 uses `prompt_cache_options: { ttl: "30m" }` and never sends both contracts;
- selected `openai-native-web-search` adds the hosted `web_search` tool, `tool_choice=auto`, and `include: ["web_search_call.action.sources"]`; the model decides whether to search without an extra backend intent instruction;
- selected `perplexity-tool-search` sends the provider-neutral `search_via_perplexity` function tool through Responses, forces foreground non-streaming requests for the custom-tool loop, appends `function_call_output` items plus any reasoning/function-call items needed for continuation, persists `SearchRun` rows only when the model actually calls the tool, and gives the model a final no-tool synthesis call after the allowed tool executions;
- `nativePdfInput` models receive current PDF attachments as Responses `input_file` blocks with request-local base64 `file_data`; other PDF-capable models receive extracted text blocks;
- polling retrieve until terminal response when `stream=false`; one absolute `AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS` deadline covers create, waits, retrieves, and retry work rather than approximating time with a poll count;
- Responses SSE parsing when `stream=true`, including output-text deltas, web-search lifecycle artifacts, provider response id capture, final usage, and final artifact/citation extraction; only `response.completed` carrying `response.status = completed` proves success, while EOF without that proof is `openai_stream_truncated`; normalized citation artifacts omit URLs that fail the shared external-scheme sanitizer;
- retryable retrieve failures such as `503` are transient artifacts;
- `GET /api/model-runs/:runId` can recover a previously errored background run if stored provider response id later retrieves as completed;
- cancellation uses `POST /v1/responses/:responseId/cancel`.

When UI parameters select `reasoning.effort=none`, AIQSA sends that explicit OpenAI reasoning object. GPT-5.6 `reasoning.mode` is independent and remains serialized when present even with effort `none`. Run validation rejects `max` or `pro` for a model whose catalog controls do not advertise that value. Treat OpenAI `status: incomplete` as a provider failure.

The current direct OpenAI default model does not expose or accept `reasoning.effort=minimal` in AIQSA because the 2026-06-06 low-token smoke rejected that value. Saved legacy direct-OpenAI control drafts containing `minimal` are migrated to `low`.

## Anthropic Messages API

Anthropic uses Messages API with streaming.

Current defaults:

- model id from the backend catalog/env default;
- `maxTokens=128000`;
- `outputConfig.effort=high`;
- thinking disabled unless selected.

Current adapter behavior:

- fetch-based Messages API streaming requests;
- system and developer prompt drafts are combined into top-level `system`;
- `nativePdfInput` models receive current PDF attachments as Messages `document` blocks with base64 PDF sources; other PDF-capable models receive extracted text blocks;
- thinking controls map to Anthropic thinking/output config fields where supported;
- provider SSE events map text deltas to tokens, thinking deltas to reasoning artifacts, and cumulative usage to run usage; `message_stop` is required before the adapter returns success, and prior EOF is `anthropic_stream_truncated`.

## OpenRouter

OpenRouter is implemented as an OpenAI-compatible Chat Completions provider plus the Perplexity search executor used by provider-neutral tool calls.

`openRouterChat.ts` is the stable facade used by the registry, run engine, tests, and smoke script. `openRouterChatRequest.ts` owns answer/search bodies and always-redacted previews; `openRouterChatResponse.ts` owns JSON/SSE errors, text, usage, reasoning, citations, tool calls, and normalized results; `openRouterChatTransport.ts` owns the authenticated fetch endpoint, timeout composition, object parsing, and sanitized HTTP errors; `openRouterPerplexitySearch.ts` owns real/fake search-adapter result assembly. Provider-neutral tool definition/execution remains in `lib/server/tools/`, outside these wire modules.

Current behavior:

- fetch-based `/api/v1/chat/completions` requests;
- provider-side prompt-cache routing is always hinted with a hashed per-chat `session_id`; Anthropic-routed OpenRouter requests also include top-level `cache_control: { "type": "ephemeral" }`;
- the seeded/default Anthropic route is strict through both `order: ["anthropic"]` and `only: ["Anthropic"]` rather than relying on fallback routing;
- Answer-stage runs default to `stream: true`, consume OpenRouter SSE chunks as live token events, collect final usage from the terminal usage chunk, and preserve reasoning/citation artifacts when chunks expose them; the `[DONE]` sentinel is required for success, and prior EOF is `openrouter_stream_truncated` even when text, finish reason, or usage was already received;
- the same per-model Stream control can send `stream: false`; the adapter then uses the non-streaming Chat Completions response path while preserving final answer, usage, reasoning, and citation artifacts;
- redacted provider request preview with route-provider controls;
- `nativePdfInput` models receive current PDF attachments as Chat Completions `file` content plus the native OpenRouter `file-parser` PDF engine plugin; other PDF-capable models receive extracted text blocks;
- selected `perplexity-tool-search` sends OpenRouter answer models the provider-neutral `search_via_perplexity` tool, uses non-streaming Chat Completions tool rounds, appends tool results back into the provider transcript, persists `SearchRun` rows only when the model actually calls the tool, and rejects both HTTP-200 error envelopes and malformed terminal JSON (`{}`, missing first message, unusable content) instead of completing a blank answer; valid text/content arrays and answer-round tool-call-only messages remain supported;
- the Perplexity search executor stays non-streaming;
- Search runs are stored in `SearchRun`;
- Search artifacts are emitted as normal model-run artifact events;
- Perplexity route defaults to `data_collection: "deny"`, `order: ["perplexity"]`, `sort: "throughput"`, and `require_parameters: false`.

## SSE Requirements

`lib/domain/modelRunEvents.ts` is the executable owner of the normalized SSE event union and encoder. `runExecution.ts` owns foreground stream/provider/tool behavior, `runFinalization.ts` owns durable event/completion primitives, `runRecovery.ts` owns refresh/orphan settlement, and route handlers own the pre-execution mutation order. Together these boundaries must:

- set `text/event-stream` headers;
- persist the user message before opening the stream;
- create an assistant placeholder before first token;
- create a model run before provider execution;
- generate provider request preview for inspection;
- persist streamed event summaries without raw user content by default;
- batch token persistence: live SSE keeps per-token deltas, while assistant-message partial text and stored token `ModelRunEvent` rows flush as aggregated chunks;
- require provider-specific terminal proof before durable completion. A truncated provider stream flushes accepted partial text, then marks the assistant/run `error` without writing `done`; provider-reported usage already observed before truncation may still be stored as incomplete-run operational usage, but is never guessed;
- send transient UI sync events such as `chat_update` without persisting them into `ModelRunEvent`;
- update assistant content incrementally or at finalization;
- mark error state on failure;
- persist terminal provider-refresh artifacts followed by `usage` and `done` inside the same transaction as the writer whose status-gated `completeRun` call wins. Foreground SSE mirrors those already-durable terminal events transiently, so a later event append cannot turn a completed run into a contradictory error;
- coordinate boot orphan reconciliation once per server process and mark only active rows created before that process's boot boundary as `run_orphaned_on_boot`; retry a failed sweep, but never let a later repository instance sweep a newly committed live run;
- use the shared 10-minute active-run freshness threshold for recent-run gating and stale reconciliation; reconcile stale rows before creating send/regeneration runs so orphan rows do not collide with the database active-run uniqueness guard;
- fail stale non-refreshable active runs as `run_orphaned` through route-triggered reconciliation instead of leaving assistant messages `streaming` forever;
- stop persisting provider stream events promptly after explicit cancellation;
- close with `done`.

## Cost And Usage

Token/cost math belongs in `lib/domain/usage.ts` with unit tests.

Completed runs persist provider-reported `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningTokens`, and `totalTokens`, while preserving the older coarse fields. Normalized `reasoningTokens` are treated as a subset of `outputTokens`, matching OpenAI/OpenRouter usage-detail semantics. `totalTokens` prefers provider-reported totals and falls back to `inputTokens + outputTokens` for providers and old rows that omit totals. `cachedInputTokens` is provider-reported only; do not infer cache hits from repeated text. Anthropic input normalization sums uncached, cache-creation, and cache-read fields, while thinking usage comes from current output-token details.

Tool-search `ModelRun` fields and completed lifetime `Chat.total*` counters keep the end-to-end sum across answer-model rounds plus Perplexity executions. `UsageEvent` stores one grouped attribution per actual provider/model instead of pricing or reporting the entire run as the answer model. If a later provider/tool round fails or is cancelled, only usage already reported by a completed round or usage event is persisted; AIQSA does not estimate unreported failed-request usage. A later successful recovery replaces incomplete attribution rows with the final completed breakdown.

`Chat.totalInputTokens`, `Chat.totalOutputTokens`, and `Chat.totalReasoningTokens` are lifetime completed-run counters for operational accounting. They intentionally count completed sibling/regenerated runs and are not the user-facing active-branch usage number. The shell's branch-aware Usage popover uses `summarizeChatUsageStats` over the active visible branch.

Estimated cost is still computed and stored for compatibility from the current `ProviderModel.inputTokenPriceMicros` and `outputTokenPriceMicros`; reasoning tokens use the output-token price fallback until the schema grows separate reasoning pricing, and are not added on top of the output-token total. The user-facing shell does not render dollar costs or `est. cost n/a`; provider cost accounting is tracked separately in backlog task 127. Do not trust placeholder prices for billing. Treat model pricing as operator-maintained estimate data and verify before using it for real billing.

## Security

`CRITICAL_INVARIANTS.md` and `SECURITY.md` own the security contract. Backend-specific observable ownership, entitlement, upload, share, and run-validation behavior remains documented in the relevant route/persistence sections above; do not maintain a second generic checklist here.
