# FRONTEND IMPLEMENTATION STATE

Owner: Frontend state-ownership maintainers
Scope: Stable source ownership, browser/runtime state boundaries, store responsibilities, reconciliation, and deterministic frontend testability.

This document is a semantic ownership map, not a file inventory. Exact modules remain discoverable from source imports, focused tests, and generated inventories.

## Semantic Ownership Map

| Boundary | Stable owner | Responsibility |
| --- | --- | --- |
| Server entries | `app/` pages | Authenticate/authorize entry, normalize safe URL state, and pass least-data initial props into browser workspaces. |
| Shared wire contracts | `lib/contracts/` | Client-safe request/response types, runtime decoders, stable errors, and summary/detail boundaries. |
| Chat composition | `components/app-shell/PowerAppShell*` | Compose focused stores/controllers into the seven root view contracts; no server repository or leaf implementation ownership. |
| Workspace, thread, composer, run state | focused `components/app-shell/*Store` modules | Keyed durable projections, optimistic state, operation ownership, stream lifecycle, inspection, and next-run controls. |
| Shell actions/controllers | focused app-shell action and controller modules | Async mutation coordination, navigation/focus lifetimes, reconciliation, and semantic feature ports. |
| Conversation presentation | app-shell and `components/chat/` leaves | Thread rows, artifacts, receipts, Markdown, composer, Details, rails, menus, and dialogs. |
| Account and public share | `components/auth/` and `components/share/` | Mode-driven authentication and sanitized anonymous read-only rendering. |
| Reusable resource workspaces | `components/assistants/` and `components/knowledge/` plus focused app-shell stores/controllers | Full-screen Assistant and Knowledge list/detail workflows, decoded API projections, lifecycle mutations, and navigation-safe reconciliation. |
| Control Center | `components/admin/` | Administrator shell, resource controllers, index/detail tasks, write-only configuration UI, and decoded admin API clients. |
| Resource availability | `components/resource-lifecycle/` | Neutral shared Enabled/Disabled presentation and restoration-action tone across app and admin features. |
| Theme | app-shell theme owner plus root layout | Browser-local palette registry, cookie-backed first paint, and synchronized theme/color-scheme attributes. |

[Architecture](../ARCHITECTURE.md) owns and routes the executable dependency
rules. Inside the browser boundary, avoid broad utility barrels and catch-all
controllers: add behavior to the narrow semantic owner that already
coordinates it.

## Server And UI State Boundary

### Server data

Server-backed state includes:

- current user/session and the entitlement-filtered provider/model/Search catalog;
- the effective personal-or-installation model-default source, saved Search preferences, presentation toggles, and per-model run-control drafts;
- lightweight chat summaries, nested folders/projects, and project instructions;
- lazily loaded keyed thread snapshots with a bounded active-branch page, older-page state, full-branch usage/context facts, and safe artifacts; plus an explicit lazy compact branch-graph projection outside the thread store;
- Assistant summaries, details, revisions, publications, and per-user pins; Knowledge base summaries/details, document-version ingestion status, reindex progress, publication projections, and entitled embedding choices; plus current-user MCP catalog/readiness;
- persisted model-run inspection and usage evidence.

Exact response decoders run before store mutation. Workspace summaries contain no messages or usage graph, even if a future server response carries unknown fields. Thread data enters only the thread owner; run inspection enters only the run-surface owner.

### Browser-only state

Browser-local state includes:

- auth drafts and the bounded tab-scoped text-only re-authentication handoff;
- open menus, popovers, drawers, dialogs, confirmations, palette query/selection, Assistant/Knowledge surface navigation and dirty resource drafts, browser-local persistent wide Workspace-pane visibility under the legacy `aiqsa.workspaceRail` key, and focus restoration;
- keyed composer drafts, edit intent, staged attachments, async operation tokens, and local feedback;
- foreground text buffering and controller ownership;
- manual Details mode/tab, its current-chat compact branch projection, folder collapse, local notices, and theme choice.

Do not persist UI ephemera to the server or expand a global store merely because several leaves render it. Cross-component workflow sessions belong to a focused controller/store; hover, focus, and one-shot presentation state stays local.

## Store Ownership

### Workspace

