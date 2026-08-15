# BACKEND API — CATALOG, CHATS, AND RUNS

Owner: Server API contract maintainers
Scope: Current-user catalog/settings projection and observable workspace, Assistant, message, branch, run, tool, outcome-recovery, and cancellation transitions.
Read when: Changing current-user catalogs/settings, chats, Assistants, send/edit/branch/regenerate, tool execution/recovery, run-outcome reads, settlement, or cancellation routes.
Code owners: Catalog/settings handlers, `lib/server/chats/`, `lib/server/assistants/`, and `lib/server/runs/`.
Not owned here: Provider wire mapping, auth onboarding, administrator control plane, or upload/share routes.

## Current-User Catalog And Settings

- The Composer derives its presentation model from the current-user catalog plus the existing Assistant, Knowledge, and MCP stores. Those owner-specific private/no-store boundaries retain their own authorization and fail-closed decoders; there is no parallel aggregate Composer endpoint or cache authority. Send still revalidates every selected binding against current server state.
- `/api/me/memory/settings` is a separate authenticated private/no-store
  settings boundary. GET projects the three independent gates—fact/history
  reads default on and automatic learning defaults off—plus the selected
  embedding deployment, fail-closed capabilities, and bounded
  current-versus-accepted utility destinations/fingerprints. Memory
  presentation is fixed English and the route has no locale field. PATCH
  accepts exactly one strict ordinary settings-CAS shape or explicit
  current-copy consent shape; every accepted settings mutation requires both
  settings and Memory revisions. Embedding selection and utility consent
  revalidate exact current authority inside the locked mutation, and
  provider/consent unavailability never disables local management
  capabilities. The current deletion-admission policy permits permanent
  chat deletion, but the projection becomes true only after the sole shared
  composition owner proves the exact source-purge and account-cleanup leaves
  reachable. Before composition, after a conflict, or during policy rollback,
  the route and UI remain fail-closed.
- `GET /api/me/memory/health` is a separate authenticated private/no-store,
  no-query owner projection. It returns one bounded actionable state plus
  learning, indexing/FTS-only, rebuild, durable-deletion, Temporary-retention,
  and destination-review status without Memory/query/source text or source
  identifiers. Counts are capped, physical cleanup is distinct from its
  already-committed retrieval fence, and coordinator/provider unavailability is
  feature-local. Owner identity comes only from the session; failures return a
  stable code and logs contain no underlying private detail.
- `/api/me/memory/mutation-authorizations` and `/api/me/memories` are the
  private explicit-Memory management family and accept only exact `GLOBAL_USER`
  statements and identifiers. Save grants bind the exact statement hash; Edit
  and Forget grants bind the owner fact/current version; `DELETE_EXPLICIT`,
  `DELETE_LEARNED`, and `CLEAR_HISTORY_INDEX` grants bind the exact operation
  plus settings and Memory revisions. All bind current confirmation
  copy and one caller nonce and are consumed atomically with the mutation.
  Exact matching receipt/job retries are idempotent, while
  expired, stale, altered, cross-operation, foreign, or natural-language
  targets fail without mutation. List, detail, bounded evidence, create, edit,
  pin, and `POST /api/me/memories/:memoryId/forget` remain available with all
  three Memory gates off. Search accepts private query text only in a strict
  POST body and synchronously uses the active exact/Russian/English/simple
  lexical projection; no provider, worker, or utility consent participates.
- `POST /api/me/memory/history/search` is the distinct owner-private manual
  retained-history boundary, not sidebar chat search. It accepts no URL query
  parameters and requires one strict JSON body with query, page size, optional
  opaque cursor, chat/folder filters, and half-open UTC bounds; responses are
  private/no-store and return at most 20 bounded safe chunk snippets.
  Cursor identity binds the owner, normalized query, filters, page size,
  serving generation, gate, and Memory revision. Exact and
  Russian/English/simple FTS remain available without vectors; a compatible
  optional vector lane can add candidates but cannot bypass the same live
  owner, source, branch/revision/checkpoint, safety, suppression, barrier, and
  gate rejoin. Missing or failed vector query work is an explicit degradation,
  while an unavailable lexical generation returns no result or cursor.
