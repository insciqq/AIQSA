# FRONTEND IMPLEMENTATION STATE

Owner: Frontend state-ownership maintainers
Scope: Stable source ownership, browser/runtime state boundaries, store responsibilities, reconciliation, and deterministic frontend testability.

This document is a semantic ownership map, not a file inventory. Exact modules remain discoverable from source imports, focused tests, and generated inventories.

## Semantic Ownership Map

| Boundary | Stable owner | Responsibility |
| --- | --- | --- |
| Server entries | `app/` pages | Authenticate/authorize entry, normalize safe URL state, and pass least-data initial props into browser workspaces. |
| Shared wire contracts | `lib/contracts/` | Client-safe request/response types, runtime decoders, stable errors, and summary/detail boundaries. |
| Research Chat composition | `components/app-shell/PowerAppShell*` | Compose focused stores/controllers into the seven root view contracts; no server repository or leaf implementation ownership. |
| Workspace, thread, composer, run state | focused `components/app-shell/*Store` modules | Keyed durable projections, optimistic state, operation ownership, stream lifecycle, inspection, and next-run controls. |
| Shell actions/controllers | focused app-shell action and controller modules | Async mutation coordination, navigation/focus lifetimes, reconciliation, and semantic feature ports. |
| Conversation presentation | app-shell and `components/chat/` leaves | Thread rows, artifacts, receipts, Markdown, composer, Details, rails, menus, and dialogs. |
| Account and public share | `components/auth/` and `components/share/` | Mode-driven authentication and sanitized anonymous read-only rendering. |
| Control Center | `components/admin/` | Administrator shell, resource controllers, index/detail tasks, write-only configuration UI, and decoded admin API clients. |
| Resource availability | `components/resource-lifecycle/` | Neutral shared Enabled/Disabled presentation and restoration-action tone across app and admin features. |
| Theme | app-shell theme owner plus root layout | Browser-local palette registry, cookie-backed first paint, and synchronized theme/color-scheme attributes. |

Dependency direction is enforced by `eslint.config.mjs` and harness tests. Browser components do not import server/Prisma/Node-only owners; shared contracts do not depend on consumers; the app shell does not depend on Control Center internals. Avoid broad utility barrels and catch-all controllers: add behavior to the narrow semantic owner that already coordinates it.

## Server And UI State Boundary

### Server data

Server-backed state includes:

- current user/session and the entitlement-filtered provider/model/Search catalog;
- saved provider/model/Search/prompt defaults, presentation toggles, and per-model run-control drafts;
- lightweight chat summaries, nested folders/projects, and project instructions;
- lazily loaded keyed thread snapshots with messages, branch state, usage, and safe artifacts;
- prompt presets and current-user MCP catalog/readiness;
- persisted model-run inspection and usage evidence.

Exact response decoders run before store mutation. Workspace summaries contain no messages or usage graph, even if a future server response carries unknown fields. Thread data enters only the thread owner; run inspection enters only the run-surface owner.

### Browser-only state

Browser-local state includes:

- auth drafts and the bounded tab-scoped text-only re-authentication handoff;
- open menus, popovers, drawers, dialogs, confirmations, palette query/selection, and focus restoration;
- keyed composer drafts, edit intent, staged attachments, async operation tokens, and local feedback;
- foreground text buffering and controller ownership;
- manual Details mode/tab, folder collapse, local notices, and theme choice.

Do not persist UI ephemera to the server or expand a global store merely because several leaves render it. Cross-component workflow sessions belong to a focused controller/store; hover, focus, and one-shot presentation state stays local.

## Store Ownership

### Workspace

`workspaceStore` owns the catalog, summary-only chats, folders, active chat ID, pending folder context, blank-workspace transitions, and workspace/detail loading/error/readiness. It patches list metadata without hydrating thread content. Initial catalog/workspace requests deduplicate and have explicit pending/error/ready ownership; later refresh failure preserves the last usable data.

Startup loads the filtered catalog before activating a remembered chat so chat defaults can win over startup defaults. Recovery reapplies chat defaults only if the active chat and next-run control fingerprint are unchanged, preventing stale closures from overwriting user edits.

### Threads and branches

`threadStore` owns one `ThreadSnapshot` per saved chat: messages, active leaf, usage, visible branch derivation, and repair after checkout/edit/delete/regenerate. Cached inactive threads survive navigation and blank-workspace transitions. Chat deletion evicts only that chat; stale detail responses merge without replacing newer optimistic/token state or summary metadata.

Active-chat detail loading is a skeleton, not a blank chat. Detail failure has one in-thread Retry owner and disables the composer without creating a duplicate global notice. Returning to a complete cached chat does not refetch it merely because navigation changed.

### Composer sessions and controls

`composerSessionStore` owns keyed sessions for each saved chat plus distinct blank-root and blank-folder destinations. A session contains draft text, edit target, staged attachments, operation generations/tokens, and local feedback.

Async writers capture their source key and token before awaiting. Send snapshots and clears visible input atomically; upload and send exclude each other; a failed send restores captured text only if no newer composer work exists. A successful first send transfers the blank session to the created chat. Deletion/authoritative refresh removes stale sources so late results cannot resurrect them.