`workspaceStore` owns the catalog, summary-only chats, folders, active chat ID, pending folder context, blank-workspace transitions, and workspace/detail loading/error/readiness. It patches list metadata without hydrating thread content. Initial catalog/workspace requests deduplicate and have explicit pending/error/ready ownership; later refresh failure preserves the last usable data.

Startup loads the filtered catalog before activating a remembered chat so chat defaults can win over startup defaults. Recovery reapplies chat defaults only if the active chat and next-run control fingerprint are unchanged, preventing stale closures from overwriting user edits.

### Threads and branches

`threadStore` owns each retained `ThreadSnapshot`: the bounded loaded active-path segment, active leaf, authoritative full-branch usage/context facts, older-page cursor/fence/generation/error state, visible partial-path derivation, and repair after checkout/edit/delete/regenerate. Prepend merges by message id without replacing newer optimistic/token state. Normal navigation retains the active snapshot plus at most two least-recently-used inactive snapshots; live streams, pending detail reads, and owned pending thread mutations are temporary safety exceptions. Safe eviction also removes the matching run-surface receipt cache while composer sessions remain under their separate owner. Chat deletion evicts only that chat.

Active-chat detail loading is a skeleton, not a blank chat. Detail failure has one in-thread Retry owner and disables the composer without creating a duplicate global notice. Returning to a current retained tail does not refetch it merely because navigation changed; reopening an evicted or snapshot-stale chat performs another bounded detail read. Older pages are fenced to the active leaf and authoritative revision, and stale settlement explicitly resets to the latest tail. Complete Copy/Export loops over remaining pages only in operation-local memory. Details owns the separately fetched compact branch graph for its current chat and never promotes it into rich message state.

### Composer sessions and controls

`composerSessionStore` owns keyed sessions for each saved chat plus distinct blank-root and blank-folder destinations. A session contains draft text, edit target, staged attachments, operation generations/tokens, and local feedback.

Async writers capture their source key and token before awaiting. Send snapshots and clears visible input atomically; upload and send exclude each other; attachment status polling updates only a still-present id in its captured source and keeps send blocked through `processing`/`failed`; a failed send restores captured text only if no newer composer work exists. A successful first send transfers the blank session to the created chat. Deletion/authoritative refresh removes stale sources so late results cannot resurrect them.

`composerControlStore` separately owns next-run provider/model/Search state,
visibility toggles, per-model control drafts, selected Assistant identity, and
the preserved ordinary-draft backup. Each mutation carries a user, system, or
Assistant origin so one atomic state transition can retain, clear, or restore
the correct draft without overwriting saved defaults. [Run controls](composer/RUN_CONTROLS.md)
owns the visible selection/removal behavior and notices. Prompt text is not
browser state: runs receive only the server-resolved ordinary or Assistant
prompt owner.

### Run lifecycle and inspection

`runLifecycleStore` owns active stream/controller records keyed by source chat, run IDs, optimistic assistant IDs, cancellation, and resume ownership. The active view selects only its active chat key; a late background event cannot steal selection.

`runSurfaceStore` owns the selected/live compacted event timeline and decoded `lastRun` per saved chat plus an exact `runId`-keyed persisted-run receipt cache for that chat. The lifecycle fetch may replace `lastRun` and Events only while its source surface fence still owns selection; the message-receipt loader updates only the exact cache entry and never selects Details or replaces live events. Every writer captures a non-null source chat before asynchronous work. New send/regenerate resets only that source; navigation is read-only selection; deletion evicts only the deleted key.

Send and regenerate keep their distinct optimistic preparation but share one lifecycle executor for HTTP/SSE work, persisted-ID adoption, source reconciliation, terminal notification, failure/cancellation, and controller-safe cleanup. A rejected request rolls back only its optimistic rows. An ambiguous accepted/network failure performs a source-keyed durable refresh before retry.

A failed assistant retry delegates to the existing regenerate lifecycle owner
with no second retry store, deletion path, or draft mutation; [Composer](composer/COMPOSER.md)
owns the visible action and branch outcome.

Foreground token deltas are buffered for React updates and adjacent event aggregation. Historical rows, Markdown/artifacts, and workspace summaries do not repaint for token-only changes. Malformed SSE frames are skipped, later frames continue, and one readable warning appears in the UI/Details.

### Assistants, Knowledge, Settings, and MCP workflows

