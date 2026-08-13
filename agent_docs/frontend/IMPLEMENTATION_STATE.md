# FRONTEND IMPLEMENTATION STATE

Owner: Frontend state-ownership maintainers
Scope: Stable source ownership, browser/runtime state boundaries, store responsibilities, reconciliation, and deterministic frontend testability.

This document is a semantic ownership map, not a file inventory. Exact modules remain discoverable from source imports, focused tests, and generated inventories.

## Semantic Ownership Map

| Boundary | Stable owner | Responsibility |
| --- | --- | --- |
| Server entries | `app/` pages | Authenticate/authorize entry, normalize safe URL state, and pass least-data initial props into browser workspaces. |
| Shared wire contracts | `lib/contracts/` | Client-safe request/response types, runtime decoders, stable errors, and summary/detail boundaries. |
| Chat composition | `features/workspace-v2/PowerAppShellV2*` | Compose focused stores/controllers into the seven root view contracts and the sole production presentation; no server repository or leaf implementation ownership. |
| Workspace, thread, composer, run state | focused `components/app-shell/*Store` modules | Keyed durable projections, optimistic state, operation ownership, stream lifecycle, inspection, and next-run controls. |
| Shell actions/controllers | focused app-shell action and controller modules | Async mutation coordination, navigation/focus lifetimes, reconciliation, and semantic feature ports. |
| Conversation presentation | `features/*-v2/`, `components/ui-v2/`, and reviewed Markdown/resource leaves | Navigation, turns, evidence, composer, Branches, Run details, Library, Settings, menus, drawers, and dialogs. |
| Account and public share | `components/auth/` and `components/share/` | Mode-driven authentication and sanitized anonymous read-only rendering. |
| Resource workspaces | Memory app-shell components, `components/assistants/`, and `components/knowledge/` plus focused stores/controllers | Full-screen Memory, Assistant, and Knowledge workflows, decoded API projections, lifecycle mutations, and navigation-safe reconciliation. |
| Control Center | `components/admin/` | Administrator shell, resource controllers, index/detail tasks, write-only configuration UI, and decoded admin API clients. |
| Resource availability | `components/resource-lifecycle/` | Neutral shared Enabled/Disabled presentation and restoration-action tone across app and admin features. |
| Theme | `styles/tokens-v2.css`, app-shell theme owner, and root layout | Browser-local three-value registry, cookie-backed first paint, and synchronized theme/color-scheme attributes. |

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
- Memory settings, capability/health, summary, exact facts, history-search and operation projections; Assistant summaries, details, revisions, publications, and per-user pins; Knowledge base summaries/details, document-version ingestion status, reindex progress, publication projections, and entitled embedding choices; plus current-user MCP catalog/readiness;
- persisted model-run inspection and usage evidence.

Exact response decoders run before store mutation. Workspace summaries contain no messages or usage graph, even if a future server response carries unknown fields. Thread data enters only the thread owner; run inspection enters only the run-surface owner.

### Browser-only state

Browser-local state includes:

- auth drafts and the bounded tab-scoped text-only re-authentication handoff;
- open menus, popovers, drawers, dialogs, confirmations, palette query/selection, Memory/Assistant/Knowledge surface navigation and dirty resource drafts, browser-local persistent wide Workspace-pane visibility under the legacy `aiqsa.workspaceRail` key, and focus restoration;
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

`composerSessionStore` owns keyed sessions for each saved chat plus distinct
blank-root and blank-folder destinations for `NORMAL`, `EXCLUDED`, and
`TEMPORARY` intent. A first send may transfer only its exact source session;
Memory-off creation persists `EXCLUDED` with the new chat, while Temporary
continues through its separately acknowledged first-run admission. A session
contains draft text, edit target, staged attachments, operation
generations/tokens, and local feedback.

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

### Memory, Assistants, Knowledge, Settings, and MCP workflows

`settingsDestinationStore` owns mutually exclusive Memory and bounded Settings
destinations; Settings contains Appearance and MCP & tools, while Memory opens
the full-screen workspace. `memorySettingsStore` owns the strictly decoded account
settings/capability/egress projection, coalesced load, one exact CAS mutation,
and stale-state reconciliation. `memoryHealthStore` separately owns the
private/no-store user-health pulse: activation clears a different account,
aborts the prior request, generation-fences late settlement, preserves
same-owner last-good data on refresh failure, and clears on unmount/logout.
`memoryManagerStore` separately owns the explicit `GLOBAL_USER` list/search
cursor, the account-fenced exact-contributor profile projection, selected
detail/evidence, exact draft, stale-draft fence, mutation state, and opaque
durable-deletion reference/status. Its client controller mints a fresh
exact-action authorization immediately before every create/edit/pin/Forget/delete
request, refreshes profile/list projections after exact contributor mutations,
refreshes destructive settings/Memory CAS at confirmation, keeps search text
in POST bodies, and cannot let background profile/detail/evidence or status
work replace a newer account or task. The Memory workspace remains the sole
scroll and dirty-exit owner around these stores and renders fixed English UI
over the retained compatibility locale without changing multilingual data.