`composerControlStore` separately owns next-run provider/model/Search/prompt, prompt text, visibility toggles, and per-model control drafts. Provider changes only as part of a selected concrete model. Model/profile selection writes one complete control tuple; profile identity is derived rather than persisted. Prompt browsing/default selection never mutates the next-run choice.

### Run lifecycle and inspection

`runLifecycleStore` owns active stream/controller records keyed by source chat, run IDs, optimistic assistant IDs, cancellation, and resume ownership. The active view selects only its active chat key; a late background event cannot steal selection.

`runSurfaceStore` owns the latest compacted event timeline and decoded persisted run per saved chat. Every writer captures a non-null source chat before asynchronous work. New send/regenerate resets only that source; navigation is read-only selection; deletion evicts only the deleted key.

Send and regenerate keep their distinct optimistic preparation but share one lifecycle executor for HTTP/SSE work, persisted-ID adoption, source reconciliation, terminal notification, failure/cancellation, and controller-safe cleanup. A rejected request rolls back only its optimistic rows. An ambiguous accepted/network failure performs a source-keyed durable refresh before retry.

Foreground token deltas are buffered for React updates and adjacent event aggregation. Historical rows, Markdown/artifacts, and workspace summaries do not repaint for token-only changes. Malformed SSE frames are skipped, later frames continue, and one readable warning appears in the UI/Details.

### Prompt, Settings, and MCP workflows

The prompt/settings owner tracks the active Settings-or-Prompt-library destination, editor draft, saving/deletion state, and dirty protection. Prompt mutations own catalog changes and default movement; current-composer selection remains with composer controls.

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

- Run activity renders consumed evidence only: `Working…` before a known stage, `Searching…` after search/citation evidence, `Answering…` after answer tokens, and a readable error after failure. It never invents provider stages or auto-opens Details.
- Queued, live, cancelled, failed, complete-without-text, and ordinary complete assistant tails remain distinguishable. Search selected-off versus backend-skipped stays inspectable in durable run evidence rather than a fabricated live step.
- Explicit Send in the still-active source chat reclaims scroll ownership after optimistic rows appear. Passive updates never move an unpinned reader. A streaming turn anchors at the newest question with bounded preceding context and does not chase every token to the tail.
- `Jump to latest message` appears only when real message content extends beyond the viewport threshold; receipt/action spacers do not trigger it. Activation or deliberate return to bottom resumes tail following.
- Composer context shows approximate current input against the safe input budget, names full model context separately, and shows provider-reported branch usage. It does not estimate currency cost.

### Shell and session ownership

- The conversation edge rail owns Workspace, compact New chat, truthful Pipeline activity, Share, state-aware Details, and Conversation actions. The fixed Workspace footer owns the only visible Account trigger plus Command palette, Prompt library, Settings, Sign out, and entitled Admin.
- Initial bootstrap has one actionable Retry surface and disables dependent mutations. Blank-chat and zero-model states render only after readiness and distinguish an empty workspace from missing granted access.
- A persisted chat with no provider/model default is valid. The shell may show a visible catalog fallback without persisting it. Legacy paired empty-string defaults remain readable during compatibility; half-populated pairs fail closed.
- Any Research Chat `401` creates one sticky session-expiry transition. Concurrent failures navigate once, store only the active text draft in tab-scoped owner-bound state, and restore it after the same account reauthenticates only into an untouched matching destination. The handoff expires after 30 minutes and never includes attachments.
- Sign-out failure remains visibly attributable to Account and retryable. Answer completion may use the local audio/favicon alert; hidden-tab signaling stops when the user returns.

### Theme and focus

Theme preference is local, and the palette registry preserves every supported stored theme id. A valid LocalStorage value wins after hydration and repairs the same-site cookie; invalid local state yields to the validated server-rendered theme. First paint and runtime changes set `data-theme` and `data-color-scheme` together. Theme never becomes user/account/conversation data.

Dialog focus is session-scoped: entry, Tab containment, Escape ownership, nested confirmation priority, and opener restoration belong to the focused overlay owner. A drawer becoming a pinned panel releases modal behavior without prematurely restoring focus.

## Testability Rules

- Prefer clear visible labels and stable `data-testid` anchors only for critical behavior.
- Keep every state understandable with nonessential motion disabled and deterministic fake data/providers.
- Test store/action owners directly for source-key capture, race settlement, malformed payload rejection, and cache isolation.
- Use focused browser behavior and affected desktop/mobile states for material interaction or visual changes; do not maintain exhaustive screenshot inventories.
- Select proportional checks through `TESTING.md`.

## Change Rules

- Update this document only when semantic ownership, store boundaries, async reconciliation, or frontend testability changes.
- Do not add file-by-file inventories, refactor chronology, or exhaustive leaf prop descriptions; source and focused tests own those facts.
- Visual styling belongs to `DESIGN_SYSTEM.md`; durable user interaction belongs to the appropriate functional frontend owner.