`settingsDestinationStore` owns the bounded Settings destination (Appearance, Memory, MCP & tools). `memorySettingsStore` owns the strictly decoded account settings/capability/egress projection, coalesced load, one exact CAS mutation, and stale-state reconciliation. `memoryManagerStore` separately owns the explicit `GLOBAL_USER` list/search cursor, selected detail/evidence, exact draft, stale-draft fence, mutation state, and opaque durable-deletion reference/status. Its client controller mints a fresh exact-action authorization immediately before every create/edit/pin/Forget/delete request, refreshes destructive settings/Memory CAS at confirmation, keeps search text in POST bodies, and cannot let background detail/evidence or status work replace a newer task. Settings remains the sole scroll and dirty-exit owner around both stores.

`memoryHistorySearchStore` separately owns the manual retained-history draft,
exact applied request, opaque cursor, safe result projection, lexical/vector
state, abort controller lineage, and cancelled/error/empty/loading states. Its
private cache is bound to the server session's exact account id; a different
owner or shell unmount aborts and clears it before any late response can apply.
Closing the nested task preserves only same-owner state. Source navigation
resolves the current owner-private live/archive destination before Settings is
dismissed, then delegates archived results to the existing read-only archive
owner instead of activating an operational chat.

`memoryOperationsStore` owns the account-bound history-operation confirmation,
admission/cancellation mutation, and separate clear/rebuild status projections.
It reloads current Memory/settings CAS immediately before admission, keeps a
stale confirmation recoverable, and stores only account-keyed opaque deletion
or rebuild ids in tab-scoped storage so authoritative server status can be
restored after reload. Polls and late admission/status responses are fenced to
the exact account generation. Clear admission and successful generation
replacement invalidate only derived manual-history results; neither path
persists private query or source text.

The Assistants surface owns its own focused state: `assistantLibraryStore` holds the open full-screen task (list, editor, history), Discover/Yours mode, filter/category/query, fetched list data, and editor/history drafts, while `assistantLibraryController` owns every surface mutation (create, revise with CAS, archive/restore, duplicate, publish/revoke, pin, restore-as-new-revision) and `Use` application into the composer owner. Editor avatar generation happens exactly once per new draft plus once per explicit `Generate another`, entirely in the browser. Current-composer Assistant selection remains with composer controls; the surface never mutates next-run state except through the atomic apply/remove actions.

Knowledge follows the same focused-owner boundary without sharing Assistant or composer state. `knowledgeLibraryStore` owns its open list/create/detail task, list filter/query, active document query/page, decoded list/detail/ingestion projections, dirty drafts, action identity, and bounded notice; `knowledgeLibraryController` owns loading, server-paged filename search, CAS save, sequential multi-file upload, retry/replace/remove, archive/restore, reindex, publish/revoke, and stale-response fencing. Lifecycle polling refreshes only transient work on the active document query/page, preserves the last useful projection on background failure, and cannot replace a dirty base draft. The Knowledge management surface does not select next-run retrieval; composer binding and persisted run evidence remain with their dedicated run task and owners.

MCP settings owns its coalesced catalog refresh, mutation replacement, OAuth outcome, readiness polling, and last ready/error presentation. Personal input values remain leaf-local and write-only. Background reads do not flash an empty catalog over last-known useful state.

General-shell and Settings notices are separate channels. Closing Settings clears only Settings feedback. Persistent workflow notices remain in flow; transient notices stay bounded and dismissible.

## PowerAppShell Boundary

`PowerAppShell` composes stores, hooks, refs, effects, controllers, and view adapters. It does not own server data, branch logic, next-run state, or leaf drafts.

Its root view contract has exactly seven keys:

- `session`;
- `workspace`;
- `thread`;
- `composer`;
- `details`;
- `settings`;
- `overlays`.

Compile-time coverage and component tests enforce this boundary. Root and left-pane adapters receive grouped semantic actions rather than raw `set*` bags. Leaf adapters receive only their selected feature projection. If a future slice needs shared state, integrate with the focused owner rather than adding a second producer or broad root reducer.

The memoized left-pane adapter intentionally ignores callback identity churn and calls a stable event callback that always reaches the latest catalog-aware activation handler. Remove its custom comparator only after replacing that contract with direct selectors or fully stable callbacks.

