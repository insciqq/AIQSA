# BACKEND API — CATALOG, CHATS, AND RUNS

Owner: Server API contract maintainers
Scope: Current-user catalog/settings projection and observable workspace, Assistant, message, branch, run, tool, inspection, and cancellation transitions.
Read when: Changing current-user catalogs/settings, chats, Assistants, send/edit/branch/regenerate, tool execution/recovery, inspection, settlement, or cancellation routes.
Code owners: Catalog/settings handlers, `lib/server/chats/`, `lib/server/assistants/`, and `lib/server/runs/`.
Not owned here: Provider wire mapping, auth onboarding, administrator control plane, or upload/share routes.

## Current-User Catalog And Settings

- `/api/me/memory/settings` is a separate authenticated private/no-store
  settings boundary. GET projects the three independent default-off gates,
  persisted Memory locale, fail-closed phase capabilities, and bounded
  current-versus-accepted utility destinations/fingerprints. PATCH accepts
  exactly one strict ordinary settings-CAS shape or explicit current-copy
  consent shape. Memory-visible changes require both settings and Memory
  revisions; locale-only changes require only the settings revision. Embedding
  selection and utility consent revalidate exact current authority inside the
  locked mutation, and provider/consent unavailability never disables local
  management capabilities.
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

- Chat list/create/update/branch mutations return lightweight summaries with `messageCount` and `pinned`, not messages or usage. Server-side new-chat creation snapshots the caller's current effective personal-or-installation model default, or null when none is safely runnable; later default changes never retarget that chat. An ordinary detail read returns at most the newest 50 messages of the active branch in forward order, with an opaque older-page cursor plus the exact active-leaf/`updatedAt` snapshot fence. `messageCount` remains the full DAG count; usage and the approximate active-branch input-token context fact cover the full active branch. Authenticated `GET /api/chats/:chatId/messages?before=...` revalidates ownership, cursor boundary, leaf, and snapshot before returning the next forward-ordered page, with typed invalid-cursor and stale-snapshot failures. `GET /api/chats/:chatId/branches` separately returns the full compact parent graph with bounded plaintext previews; it never hydrates full message bodies or run artifacts. Detail/page reads hydrate content, safe artifacts, and latest assistant run IDs only for the selected page. Archived chats are hidden and non-operational; unarchive is not exposed.
- Folder operations are current-user scoped. Moves validate ownership and cycles in the same serializable transaction; deleting a folder promotes child folders and unsets chat folders through database relations.
- `/api/me/assistants` is the concrete Assistant-specific family. Reads project runner-safe summaries and authorized detail: instructions stay inspectable for anyone entitled to run the Assistant, while hidden dependency identities are censored (a model outside the runner's catalog projects as null, MCP ids narrow to the runner's grants, and non-owner Knowledge ids remain hidden) and availability carries only coarse privacy-neutral reasons. Invisible and nonexistent ids share one `assistant_not_available` response. Writes are owner-only with optimistic-version CAS: revise appends an immutable revision and moves the current pointer, archive/restore toggles soft state, and drafts are strictly bounded and validated against the owner's current catalog. Duplicate creates one private exact copy only when the caller independently retains access to every referenced Knowledge Base in the creation transaction; one hidden, archived, or missing base rejects the whole operation with the privacy-neutral Assistant response and creates no definition or revision. Publications pin exact revisions per active group (publisher needs active membership) or installation-wide (active admin); publish-update moves them explicitly, revoke is owner-or-admin, and pins are per-user preference rows granting no access. Saving never advances a publication.
- Assistant runs resolve server-side at admission: the request carries only the Assistant identity and user content, override fields are rejected, the currently authorized revision (owner current, or the highest active publication pinned revision) is materialized into model, prompts, controls, Search intent, the exact MCP allowlist, and the exact Knowledge allowlist, and the run-creation transaction rechecks access and archive state before atomically persisting `ModelRun.assistantId`/`assistantRevisionId`. Access, archive, and revocation races return a stable privacy-safe conflict; a concurrent revision advance is not a conflict. Assistant runs skip accepted-defaults persistence so saved manual preferences never change.
- Ordinary no-Assistant admission consumes the server-owned prompt material
  resolved by the [core pipeline](../../run_pipeline/CORE_PIPELINE.md), rejects
  browser replacement, and stores the accepted normalized projection with the
  run graph.

### Knowledge Bases

