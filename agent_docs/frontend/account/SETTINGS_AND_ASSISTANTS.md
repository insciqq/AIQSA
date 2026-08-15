# FRONTEND SETTINGS, ASSISTANTS, AND KNOWLEDGE

Owner: Account and Control Center UI maintainers
Scope: Settings, Memory, MCP tools, Assistant and Knowledge resource management/publication, focus, appearance, and project-setting interaction contracts.
Read when: Changing Settings, Memory, user MCP tools, Assistants or Knowledge surfaces, resource publication, focus, appearance, or project settings.
Code owners: Settings, Memory, Assistant, and Knowledge components, routes, stores, and client-side reconciliation.
Not owned here: Server resource authorization/retrieval, Control Center administration, authentication, public sharing, or visual recipes.

## Settings, Memory, Assistants, And Knowledge

### Settings, Library, Memory, and MCP tools

- Global Settings contains Appearance and `MCP & tools`. It is reached from the
  sidebar account destination or Command palette, remains a bounded dialog on
  roomy viewports, and becomes a safe-area-aware locally scrolling full-screen
  sheet on compact or short viewports. Unsaved MCP values require an explicit
  discard confirmation; an in-flight mutation blocks close or section
  replacement until it settles. Appearance exposes exactly System, Light, and
  Dark and delegates immediate cookie-backed persistence to the browser-local
  theme owner.
- Library is the sole full-screen resource workspace. Its presentation-owned
  tabs are ordered `Assistants`, `Knowledge`, `Files`, and `Memory`; switching a
  tab never creates another resource store or API client. The focused resource
  owner may defer a tab switch or Back to chat while its draft is dirty or a
  mutation is in flight, then commits the same pending navigation after its own
  confirmation. Library has one explicit `Back to chat`, no backdrop dismissal,
  and one local scroll owner. Sidebar and palette may deep-link a tab, but they
  never expose four competing top-level resource workspaces.
- Memory is the fourth Library tab. It keeps the existing settings, health,
  exact-fact manager, manual history search, and operations owners and their
  nested-task focus/dirty contracts. Memory controls, confirmations, dates,
  health, operations, and evidence render in English; the administrator-disabled overview names the reason
  while explicit fact viewing and deletion remain reachable whenever their
  server capability is available. Source text and retrieval accept arbitrary
  normalized Unicode without a language gate.
- Above the Memory controls, one compact pulse explains the current
  owner-scoped state and next action in ordinary language; technical learning,
  indexing, cleanup, destination, and capability evidence stays collapsed in a
  keyboard-native Advanced disclosure. Blocked durable deletion and overdue
  Temporary cleanup remain prominent outside that disclosure and distinguish
  the immediate retrieval fence from physical purge. Health requests are
  keyed to the active account, cancelled and cleared on account/logout change,
  private/no-store, last-good preserving, and independently retryable without
  hiding settings. The three independent gates still submit exact server state
  even when a disclosed capability is unavailable; unavailable capability
  means the preference is stored but cannot start that work. In default
  `ADMIN` egress mode the section shows at most one passive
  administrator-managed destination line and no review action; the destination
  matrix and blocking review state belong to Control Center → Memory. Explicit
  `PER_USER` installations retain their version-bound review surface, while
  fingerprints/policy/time are Advanced evidence. Utility unavailability or
  unaccepted destinations never blocks explicit saved-memory CRUD or Forget.