- `POST /api/me/memory/bulk-delete` admits `DELETE_EXPLICIT`,
  `DELETE_LEARNED`, and `CLEAR_HISTORY_INDEX`. Each applies its retrieval fence
  before the `202` response and returns one durable deletion id. Learned
  deletion installs an `AUTOMATIC_FACTS` source-created-at cutoff, forgets the
  admitted automatic set, cancels nonterminal learning work, and retains
  explicit facts, raw chats, and accepted run checkpoints; only genuinely later
  message evidence may be learned again. Clear-history installs its distinct
  source cutoff, invalidates current chunks/search rows, and retains
  chats, facts, and accepted run checkpoints. The route rejects
  `DELETE_ALL_REUSABLE` until its owner ships.
  Authenticated
  `GET /api/me/memory/deletions/:deletionId` returns only the owner's
  receipt-bound admission counters, bounded purge progress, last audit,
  and `PENDING | RUNNING | RETRY_WAIT | BLOCKED_REQUIRES_ADMIN | SUCCEEDED`;
  it never returns forgotten text. `SUCCEEDED` means every current versioned
  purge requirement audited empty, while admission already meant future
  retrieval was fenced.
- `POST /api/me/memory/rebuild` starts exactly one owner-scoped
  `REBUILD_SEARCH_INDEX` or `REEMBED` operation. Re-embed requires the selected
  current compatible embedding deployment. Authenticated private/no-store
  `GET /api/me/memory/rebuild/:jobId` returns bounded progress, and
  `POST /api/me/memory/rebuild/:jobId/cancel` accepts no body. A shadow remains
  non-serving until full lexical/vector catch-up and one fenced pointer flip;
  failure or cancellation never changes the active generation.
- The catalog returns the client-safe entitled answer and Search projection
  produced by provider admission, together with personal/installation default
  source facts and presentation preferences. A non-null personal exact
  deployment has precedence; null dynamically inherits the installation
  policy. The chosen source becomes effective only when that exact deployment
  is in the user's filtered runnable catalog. An unavailable personal choice
  suppresses installation fallback, and either unavailable source projects as
  no default without exposing its hidden identity or selecting the first
  visible model. Technical-only deployments remain a server-side Search
  dependency and never enter the answer projection; [provider admission](../providers/ADMISSION_AND_BINDINGS.md)
  owns their exact grant/default/admission exclusions.
- Catalog and settings reads preserve the preferred-versus-effective Search
  distinction owned by [Search plans](../../run_pipeline/SEARCH_PLANS.md).
  Settings writes never replace the durable preference with the current
  model-compatible execution subset.
- Settings updates validate explicit personal model-default set/clear, Search, and per-model control drafts against the same filtered catalog. Set stores one exact entitled runnable deployment; clear stores null and restores dynamic installation inheritance. Ordinary current-model selection is not a settings mutation. The transaction locks the latest settings row and merges independent model keys, so concurrent accepted patches cannot overwrite unrelated drafts. Presentation toggles never enter normalized provider requests.

## Chats, Messages, And Runs

### Workspace and Assistants

- Authenticated private/no-store `GET /api/chats/compact` is the Reading Room
  navigation boundary. It accepts only optional opaque `cursor` and bounded
  `limit` controls, returns at most 50 owner-retained non-Temporary,
  non-archived chat summaries (`id`, `title`, `folderId`, `updatedAt`,
  `activeRun`) plus owner folder identity/name/parent metadata, and orders by
  `updatedAt DESC, id DESC`. Its cursor binds the owner and boundary. `GET
  /api/chats/search` adds one required 1–120-character `q`; cursor identity also
  binds the normalized query. Search matches only owned chat title or owned
  folder name, never message, prompt, model, Memory, or snippet content.
  Duplicate, unknown, malformed, stale-query, cross-owner, and over-bound
  controls fail with the typed navigation error and return no partial page.
- Blank chat creation accepts optional `memoryMode: "EXCLUDED"` and persists it
  atomically with the retained chat. Any other supplied initial mode is
  rejected; Temporary remains the separately acknowledged first-run admission
  below. This keeps Normal, Memory-off, and Temporary blank draft identities
  separate without adding lifecycle data to the lightweight summary response.