- `/api/me/knowledge-bases` is the private current-user management family. Reads return owned bases (including archived ones for restore) plus only live installation/group publications visible through active membership. Admin status adds no private-base visibility; unknown and invisible ids both return `knowledge_base_not_available`. Hidden embedding deployment identities are censored for non-owners unless independently entitled.
- `/api/me/knowledge-bases/:baseId/documents` returns a transactionally consistent, newest-first bounded page (25 by default, maximum 100) with exact total/page metadata and an optional case-insensitive filename-substring query. Owners may match any retained version filename and receive lifecycle history; non-owners may match and receive only the live ready current version. Malformed, duplicate, or over-bound query controls fail closed, polling reuses the active query/page, and no content search or private storage identity is implied.
- Creation accepts one entitled active embedding deployment only when its normalized target dimension has a committed index profile, then atomically creates the base and immutable active generation pin. Owner-only optimistic updates change metadata or archive state. Publication is live rather than revision-pinned: group publication requires the owner's active membership, installation publication additionally requires admin status, and revoke is owner-or-admin. Archiving immediately removes non-owner catalog/read access without deleting versions or accepted evidence.

### Send, branch, edit, and regenerate

- Send and regenerate share one server-only preparation boundary for ownership, branch context, entitlement, content/capability, prompt, controls, Search, attachments, MCP, context budget, and redacted preview. The resulting plain-data snapshot is isolated from adapter services and is not rebuilt after validation.
- Run creation locks and rechecks the chat, archive state, expected active leaf, active-run gate, settings, prompt, Search/provider configuration, credentials, and MCP generations before atomically creating messages, attachment links, run bindings, active leaf, and accepted Search/control preferences. Accepted runs never write the personal or installation model default. Stale leaf or active-run races return stable conflicts without partial graph creation. External execution starts only after commit.
- Exactly one active run is allowed per chat; different chats remain independent. For the supported trusted, operator-managed internal installation, those cross-chat runs intentionally have no per-user, installation-wide, or shared-provider admission quota or queue. This is an accepted capacity policy, not a relaxation of authentication, authorization, tenant isolation, bounded individual requests, cancellation, or the same-chat active-run gate. Operators monitor real contention and revisit admission controls before untrusted/external access, contractual spend or latency guarantees, multi-replica scheduling, or measured provider, CPU, memory, or cost saturation. Edit, subtree delete, branch-chat, send, and regenerate use the same chat-first lock order and reject same-chat active-run conflicts.
- Editing creates a same-role branch fork. Subtree deletion moves the active leaf to a valid ancestor. Branch-chat clones the selected ancestor path and attachment rows while reusing protected private object bytes. Regenerate creates a sibling assistant branch from an assistant or unanswered user source and follows the same preparation/execution path as send.

### Tool execution and recovery

- Search and MCP share a provider-neutral continuation loop. The complete requested batch is persisted before bounded parallel dispatch and provider-order replay. Completed calls may be reused during recovery; a call left running across a crash is outcome-unknown and is never automatically repeated.
- MCP plans snapshot exact revisions, generations, fingerprints, schemas, namespaced tools, and safe account/source labels. Insert-time fencing rejects stale readiness or access atomically rather than silently dropping tools.
- Preferred Search intent and model-compatible effective execution are distinct. Run creation revalidates entitlement, compatibility, integration revisions, provider/model/credential state, and deterministic credential resolution before persisting immutable answer and Search bindings. Each actual engine invocation is a separate execution record.
- Provider continuations retain their accepted native transcript/checkpoint where supported. Private signatures and raw provider payloads never enter previews. Hosted-answer Gemini native grounding switches the run to live-only answer persistence; grounded content and signatures remain transient while neutral provenance/usage placeholders remain durable. Query-only Gemini client Search retains only its normalized findings/citations in the ordinary settled tool result and Search evidence.
- Live events provide immediate tool activity; authenticated chat/run reads project the same bounded, redacted durable tool-call evidence. Cancellation propagates best-effort abort but never claims external rollback.

### Inspection, terminal settlement, and cancellation

- Model-run reads reconcile stale/background state unless a live foreground controller owns the run. They expose only the shared client-safe preview, normalized events, usage, Search/tool evidence, artifacts, and stable errors. Provider refresh requires explicit provider-specific completion proof.
- Terminal completion, recovered failure, and cancellation compete through status-guarded database settlement so only one writer finalizes run/message/usage state. Retriable refresh contention falls back to the current persisted projection rather than failing the read.
- Cancellation first wins durable `cancelled`. Only the winner aborts the process-local controller and attempts bounded provider-native cancellation. A later provider ID is not published after cancellation; the discovering path performs the missing native cancel. If another terminal state won, cancellation returns a stable non-cancelable conflict and changes nothing.
- Foreground send/regenerate emits transient `chat_update` only after persistence and before `done`, allowing the browser to reconcile summary, canonical messages, full-active-branch usage, and the approximate active-branch context fact without another detail fetch.