- The same non-modal English information block explains that explicit and learned memories remain manageable, toggles are non-destructive, Temporary chats do not use Memory, deletion does not rewrite retained chats or accepted historical runs, selected snippets may coexist with administrator-connected Search/Knowledge/MCP/tools at the answer provider, and administrator connection is the trust decision with residual prompt-injection/disclosure risk. It requires no acknowledgment and never becomes a first-enablement dialog.
- Manage Memories is a Memory-tab nested task for explicit and automatically learned `GLOBAL_USER`, `FOLDER`, owned live `ASSISTANT`, and retained `CHAT` facts, not a separate application or Details tab. Its ordinary summary is derived from exact current fact versions and health, never from a generated profile: it shows no provenance, temperature, internal id, or journal vocabulary, while an explicit Advanced view adds source class, use priority, pinned state, and a path to source/history. Summary Edit and Delete always target the exact contributing fact version; one-item Delete uses the common immediate Forget plus bounded Undo. Below the summary, the workspace scroll owner contains the wide list/detail evidence ledger and compact single-pane Back flow. POST search keeps free text out of URLs; cursor/query/list/state-filter state survives detail navigation. Create defaults visibly to global scope and its accessible picker names available folders, owned unarchived Assistants, active retained chats, and archived retained chats without treating labels as authorization. Exact statement, explicit/automatic authority, scope, ACTIVE/CONFLICTED/ORPHANED/EXPIRED/RETRACTED state, deferred-candidate count, time/source/index metadata, bounded evidence, why remembered, append-only history, active feedback, create/edit/pin/Forget, and strict malformed-response failure remain visible without hidden reasoning. Move scope appends a replacement under the selected authorized target instead of rewriting history; an ORPHANED item exposes its unavailable scope and remains repairable by Move or removable by Forget. A stale edit or conflict resolution reloads the current version while preserving a correction draft. One exact-item Forget commits immediately without a pre-confirmation screen and exposes the common bounded Undo action; the item remains absent until the exact revival succeeds.
- Incorrect/not-useful review feedback commits on the deliberate click and exposes a transient Undo action; Undo appends a `RETRACT` record and never rewrites the fact. A conflict presents competing evidence and lets the user choose one claim or submit a correction as a single explicit commit without a follow-up confirmation. `Keep unresolved` performs no write, while Forget uses the common Forget lifecycle and its shared UX rather than a review-specific delete path. All committed/error/Undo states have complete English live-region and accessible-name coverage.
- Manual chat-history search is a second reversible nested task reached from
  Manage Memories, not the explicit-fact query and not sidebar search. Its
  fixed English presentation covers query, chat/folder/date filters, loading,
  cancellation, error, empty, pagination, lexical/vector state, and source
  actions. The private query exists only in the POST body. Its result cache and
  in-flight lineage belong to the exact account id; account transition/logout
  aborts work and discards result/cursor state, while ordinary Back preserves
  the same-owner query. Results form a flat safe source trail rather than a
  card grid. A live source opens the operational chat, but an archived source
  first resolves owner/location, closes Library, and opens the existing
  read-only Archived preview. Entry and return restore deterministic focus,
  and Memory remains the only scroll owner at portrait and short-landscape
  sizes.
- Memory operations is a separate reversible nested task reached directly
  from the Memory overview. Rebuild, re-embed, and explicit reprocessing remain
  distinct actions whose availability is derived from the current history,
  deployment, learning, and utility-egress projection. Confirmation refreshes
  exact Memory/settings CAS authority; delete-all-reusable, delete-learned,
  clear-history, and reprocessing consume operation-bound one-time
  authorization. Rebuild status
  preserves the active-generation/shadow boundary and offers cancellation only
  for a nonterminal shadow job. Delete-learned and clear-history separately
  report the committed retrieval fence and pending physical purge, cannot be
  cancelled after admission, and keep retry, administrator-blocked, and audited
  completion visible. Learned deletion says that explicit memories and raw
  chats remain, old observed sources cannot recreate the admitted set, and
  genuinely new evidence may be learned. Their confirmation shows one concise
  operation sentence and keeps the complete fence/retention/future boundary
  behind a keyboard-operable details disclosure. A browser session retains only
  account-keyed opaque operation ids; errors/progress contain no source text.
- `Delete everything Memory remembers` is the ordinary-language global reset
  inside Memory operations. Its concise default row says that Memory turns off
  and saved, learned, summary, and history-index data are removed; internal
  journal/evidence vocabulary is absent. Confirmation keeps the exact boundary
  behind the same keyboard-operable details disclosure: all three gates turn
  off immediately, pre-reset sources cannot refill Memory, raw chats and frozen
  accepted old answers/runs remain, and provider-held data/operator backups are
  outside this deletion. Pending/running/retry/blocked/audited status is
  account-bound and recoverable by opaque id only. Admission and success clear
  same-account saved-memory and manual-history client projections.