- Chat list/create/update/branch mutations return lightweight summaries with `messageCount` and `pinned`, not messages or usage. Server-side new-chat creation snapshots the caller's current effective personal-or-installation model default, or null when none is safely runnable; later default changes never retarget that chat. An ordinary detail read returns at most the newest 50 messages of the active branch in forward order, with an opaque older-page cursor plus the exact active-leaf/`updatedAt` snapshot fence. `messageCount` remains the full DAG count; usage and the approximate active-branch input-token context fact cover the full active branch. Authenticated `GET /api/chats/:chatId/messages?before=...` revalidates ownership, cursor boundary, leaf, and snapshot before returning the next forward-ordered page, with typed invalid-cursor and stale-snapshot failures. `GET /api/chats/:chatId/branches` separately returns the full compact parent graph with bounded plaintext previews; it never hydrates full message bodies or run artifacts. Detail/page reads hydrate message content, safe citations/generated outputs, and the latest assistant run id only when the client needs lifecycle reconciliation. They do not serialize a generic `evidenceSummary`, tool/file counters, request-derived attachment counts, usage-presence flags, Events, or inspection metadata. Archived chats stay hidden from ordinary chat reads and remain non-operational, but owner-private no-store Archived list, preview, bounded page, and source-resolution reads remain readable to their owner. Archive and explicit Restore use distinct expected-source-revision transitions, change no Memory counter, and never imply deletion or source exclusion; chat `DELETE` remains Archive-only. Owner-private no-store `GET /api/me/chats/:chatId/memory-mode` exposes the exact current archived, source-mode/revision, and Temporary policy/deadline state needed to reconcile lifecycle UI. `NORMAL <-> EXCLUDED` uses a separate PATCH on that current-user Memory route: Exclude fences source eligibility before success, while Resume requires current disclosure, suppression-key preflight, and a controlled active-branch reconciliation that preserves every Forget and account source cutoff. Admitted Temporary chats remain owner-readable only by exact private id while they exist; ordinary workspace/Archived lists, global content search, source resolution, archive/restore, branch-to-retained-chat cloning, sharing, and workspace update projection exclude them.
- Permanent deletion never overloads Archive. Owner-only
  `POST /api/chats/:chatId/delete-permanently/authorization` first mints a
  five-minute single-use authorization bound to the exact source revision,
  active leaf, caller nonce, and `alsoForgetOriginMemories` choice. The matching
  `POST /api/chats/:chatId/delete-permanently` rechecks that fence, rejects
  Temporary or active-run chats, immediately makes the source and shares
  unavailable, and returns `202` with a durable deletion id. Private/no-store
  `GET /api/chats/:chatId/delete-permanently/status?deletionId=...` exposes only
  state, attempts, timestamps, bounded error code, and completion—not chat or
  Memory text. Cleanup retries through `BLOCKED_REQUIRES_ADMIN`; accepted runs
  in other chats retain their immutable source-bound records and show `Source deleted` without a
  stale source link. Provider-side and backup erasure are outside this route.
  While the deletion composition is unavailable, direct authorization
  or admission fails before parsing/mutation and no permanent-delete action is
  projected. Disabling new admission does not hide status or abandon a deletion
  already accepted while the exact cleanup handler was reachable.