`memoryHistorySearchStore` separately owns the manual retained-history draft,
exact applied request, opaque cursor, safe result projection, lexical/vector
state, abort controller lineage, and cancelled/error/empty/loading states. Its
private cache is bound to the server session's exact account id; a different
owner or shell unmount aborts and clears it before any late response can apply.
Closing the nested task preserves only same-owner state. Source navigation
resolves the current owner-private live/archive destination before Memory is
dismissed, then delegates archived results to the existing read-only archive
owner instead of activating an operational chat.

`memoryOperationsStore` owns the account-bound Memory-operation confirmation,
admission/cancellation mutation, and separate all-reusable, learned, clear, and
rebuild status projections. It reloads current Memory/settings CAS immediately
before admission, keeps a stale confirmation recoverable, and stores only
account-keyed opaque deletion or rebuild ids in tab-scoped storage so
authoritative server status can be restored after reload. Polls and late
admission/status responses are fenced to the exact account generation. Clear
admission and successful generation replacement invalidate only derived
manual-history results. Global reusable deletion additionally invalidates
saved-memory list/detail/profile projections at admission and audited success;
no path persists private query or source text.

`permanentChatDeletionStore` separately owns the capability-gated retained-chat
confirmation and cleanup status. It binds every request and late response to the
exact account generation, rereads the current owner-private title, location,
source revision, and active leaf immediately before minting a single-use
authorization, and requires a second deliberate confirmation if any of those
facts changed. The optional origin-memory Forget choice defaults false and is
bound through authorization and admission. Admission evicts the source from
workspace, thread, run, composer, share, and Archived owners immediately; a
tab-scoped account-keyed record persists only opaque chat/deletion ids so status
can resume after reload. The default status notice remains concise, while
cleanup ids, attempts, fences, audits, and bounded errors stay behind the
explicit advanced disclosure.

The Assistants surface owns its own focused state: `assistantLibraryStore` holds the open full-screen task (list, editor, history), Discover/Yours mode, filter/category/query, fetched list data, and editor/history drafts, while `assistantLibraryController` owns every surface mutation (create, revise with CAS, archive/restore, duplicate, publish/revoke, pin, restore-as-new-revision) and `Use` application into the composer owner. Editor avatar generation happens exactly once per new draft plus once per explicit `Generate another`, entirely in the browser. Current-composer Assistant selection remains with composer controls; the surface never mutates next-run state except through the atomic apply/remove actions.

Knowledge follows the same focused-owner boundary without sharing Assistant or composer state. `knowledgeLibraryStore` owns its open list/create/detail task, list filter/query, active document query/page, decoded list/detail/ingestion projections, dirty drafts, action identity, and bounded notice; `knowledgeLibraryController` owns loading, server-paged filename search, CAS save, sequential multi-file upload, retry/replace/remove, archive/restore, reindex, publish/revoke, and stale-response fencing. Lifecycle polling refreshes only transient work on the active document query/page, preserves the last useful projection on background failure, and cannot replace a dirty base draft. The Knowledge management surface does not select next-run retrieval; composer binding and persisted run evidence remain with their dedicated run task and owners.

MCP settings owns its coalesced catalog refresh, mutation replacement, OAuth outcome, readiness polling, and last ready/error presentation. Personal input values remain leaf-local and write-only. Background reads do not flash an empty catalog over last-known useful state.

General-shell and settings-destination notices are separate channels. Settings and Memory render that destination channel and clear it on exit. Persistent workflow notices remain in flow; transient notices stay bounded and dismissible.

## PowerAppShellV2 Boundary

`PowerAppShellV2` composes stores, hooks, refs, effects, controllers, and v2 view adapters. It does not own server data, branch logic, next-run state, or leaf drafts. There is no selectable classic renderer, parallel API client, or second state graph.

Its root view contract has exactly seven keys:

- `session`;
- `workspace`;
- `thread`;
- `composer`;
- `details`;
- `settings`;
- `overlays`.

Compile-time coverage and component tests enforce this boundary. Root and navigation adapters receive grouped semantic actions rather than raw `set*` bags. Leaf adapters receive only their selected feature projection. If a future slice needs shared state, integrate with the focused owner rather than adding a second producer or broad root reducer.

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

Generated-artifact cards and their preview/lineage drawer currently have a
typed deterministic presentation owner only. That owner is reachable solely
from the explicit non-production fixture route; its server-side release gate
fails closed in production and the ordinary shell has no import or state path
to it. A future product release must substitute an authenticated, owner-fenced
projection without weakening exact message/branch/version binding. Until that
backend boundary exists, the UI must not expose synthetic downloads, storage
references, or generated-file success on a real run.

### Shell and session ownership

- Shell adapters project the action destinations and availability owned by
  [product and layout](PRODUCT_AND_LAYOUT.md). `NavigationSidebar` is the one
  chat/folder navigation presentation: normal-flow at desktop widths, fully
  collapsed when requested, and a scrim-backed drawer below 900px. Collapse
  leaves adjacent Open/New-chat recovery controls, never an icon rail or a
  second navigation state owner. Account actions live in the workspace header;
  Library and Settings also remain reachable from the sidebar.
- Initial bootstrap has one actionable Retry surface and disables dependent mutations. Blank-chat and zero-model states render only after readiness and distinguish an empty workspace from missing granted access. The zero-model projection also distinguishes admin authority: only an administrator receives the direct Control Center provider-setup action.
- At `>=1024px` the sidebar starts open; at `900–1023px` it starts collapsed;
  below `900px` the same content becomes a modal drawer. Responsive transitions
  preserve the active chat, search, folders, drafts, and operation ownership.
  When hiding focused navigation, focus moves to the exact visible Open control
  and restores only while that fallback still owns focus.
- A persisted chat with no provider/model default is valid. Blank startup and every ordinary New-chat transition re-resolve only the catalog's exact effective personal-or-installation default; when that projection is absent, the shell keeps model selection empty instead of substituting the first visible model. An active Assistant keeps its revision-owned selection across a blank transition. Existing-chat activation preserves its independent saved tuple and established non-persisting visible fallback when that tuple is absent or unavailable. Legacy paired empty-string defaults remain readable during compatibility; half-populated pairs fail closed.
- Any Chat `401` creates one sticky session-expiry transition. Concurrent failures navigate once, store only the active text draft in tab-scoped owner-bound state, and restore it after the same account reauthenticates only into an untouched matching destination. The handoff expires after 30 minutes and never includes attachments.
- Sign-out failure remains visibly attributable to Account and retryable. Answer completion may use the local audio/favicon alert; hidden-tab signaling stops when the user returns.

### Theme and focus

Theme preference is local and exposes only System, Light, and Dark. A
recognized LocalStorage value wins after hydration and repairs the same-site
cookie; the one-time compatibility normalizer maps the six shipped legacy ids
to Dark or Light and maps unknown/absent state to System. Cookie-backed
normalized state owns first paint. Runtime changes set `data-theme` and the
effective `data-color-scheme` together, including operating-system changes
while System is selected. Theme never becomes user/account/conversation data.

Dialog focus is session-scoped: entry, Tab containment, Escape ownership, nested confirmation priority, and opener restoration belong to the focused overlay owner. Branches, Run details, artifact preview, Settings, and command search remain temporary layers; no responsive transition converts them into a pinned column.

## Testability Rules

- Prefer clear visible labels and stable `data-testid` anchors only for critical behavior.
- Keep every state understandable with nonessential motion disabled and deterministic fake data/providers.
- Test store/action owners directly for source-key capture, race settlement, malformed payload rejection, and cache isolation.
- Use focused browser behavior and affected desktop/mobile states for material interaction or visual changes. The guarded v2 fixture is the bounded exception: its named dark/light state matrix and responsive baselines are maintained under `tests/e2e/ui-baseline/` as routed by `TESTING.md`.
- Select proportional checks through `TESTING.md`.

## Change Rules

- Update this document only when semantic ownership, store boundaries, async reconciliation, or frontend testability changes.
- Do not add file-by-file inventories, refactor chronology, or exhaustive leaf prop descriptions; source and focused tests own those facts.
- Visual styling belongs to the bounded owners routed by `DESIGN_SYSTEM.md`; durable user interaction belongs to the appropriate functional frontend owner.