- `Delete all saved memories` refreshes settings/Memory CAS authority at confirmation, mints current-copy `DELETE_EXPLICIT` authorization, and distinguishes the immediate future-retrieval fence from asynchronous plaintext purge. Its confirmation leads with one concise line; a keyboard-operable details disclosure preserves the exact admitted-set and retained raw-chat/immutable-run/provider/backup boundaries. Recoverable status exposes pending/running/retry/blocked/succeeded progress without saved text. A browser session retains only the opaque active deletion reference for reload navigation; server ownership and status remain authoritative.
- MCP & tools lists only entitled enabled installation definitions with active revisions. Each row separately presents persistent Enabled/Disabled, readiness, setup/OAuth actions, administrator-enabled tool names, declared personal fields, and a safe account/workspace label. Disabled names and the complete upstream inventory are administrator-only; endpoints, commands, packages, environment/header targets, OAuth client policy, grants, and secret values never render.
- Several servers may be enabled together. The UI warns that conversation-derived data may reach tools and rejects a known effective enabled-inventory total above the 128-tool run limit, while the server remains authoritative for schemas, bytes, freshness, and races. A ready server with every discovered tool disabled remains ready but contributes zero tools.
- Readiness refreshes on entry, mutation/OAuth return, and visibility-aware polling while work is transient. `queued`, `starting`, `idle`, and `restarting` are working states; `Needs setup`, authorization, and runtime failure remain distinct actionable facts.
- The composer exposes one aggregate Tools entry. Unsupported model capability takes precedence; otherwise it reports Not configured, Disabled, Activating, a concrete blocker, or Enabled with ready-tool count. Persistent per-server enablement is edited only in Settings.

### Assistants

- Assistants is the first Library tab and keeps its authenticated discovery,
  editing, version, and sharing owner. It is never a Settings subsection or a
  rounded modal. Browsing never applies an Assistant to the composer—only `Use`
  does, and `Use` returns to the blank workspace with the exact revision selected
  without creating a chat until send.
- The Assistants tab presents one calm avatar-prominent grid of the server-filtered entitled inventory rather than recreating separate application surfaces. Cards disclose only runner-safe name, description, revision, pinned/archived state, availability, and applicable actions. An unavailable item stays visible with a privacy-neutral reason and never reveals a hidden model, group, tool, or dependency name.
- Pinned Assistants are per-user server-stored preferences surfacing first in Assistants and the quick picker; pinning never changes access, publication, or the Assistant, and pin state never enters an accepted run checkpoint. Shared consumers get Use and Duplicate; duplication creates a private copy owned by the consumer. Owned cards additionally expose Edit, Version history, Duplicate, and Archive/Restore in an overflow menu.
- The identity-first editor owns avatar with browser-only `Generate another`, name, description (explicitly user-facing, never added to prompts), bounded category, system/developer instructions, model, run controls gated by the selected model's capabilities, the logical Search plan, an ordered exact allowlist of up to three Knowledge bases, the exact MCP server allowlist, up to four ordered starter prompts, and — in edit mode — Sharing. Missing or archived selected bases remain visible as retained/unavailable until explicitly removed. Save/create is the sole primary footer action; the header shows `Draft` before creation and `Revision N` afterward, and saving explains that existing runs keep the setup they used.
- Sharing pins exact revisions: any active user may publish an owned Assistant to groups with active membership, installation-wide publication is admin-curated, saving never advances a publication, `Publish update` moves it explicitly, and revoke neither archives the Assistant nor changes accepted runs. Version history is read-only with author, time, and changed sections; Restore creates a new revision from old content and never rewrites history.
- Loading, resource failure, no matches, and a true empty library are distinct. Editor validation attaches to its field with the stable server code; a CAS conflict reports that the Assistant changed in another session. Mutation failure preserves the list and dirty draft with readable retry/dismiss feedback.
- A dirty Assistant create/edit draft keeps its existing single in-product Back/Cancel/Escape confirmation and additionally enables the shared native `beforeunload` guard for reload, tab close, and document-level browser navigation. The guard remains through a pending or failed save and is removed only after a successful canonical save, explicit discard, or editor unmount; draft text is never copied to browser storage.

### Knowledge