- Folder operations are current-user scoped. Moves validate ownership and cycles in the same serializable transaction; deleting a folder promotes child folders and unsets chat folders through database relations.
- `/api/me/assistants` is the concrete Assistant-specific family. Reads project runner-safe summaries and authorized detail: instructions are readable by anyone entitled to run the Assistant, while hidden dependency identities are censored (a model outside the runner's catalog projects as null, MCP ids narrow to the runner's grants, and non-owner Knowledge ids remain hidden) and availability carries only coarse privacy-neutral reasons. Invisible and nonexistent ids share one `assistant_not_available` response. Writes are owner-only with optimistic-version CAS: revise appends an immutable revision and moves the current pointer, archive/restore toggles soft state, and drafts are strictly bounded and validated against the owner's current catalog. Duplicate creates one private exact copy only when the caller independently retains access to every referenced Knowledge Base in the creation transaction; one hidden, archived, or missing base rejects the whole operation with the privacy-neutral Assistant response and creates no definition or revision. Publications pin exact revisions per active group (publisher needs active membership) or installation-wide (active admin); publish-update moves them explicitly, revoke is owner-or-admin, and pins are per-user preference rows granting no access. Saving never advances a publication.
- Assistant runs resolve server-side at admission: the request carries only the Assistant identity and user content, override fields are rejected, the currently authorized revision (owner current, or the highest active publication pinned revision) is materialized into model, prompts, controls, Search intent, the exact MCP allowlist, and the exact Knowledge allowlist, and the run-creation transaction rechecks access and archive state before atomically persisting `ModelRun.assistantId`/`assistantRevisionId`. Access, archive, and revocation races return a stable privacy-safe conflict; a concurrent revision advance is not a conflict. Assistant runs skip accepted-defaults persistence so saved manual preferences never change.
- Ordinary no-Assistant admission consumes the server-owned prompt material
  resolved by the [core pipeline](../../run_pipeline/CORE_PIPELINE.md), rejects
  browser replacement, and stores the accepted normalized projection with the
  run graph.

### Knowledge Bases

- `/api/me/knowledge-bases` is the private current-user management family. Reads return owned bases (including archived ones for restore) plus only live installation/group publications visible through active membership. Admin status adds no private-base visibility; unknown and invisible ids both return `knowledge_base_not_available`. Hidden embedding deployment identities are censored for non-owners unless independently entitled.
- `/api/me/knowledge-bases/:baseId/documents` returns a transactionally consistent, newest-first bounded page (25 by default, maximum 100) with exact total/page metadata and an optional case-insensitive filename-substring query. Owners may match any retained version filename and receive lifecycle history; non-owners may match and receive only the live ready current version. Malformed, duplicate, or over-bound query controls fail closed, polling reuses the active query/page, and no content search or private storage identity is implied.
- Creation accepts one entitled active embedding deployment only when its normalized target dimension has a committed index profile, then atomically creates the base and immutable active generation pin. Owner-only optimistic updates change metadata or archive state. Publication is live rather than revision-pinned: group publication requires the owner's active membership, installation publication additionally requires admin status, and revoke is owner-or-admin. Archiving immediately removes non-owner catalog/read access without deleting versions or accepted immutable bindings.

### Send, branch, edit, and regenerate

- Send and regenerate share one server-only preparation boundary for ownership, branch context, entitlement, content/capability, prompt, controls, Search, attachments, MCP, context budget, and the minimum private recovery snapshot. The resulting plain-data snapshot is isolated from adapter services, never projected directly to the browser, and is not rebuilt after validation.
- A blank-chat first send may additionally carry only the strict pair
  `chatMode: "TEMPORARY"` and
  `temporaryRetentionPolicyVersion: "temporary-24h-v1"`. Preparation rejects
  missing/stale acknowledgement as `memory_temporary_policy_review_required`,
  and rejects regeneration, late conversion, retained-mode conversion, an
  expired aggregate, or a first-party Memory intent with the corresponding
  stable `memory_temporary_*` conflict. Phase A atomically persists the mode,
  policy, 24-hour deadline, one deletion obligation, messages, run, and local
  disabled attempt before external execution. Temporary requests keep their
  own branch context but omit personal Memory and Folder `projectMemory`.
- Run creation locks and rechecks the chat, archive state, expected active leaf, active-run gate, settings, prompt, Search/provider configuration, credentials, and MCP generations before atomically creating messages, attachment links, run bindings, active leaf, and accepted Search/control preferences. Accepted runs never write the personal or installation model default. Stale leaf or active-run races return stable conflicts without partial graph creation. External execution starts only after commit.
- Exactly one active run is allowed per chat; different chats remain independent. For the supported trusted, operator-managed internal installation, those cross-chat runs intentionally have no per-user, installation-wide, or shared-provider admission quota or queue. This is an accepted capacity policy, not a relaxation of authentication, authorization, tenant isolation, bounded individual requests, cancellation, or the same-chat active-run gate. Operators monitor real contention and revisit admission controls before untrusted/external access, contractual spend or latency guarantees, multi-replica scheduling, or measured provider, CPU, memory, or cost saturation. Edit, subtree delete, branch-chat, send, and regenerate use the same chat-first lock order and reject same-chat active-run conflicts.
- Editing creates a same-role branch fork. Subtree deletion moves the active leaf to a valid ancestor. Branch-chat clones the selected ancestor path and attachment rows while reusing protected private object bytes. Regenerate creates a sibling assistant branch from an assistant or unanswered user source and follows the same preparation/execution path as send.