## Presentation And Runtime Contracts

### Run truth and thread behavior

Run presentation selectors consume only normalized lifecycle/event evidence and
never synthesize provider stages or open inspection. Thread-scroll ownership is
source-keyed: deliberate work in the active chat may establish one anchor,
while passive or background updates cannot move another reader. Context
selectors expose only backend-projected estimates and provider usage. Exact
labels, assistant-tail states, anchor geometry, latest-message eligibility, and
context disclosure belong to [Messages](MESSAGES_AND_MARKDOWN.md),
[Composer](composer/COMPOSER.md), [Run controls](composer/RUN_CONTROLS.md), and
[Receipt and Details](composer/RECEIPT_AND_DETAILS.md).

### Shell and session ownership

- Shell adapters project the action destinations and availability owned by
  [product and layout](PRODUCT_AND_LAYOUT.md). `WorkspaceIconRail` is the compact
  labeled desktop presentation owner for those existing global destinations; it does
  not create a second navigation, Account, conversation-action, or Details
  state owner.
- Initial bootstrap has one actionable Retry surface and disables dependent mutations. Blank-chat and zero-model states render only after readiness and distinguish an empty workspace from missing granted access. The zero-model projection also distinguishes admin authority: only an administrator receives the direct Control Center provider-setup action.
- Above the compact shell threshold, the labeled rail is mandatory and wide
  Workspace-pane visibility is one browser-local presentation preference.
  Hiding closes pane-owned menus and focuses rail `Chats`; Chats or a pointer
  click on non-control rail space restores and focuses the pane's hide action.
  Desktop Account has one top-group rail trigger and one externally anchored
  surface; only the compact drawer retains its own Account footer presentation.
  At compact widths `Open workspace` continues to own the modal drawer, and no
  chat/folder/account state migrates into this preference.
- A persisted chat with no provider/model default is valid. Blank startup and every ordinary New-chat transition re-resolve only the catalog's exact effective personal-or-installation default; when that projection is absent, the shell keeps model selection empty instead of substituting the first visible model. An active Assistant keeps its revision-owned selection across a blank transition. Existing-chat activation preserves its independent saved tuple and established non-persisting visible fallback when that tuple is absent or unavailable. Legacy paired empty-string defaults remain readable during compatibility; half-populated pairs fail closed.
- Any Chat `401` creates one sticky session-expiry transition. Concurrent failures navigate once, store only the active text draft in tab-scoped owner-bound state, and restore it after the same account reauthenticates only into an untouched matching destination. The handoff expires after 30 minutes and never includes attachments.
- Sign-out failure remains visibly attributable to Account and retryable. Answer completion may use the local audio/favicon alert; hidden-tab signaling stops when the user returns.

### Theme and focus

Theme preference is local, and the palette registry preserves every supported stored theme id. A valid LocalStorage value wins after hydration and repairs the same-site cookie; invalid local state yields to the validated server-rendered theme. First paint and runtime changes set `data-theme` and `data-color-scheme` together. Theme never becomes user/account/conversation data.

Dialog focus is session-scoped: entry, Tab containment, Escape ownership, nested confirmation priority, and opener restoration belong to the focused overlay owner. A responsive transition replaces a CSS-hidden desktop-navigation opener with compact `Open workspace`, remembers its exact source, and restores that source on desktop return only while the fallback still owns focus. A drawer becoming a pinned panel releases modal behavior without prematurely restoring focus.

## Testability Rules

- Prefer clear visible labels and stable `data-testid` anchors only for critical behavior.
- Keep every state understandable with nonessential motion disabled and deterministic fake data/providers.
- Test store/action owners directly for source-key capture, race settlement, malformed payload rejection, and cache isolation.
- Use focused browser behavior and affected desktop/mobile states for material interaction or visual changes; do not maintain exhaustive screenshot inventories.
- Select proportional checks through `TESTING.md`.

## Change Rules

- Update this document only when semantic ownership, store boundaries, async reconciliation, or frontend testability changes.
- Do not add file-by-file inventories, refactor chronology, or exhaustive leaf prop descriptions; source and focused tests own those facts.
- Visual styling belongs to the bounded owners routed by `DESIGN_SYSTEM.md`; durable user interaction belongs to the appropriate functional frontend owner.