- Knowledge is the second Library tab and projects the authenticated base list
  into the unified resource layout. Explicit Create/Open actions enter the
  existing focused base/document owner; owned bases retain lifecycle actions,
  while shared bases remain read-only and expose only server-projected identity
  and retrieval-safe metadata, never a private indexing deployment.
- Creating a base requires its name and one entitled indexing deployment. Before creation, the surface names the exact embedding connection/model and explains that document text leaves the chat-run boundary for indexing and will be sent again on reindex. Missing eligible deployment access is a blocked state, never an inferred fallback.
- Drag/drop and file selection share one multi-file upload owner. Document status is a server-authorized, newest-first page of 25 rows (server maximum 100), with exact matching count/page controls and case-insensitive filename-substring search; search does not inspect document content. Polling and post-mutation refresh retain the active query/page, while an out-of-range page is clamped by the server. Each row exposes its current file/version and the truthful queued, parsing, chunking, embedding, ready, or failed state; known totals render exact embedded/total chunk counts and no manufactured percentage. Retry addresses the failed current version, replacement creates a new current version, and removal closes current visibility while explicitly retaining immutable historical version identity and accepted-run checkpoints. Version history is metadata/status only; no document reader is implied.
- Base name/description drafts use optimistic-version/CAS save and dirty-exit confirmation. Background status refresh may advance ingestion and reindex projections but cannot overwrite a dirty base draft. Archive removes the base from active selection without deleting its documents or history; Restore reverses that lifecycle state.
- Reindex chooses only an entitled embedding deployment and repeats the egress disclosure. The UI reports shadow-generation state, exact completed/failed/total document counts, target content revision, and stable failure code; `ready` means the server is finalizing the generation switch until the active generation projection actually changes. A compatible shadow rebuild can reuse exact settled source chunks when the stored normalized object is unreadable; `reindex_source_unavailable` means neither that fenced source nor usable normalized text remained.
- Publication grants the selected group or installation live current-and-future access. Revoke stops future run admission while accepted runs retain frozen evidence. Current publications remain explicit and independently revocable; publishing does not grant hidden provider, model, Search, MCP, or private-base access beyond the server-authorized base projection.
- Initial load failure, mutation failure, no matches, and a true empty library remain distinct. Background refresh failure preserves the last useful projection; client decoders reject malformed projections before store mutation, stale requests cannot replace newer navigation/drafts, and readable stable error text never exposes a raw server message.
- Dirty Knowledge create and base-settings drafts follow the same split navigation ownership as Assistants: the existing focused shell confirmation owns internal Back/Cancel/Escape, while the shared conditional native `beforeunload` guard owns reload, tab close, and document-level browser navigation. Failed or pending saves remain guarded until the canonical base response makes the draft clean, and no draft content is browser-persisted.

### Files

- Files is the third Library tab. It presents owner-authorized uploads with
  their source chat/message relationship and truthful processing state. Files
  remain private and the tab does not imply an account-wide binary listing when
  the server has not projected one. Generated-file cards, immutable versions,
  preview, and lineage use deterministic fixtures only behind the generated
  artifacts development flag until their backend exists; production leaves
  that subsection absent or explicitly unavailable.

### Focus, appearance, and project settings

- Settings uses focus containment, Escape/backdrop close, opener restoration,
  and an inert shell. Library exits through Back to chat and keeps the covered
  chat shell inert without a scrim. Each captures the exact sidebar or palette
  invoker; if a responsive crossing hides it, exit uses the visible Open sidebar
  fallback and restores the remembered source when that composition returns.
  Nested confirmations own focus/Escape before returning to their surviving
  invoker.
- Appearance presents the stable registry System, Light, Dark as one calm
  divided comparison list at every width. Selection applies immediately.
- Appearance selection delegates to the browser-local theme owner in
  [frontend implementation state](../IMPLEMENTATION_STATE.md); Settings neither
  persists an account preference nor reconstructs first-paint/hydration state.
- Project settings owns `Project instructions` and the ordered project-default Knowledge plan, explains their next-run scope and override precedence, retains unavailable selections until explicit removal, and preserves modal focus, Escape, opener restoration, and dirty-confirmation behavior. The active chat's Knowledge picker separately owns saving or clearing its chat default.
