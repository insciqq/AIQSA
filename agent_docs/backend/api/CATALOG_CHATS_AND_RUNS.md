# BACKEND API — CATALOG, CHATS, AND RUNS

Owner: Server API contract maintainers
Scope: Current-user catalog/settings projection and observable workspace, Assistant, message, branch, run, tool, inspection, and cancellation transitions.
Read when: Changing current-user catalogs/settings, chats, Assistants, send/edit/branch/regenerate, tool execution/recovery, inspection, settlement, or cancellation routes.
Code owners: Catalog/settings handlers, `lib/server/chats/`, `lib/server/assistants/`, and `lib/server/runs/`.
Not owned here: Provider wire mapping, auth onboarding, administrator control plane, or upload/share routes.

## Current-User Catalog And Settings

- The catalog returns the client-safe entitled answer and Search projection
  produced by provider admission, together with saved defaults and presentation
  preferences. Technical-only deployments remain a server-side Search
  dependency and never enter the answer projection; [provider admission](../providers/ADMISSION_AND_BINDINGS.md)
  owns their exact grant/default/admission exclusions.
- An unavailable saved model remains persisted but projects as no default; the server never leaks its hidden identity or silently selects the first visible model.
- Catalog and settings reads preserve the preferred-versus-effective Search
  distinction owned by [Search plans](../../run_pipeline/SEARCH_PLANS.md).
  Settings writes never replace the durable preference with the current
  model-compatible execution subset.
- Settings updates validate providers, models, prompts, Search, and per-model control drafts against the same filtered catalog. The transaction locks the latest settings row and merges independent model keys, so concurrent accepted patches cannot overwrite unrelated drafts. Presentation toggles never enter normalized provider requests.

## Chats, Messages, And Runs

### Workspace and Assistants

- Chat list/create/update/branch mutations return lightweight summaries with `messageCount` and `pinned`, not messages or usage. Detail reads own the message DAG, active leaf, safe artifacts, and latest assistant run IDs. Archived chats are hidden and non-operational; unarchive is not exposed.
- Folder operations are current-user scoped. Moves validate ownership and cycles in the same serializable transaction; deleting a folder promotes child folders and unsets chat folders through database relations.
- `/api/me/assistants` is the concrete Assistant-specific family. Reads project runner-safe summaries and authorized detail: instructions stay inspectable for anyone entitled to run the Assistant, while hidden dependency identities are censored (a model outside the runner's catalog projects as null, MCP ids narrow to the runner's grants) and availability carries only coarse privacy-neutral reasons. Invisible and nonexistent ids share one `assistant_not_available` response. Writes are owner-only with optimistic-version CAS: revise appends an immutable revision and moves the current pointer, archive/restore toggles soft state, duplicate creates a private copy from the caller's authorized revision, and drafts are strictly bounded and validated against the owner's current catalog. Publications pin exact revisions per active group (publisher needs active membership) or installation-wide (active admin); publish-update moves them explicitly, revoke is owner-or-admin, and pins are per-user preference rows granting no access. Saving never advances a publication.
- Assistant runs resolve server-side at admission: the request carries only the Assistant identity and user content, override fields are rejected, the currently authorized revision (owner current, or the highest active publication pinned revision) is materialized into model, prompts, controls, Search intent, and the exact MCP allowlist, and the run-creation transaction rechecks access and archive state before atomically persisting `ModelRun.assistantId`/`assistantRevisionId`. Access, archive, and revocation races return a stable privacy-safe conflict; a concurrent revision advance is not a conflict. Assistant runs skip accepted-defaults persistence so saved manual preferences never change.
- Ordinary no-Assistant admission consumes the server-owned prompt material
  resolved by the [core pipeline](../../run_pipeline/CORE_PIPELINE.md), rejects
  browser replacement, and stores the accepted normalized projection with the
  run graph.

### Send, branch, edit, and regenerate

- Send and regenerate share one server-only preparation boundary for ownership, branch context, entitlement, content/capability, prompt, controls, Search, attachments, MCP, context budget, and redacted preview. The resulting plain-data snapshot is isolated from adapter services and is not rebuilt after validation.
- Run creation locks and rechecks the chat, archive state, expected active leaf, active-run gate, settings, prompt, Search/provider configuration, credentials, and MCP generations before atomically creating messages, attachment links, run bindings, active leaf, and accepted defaults. Stale leaf or active-run races return stable conflicts without partial graph creation. External execution starts only after commit.
- Exactly one active run is allowed per chat; different chats remain independent. Edit, subtree delete, branch-chat, send, and regenerate use the same chat-first lock order and reject same-chat active-run conflicts.
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
- Foreground send/regenerate emits transient `chat_update` only after persistence and before `done`, allowing the browser to reconcile summary and canonical messages without another detail fetch.