### Tool execution and recovery

- Search and MCP share a provider-neutral continuation loop. The complete requested batch is persisted before bounded parallel dispatch and provider-order replay. Completed calls may be reused during recovery; a call left running across a crash is outcome-unknown and is never automatically repeated.
- MCP plans snapshot exact revisions, generations, fingerprints, schemas, namespaced tools, and safe account/source labels. Insert-time fencing rejects stale readiness or access atomically rather than silently dropping tools.
- Preferred Search intent and model-compatible effective execution are distinct. Run creation revalidates entitlement, compatibility, integration revisions, provider/model/credential state, and deterministic credential resolution before persisting immutable answer and Search bindings. Each actual engine invocation is a separate execution record.
- Provider continuations retain their accepted native transcript/checkpoint where supported. Private signatures and raw provider payloads never enter client responses. Hosted-answer Gemini native grounding switches the run to live-only answer persistence; grounded content and signatures remain transient while neutral provenance/usage placeholders remain durable. Query-only Gemini client Search retains only its normalized findings/citations in the ordinary settled tool result and private Search checkpoint.
- Live events provide immediate factual tool activity and approval state only while actionable. Authenticated chat/run reads do not return a post-hoc tool trace. Cancellation propagates best-effort abort but never claims external rollback.

### Run outcome, terminal settlement, and cancellation

- Model-run reads reconcile stale/background state unless a live foreground controller owns the run. The route constructs an explicit versioned `RunOutcomeResponse` allowlist containing only fields required by the current workflow: run id, lifecycle/terminal status, canonical terminal-message reconciliation inputs, stable actionable error, cancellation/background-recovery facts, and safe citations or generated outputs when the client cannot obtain them from the message projection. Per-answer usage is omitted unless a separately owned user workflow demonstrates that exact need. The response excludes `normalizedRequest`, provider request/response previews, internal ids, accepted-parameter summaries, normalized event histories, Search attempts/queries/operations, Knowledge retrieval internals, Memory records, post-hoc tool arguments/results, and repository-only timestamps. Route handlers must build this DTO field by field or through an explicit serializer; TypeScript `satisfies`, structural typing, object spread, or a client decoder is not a runtime redaction boundary. Old or malformed internal checkpoints fail neutral by omitting optional output facts. Provider refresh requires explicit provider-specific completion proof.
- Terminal completion, recovered failure, and cancellation compete through status-guarded database settlement so only one writer finalizes run/message/usage state. Retriable refresh contention falls back to the current persisted projection rather than failing the read.
- Every Temporary admission/local run activity schedules the same aggregate
  obligation; a terminal run moves its deadline to 24 hours after settlement.
  Once due, new sends fail closed. Deletion recovery terminally settles a
  stuck active run instead of extending retention, and durable failures remain
  retryable as `BLOCKED_REQUIRES_ADMIN`. AIQSA deletes its complete owned
  aggregate, but already-sent provider, Search, MCP, Knowledge, or tool data
  remains subject to that external destination's retention.
- Cancellation first wins durable `cancelled`. Only the winner aborts the process-local controller and attempts bounded provider-native cancellation. A later provider ID is not published after cancellation; the discovering path performs the missing native cancel. If another terminal state won, cancellation returns a stable non-cancelable conflict and changes nothing.
- Foreground send/regenerate emits transient `chat_update` only after persistence and before `done`, allowing the browser to reconcile summary, canonical messages, full-active-branch usage, and the approximate active-branch context fact without another run-inspection fetch.
